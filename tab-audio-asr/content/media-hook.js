/**
 * media-hook.js —— 在**主世界**挂钩播放器的请求，抓住当前视频的真实音轨地址
 *
 * 为什么需要：B 站这类单页应用，`window.__playinfo__` 是首屏服务端渲染写下的，
 * 换视频时**不会更新**——所以按它提取，永远拿到第一个视频的音频（真机踩过）。
 * 真正更新的地方是播放器每次换集时发的那次 playurl 请求（XHR/fetch）。
 *
 * 这个脚本只做两件事，都很轻：
 *   1. 包住 fetch / XMLHttpRequest，看响应里有没有 DASH 音轨结构；
 *   2. 把找到的地址记在 `window.__dshAsrMedia` 上，并带上**当时的页面地址**，
 *      供探测时判断"这份信息是不是当前这一页的"。
 *
 * 它不修改页面行为、不发请求、不影响播放：只做旁路观察。
 * 由扩展在打开弹窗时注入（activeTab 授权），所以不需要"读取所有网站"的宽泛权限。
 */
(() => {
  if (window.__dshAsrHookInstalled) return;
  window.__dshAsrHookInstalled = true;

  const MAX_SNIPPET = 4 * 1024 * 1024; // 只看 4MB 以内的响应
  const KEY = '__dshAsrMedia';

  /** 从一个 JSON 对象里挖出音轨/整段地址（兼容多种命名） */
  function extract(obj) {
    if (!obj || typeof obj !== 'object') return null;

    const urlOf = (x) =>
      (x && (x.baseUrl || x.base_url || x.url || (Array.isArray(x.backupUrl) ? x.backupUrl[0] : ''))) || '';

    // 常见形态：{ data: { dash: { audio: [...] } } } / { dash: { audio } } / { audio: [...] }
    const roots = [obj, obj.data, obj.result, obj.playinfo, obj.data?.playinfo].filter(Boolean);
    for (const root of roots) {
      const dash = root.dash || root.Dash;
      if (dash && Array.isArray(dash.audio) && dash.audio.length) {
        const list = dash.audio.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        const audio = urlOf(list[0]);
        if (audio) {
          const videoList = Array.isArray(dash.video)
            ? dash.video.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
            : [];
          return { audio, video: urlOf(videoList[0]), duration: root.timelength ? Math.round(root.timelength / 1000) : null };
        }
      }

      if (Array.isArray(root.durl) && root.durl[0]) {
        const u = urlOf(root.durl[0]) || root.durl[0].url || '';
        if (u) return { audio: u, video: u, duration: null };
      }
    }
    return null;
  }

  function remember(info, source) {
    if (!info?.audio) return;
    const prev = window[KEY];
    // 同一地址不用反复记
    if (prev && prev.audio === info.audio) return;
    window[KEY] = {
      audio: info.audio,
      video: info.video || '',
      duration: info.duration || null,
      href: location.href, // 记下"这份信息属于哪个页面"，用于判断过期
      source,
      at: Date.now()
    };
  }

  /* ---------------- 包 fetch ---------------- */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = String(typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
        if (/playurl|playinfo|player\/wbi|mediainfo/i.test(url) || url.includes('/x/player/')) {
          p.then((res) => {
            // 读 clone，绝不消费原响应
            res
              .clone()
              .text()
              .then((text) => {
                if (!text || text.length > MAX_SNIPPET) return;
                if (!text.includes('baseUrl') && !text.includes('base_url') && !text.includes('durl')) return;
                try {
                  const info = extract(JSON.parse(text));
                  if (info) remember(info, 'fetch');
                } catch {
                  /* 不是 JSON 就算了 */
                }
              })
              .catch(() => {});
          }).catch(() => {});
        }
      } catch {
        /* 观察失败不能影响原请求 */
      }
      return p;
    };
  }

  /* ---------------- 包 XHR ---------------- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__dshUrl = String(url || '');
      } catch {
        this.__dshUrl = '';
      }
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      try {
        const url = this.__dshUrl || '';
        if (/playurl|playinfo|player\/wbi|mediainfo/i.test(url) || url.includes('/x/player/')) {
          this.addEventListener('load', () => {
            try {
              const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
              if (!text || text.length > MAX_SNIPPET) return;
              if (!text.includes('baseUrl') && !text.includes('base_url') && !text.includes('durl')) return;
              const info = extract(JSON.parse(text));
              if (info) remember(info, 'xhr');
            } catch {
              /* 忽略 */
            }
          });
        }
      } catch {
        /* 忽略 */
      }
      return origSend.apply(this, args);
    };
  }

  /* ---------------- 首屏已有的 __playinfo__ 也收下 ---------------- */
  try {
    const info = extract(window.__playinfo__);
    if (info) remember(info, 'playinfo');
  } catch {
    /* 忽略 */
  }
})();
