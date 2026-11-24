/**
 * pageHook —— 注入到**主世界**的钩子：从播放器请求里捞当前视频的音轨地址。
 *
 * 为什么用 `func` 而不是 `files`：实测这台 Edge 上
 * `executeScript({world:'MAIN', files:[...]})` 静默不生效（`window.__dshAsrHookInstalled` 一直是 undefined），
 * 而 `world:'MAIN' + func` 是好的。
 *
 * 这个函数会被序列化后注入，所以**不能引用外部变量**——所有平台相关的规则
 * 都由调用方通过 `spec` 参数传进来（见 lib/platforms/registry.js 的 hookSpec）。
 *
 * 钩子本身**不认识任何平台**：它只做两件事——
 *   1. 包住 fetch/XHR，把命中 pattern 的 JSON 响应拿下来；
 *   2. 在 JSON 里递归找所有 http(s) 链接，按关键词分成"音轨/视频轨"。
 * 具体哪条是音轨、要不要特殊请求头，交给扩展那边按平台适配器决定。
 *
 * @param {{pattern:string, audioMarkers:string[], videoMarkers:string[]}} spec
 */
export function pageHook(spec) {
  if (window.__dshAsrHookInstalled) return 'already';
  window.__dshAsrHookInstalled = true;

  const KEY = '__dshAsrMedia';
  const MAX = 4 * 1024 * 1024;
  const audioMarkers = (spec && spec.audioMarkers) || [];
  const videoMarkers = (spec && spec.videoMarkers) || [];
  let PATTERN;
  try {
    PATTERN = new RegExp(String((spec && spec.pattern) || 'playurl'), 'i');
  } catch {
    PATTERN = /playurl/i;
  }

  const has = (u, markers) => markers.some((m) => m && u.toLowerCase().includes(String(m).toLowerCase()));

  /** 在 JSON 里递归找所有像媒体地址的字符串 */
  function collect(node, out, depth) {
    if (!node || depth > 8 || out.length > 200) return;
    if (typeof node === 'string') {
      if (node.length > 8 && node.length < 2000 && /^https?:\/\//i.test(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) collect(item, out, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const v of Object.values(node)) collect(v, out, depth + 1);
    }
  }

  function classify(list) {
    const audio = [];
    const video = [];
    for (const u of list) {
      if (has(u, audioMarkers)) audio.push(u);
      else if (has(u, videoMarkers)) video.push(u);
    }
    return { audio, video };
  }

  function remember(urls, source) {
    const list = Array.from(new Set(urls));
    if (!list.length) return;
    const { audio, video } = classify(list);
    // 一条都没分出来也存下来：交给扩展按平台适配器挑（总比什么都没有强）
    const prev = window[KEY];
    const next = {
      audio: audio[0] || '',
      video: video[0] || '',
      list: list.slice(0, 40),
      href: location.href, // 记下"这份信息属于哪个页面"，换集后可比对
      source,
      at: Date.now()
    };
    if (prev && prev.audio === next.audio && prev.href === next.href) return;
    window[KEY] = next;
  }

  function handleText(text, source) {
    if (!text || text.length > MAX) return;
    // 快筛：连 http 都没有就不是我们要的响应
    if (text.indexOf('http') < 0) return;
    try {
      const out = [];
      collect(JSON.parse(text), out, 0);
      remember(out, source);
    } catch {
      /* 不是 JSON 就算了 */
    }
  }

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
              .then((t) => handleText(t, 'fetch'))
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
              handleText(t, 'xhr');
            } catch {}
          });
        }
      } catch {}
      return origSend.apply(this, args);
    };
  }

  // 首屏就内联在页面里的数据（B 站的 __playinfo__ 就是这种）
  try {
    const seeds = [window.__playinfo__, window.SSR_RENDER_DATA, window.RENDER_DATA];
    for (const seed of seeds) {
      if (!seed) continue;
      const out = [];
      collect(seed, out, 0);
      remember(out, 'inline');
    }
  } catch {}

  return 'installed';
}
