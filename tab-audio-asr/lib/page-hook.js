/**
 * pageHook —— 注入到**主世界**的钩子：抓住当前视频真正的音轨地址。
 *
 * 为什么用 `func` 而不是 `files`：实测这台 Edge 上
 * `executeScript({world:'MAIN', files:[...]})` 静默不生效（`window.__dshAsrHookInstalled` 一直是 undefined），
 * 而 `world:'MAIN' + func` 是好的（探测器读 __playinfo__ 靠的就是它）。
 *
 * 这个函数会被序列化后注入，所以**不能引用外部变量**。
 * 只做旁路观察：包住 fetch/XHR，看到 playurl 类响应就把音轨地址记到 window.__dshAsrMedia。
 */
export function pageHook() {
  if (window.__dshAsrHookInstalled) return 'already';
  window.__dshAsrHookInstalled = true;

  const KEY = '__dshAsrMedia';
  const MAX = 4 * 1024 * 1024;

  const urlOf = (x) =>
    (x && (x.baseUrl || x.base_url || x.url || (Array.isArray(x.backupUrl) ? x.backupUrl[0] : ''))) || '';

  function extract(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const roots = [obj, obj.data, obj.result, obj.data && obj.data.playinfo].filter(Boolean);
    for (const root of roots) {
      const dash = root.dash;
      if (dash && Array.isArray(dash.audio) && dash.audio.length) {
        const list = dash.audio.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        const audio = urlOf(list[0]);
        if (audio) {
          const vs = Array.isArray(dash.video) ? dash.video.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)) : [];
          return { audio, video: urlOf(vs[0]), duration: Number(root.timelength || 0) || null };
        }
      }
      if (Array.isArray(root.durl) && root.durl[0]) {
        const u = urlOf(root.durl[0]);
        if (u) return { audio: u, video: u, duration: null };
      }
    }
    return null;
  }

  function remember(info, source) {
    if (!info || !info.audio) return;
    const prev = window[KEY];
    if (prev && prev.audio === info.audio && prev.href === location.href) return;
    window[KEY] = {
      audio: info.audio,
      video: info.video || '',
      duration: info.duration || null,
      href: location.href, // 记下"这份信息属于哪个页面"，换集后可比对
      source,
      at: Date.now()
    };
  }

  const PATTERN = /playurl|playinfo|player\/wbi|mediainfo|\/x\/player\//i;

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const u = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
        if (PATTERN.test(u)) {
          p.then((res) => {
            res
              .clone()
              .text()
              .then((t) => {
                if (!t || t.length > MAX) return;
                if (t.indexOf('baseUrl') < 0 && t.indexOf('base_url') < 0 && t.indexOf('durl') < 0) return;
                try {
                  const info = extract(JSON.parse(t));
                  if (info) remember(info, 'fetch');
                } catch {}
              })
              .catch(() => {});
          }).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (m, u, ...rest) {
      try {
        this.__dshUrl = String(u || '');
      } catch {}
      return origOpen.call(this, m, u, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        if (PATTERN.test(this.__dshUrl || '')) {
          this.addEventListener('load', () => {
            try {
              const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
              if (!t || t.length > MAX) return;
              if (t.indexOf('baseUrl') < 0 && t.indexOf('base_url') < 0 && t.indexOf('durl') < 0) return;
              const info = extract(JSON.parse(t));
              if (info) remember(info, 'xhr');
            } catch {}
          });
        }
      } catch {}
      return origSend.apply(this, args);
    };
  }

  // 首屏已有的 __playinfo__ 也收（只是起点，换集后会被新响应覆盖）
  try {
    const info = extract(window.__playinfo__);
    if (info) remember(info, 'playinfo');
  } catch {}

  return 'installed';
}
