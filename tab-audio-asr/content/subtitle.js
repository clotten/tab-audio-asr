/**
 * content/subtitle.js —— 视频页浮窗文字稿（注入到被录制的网页里）
 *
 * 为什么是"面板"而不是单行字幕：
 *   tabCapture 的音频必须先被播放出来，识别必然滞后几秒，
 *   做成逐字跟读的卡拉 OK 字幕只会让人一直处在"怎么还没出字"的焦虑里。
 *   做成累积的大字稿面板：一边看视频，一边往下滚着读，反而更顺手。
 *
 * 设计要点：
 *  1. 用 Shadow DOM 隔离样式，页面自己的 CSS 影响不到面板；
 *  2. 不靠消息通信，直接监听 chrome.storage.onChanged（内容脚本可以使用 storage）；
 *  3. 录制期间每 250ms 采一次 (墙钟, video.currentTime)，把句子映射到视频时间轴上高亮；
 *  4. 视频全屏时把节点搬进 fullscreenElement，否则全屏下会被藏掉；
 *  5. 可拖动、可拉大小，位置/尺寸/字号都记进设置。
 */

(() => {
  if (window.__videoAsrSubtitleLoaded) return;
  window.__videoAsrSubtitleLoaded = true;

  const SESSION_KEY = 'asrSession';
  const SETTINGS_KEY = 'asrSettings';
  const ACTIVE = new Set(['starting', 'recording', 'stopping']);
  const IDLE_HIDE_MS = 15000;
  const MAX_ROWS = 400;

  const DEFAULT_SUB = {
    enabled: true,
    fontSize: 15,
    opacity: 0.92,
    pos: null, // { leftPct, bottomPx }
    size: null // { w, h }
  };

  let settings = { subtitle: { ...DEFAULT_SUB } };
  let session = null;
  let host = null;
  let wrap = null;
  let parts = {};
  let ticker = null;
  let hideTimer = null;
  let dragging = null;
  let dead = false;
  // 被「显示到页面」显式唤起时，忽略"空闲自动隐藏"（否则注入后立刻又藏起来）
  let forced = false;
  let fsFullscreenRetry = false;

  // 渲染缓存
  let rowEls = new Map(); // item.index → row element
  let lastSig = '';
  let followLatest = true;
  let resizing = false;
  let sizeTimer = null;
  let lastCurIndex = null;
  let sessionTouched = false; // load() 与 storage 监听器之间的竞态保护
  let settingsTouched = false;

  /* ============================ 视频时间轴映射 ============================ */

  const samples = []; // { wall, video, rate, paused }
  const itemVideoStart = new Map(); // item.index → 秒；NOT_MAPPABLE 表示算不出来
  const NOT_MAPPABLE = -1;
  let mappedForSession = null;

  function findVideo() {
    let best = null;
    const list = document.querySelectorAll('video');
    for (const v of list) {
      if (!v || !Number.isFinite(v.currentTime)) continue;
      if (!best || (v.duration || 0) > (best.duration || 0)) best = v;
    }
    return best;
  }

  function sampleTick() {
    const v = findVideo();
    if (!v) return;
    samples.push({
      wall: Date.now(),
      video: v.currentTime,
      rate: Number.isFinite(v.playbackRate) && v.playbackRate > 0 ? v.playbackRate : 1,
      paused: !!v.paused
    });
    if (samples.length > 2400) samples.splice(0, samples.length - 2400);
  }

  function videoTimeAt(wall) {
    if (!samples.length) return null;
    let best = samples[0];
    let bestDelta = Math.abs(best.wall - wall);
    for (let i = 1; i < samples.length; i++) {
      const d = Math.abs(samples[i].wall - wall);
      if (d < bestDelta) {
        bestDelta = d;
        best = samples[i];
      }
    }
    if (bestDelta > 30000) return null;
    const dt = (wall - best.wall) / 1000;
    return best.paused ? best.video : best.video + dt * best.rate;
  }

  function ensureMapping(items) {
    if (!session?.startedAt) return;

    // 整段提取（直链媒体）的时间戳本来就相对视频开头，不需要 wall→video 映射，
    // 直接按 startMs 当视频时间——这样播放时就能正常高亮。
    if (session.diag?.source === 'url') {
      if (mappedForSession !== session.startedAt) {
        mappedForSession = session.startedAt;
        itemVideoStart.clear();
      }
      for (const item of items) {
        if (!itemVideoStart.has(item.index)) itemVideoStart.set(item.index, (item.startMs || 0) / 1000);
      }
      return;
    }

    if (mappedForSession !== session.startedAt) {
      mappedForSession = session.startedAt;
      itemVideoStart.clear();
      samples.length = 0;
      lastSig = '';
    }
    const windowStart = samples.length ? samples[0].wall - 2000 : null;

    for (const item of items) {
      if (itemVideoStart.has(item.index)) continue;
      const wall = session.startedAt + (item.startMs || 0);
      // 采样窗口之前的老句子没法映射，缓存哨兵值避免每帧重算
      if (windowStart != null && wall < windowStart) {
        itemVideoStart.set(item.index, NOT_MAPPABLE);
        continue;
      }
      const v = videoTimeAt(wall);
      if (v == null) continue;
      itemVideoStart.set(item.index, v);
    }
  }

  function mappedStart(item) {
    const v = itemVideoStart.get(item.index);
    return v == null || v === NOT_MAPPABLE ? null : v;
  }

  function doneItems() {
    return (session?.segments || []).filter((s) => s.status === 'done' && s.text);
  }

  /* ============================ 构建 UI ============================ */

  function build() {
    host = document.createElement('div');
    host.id = '__video_asr_panel_host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .panel {
        position: fixed;
        left: 50%;
        bottom: 90px;
        transform: translateX(-50%);
        width: 420px;
        height: 320px;
        min-width: 260px;
        min-height: 130px;
        max-width: 92vw;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        background: rgba(10, 14, 20, var(--bg-opacity, .92));
        color: #e9eef5;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.5);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
        font-size: var(--fs, 15px);
        line-height: 1.55;
        pointer-events: auto;
        overflow: hidden;
        resize: both;
      }
      .panel.dragging { transition: none; }
      .panel.hidden { display: none; }

      .head {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 9px;
        font-size: 11px;
        color: rgba(233,238,245,.62);
        border-bottom: 1px solid rgba(255,255,255,.07);
        cursor: grab;
        user-select: none;
        flex: 0 0 auto;
      }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #e5484d; animation: pulse 1.4s infinite; flex: 0 0 auto; }
      @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .28 } }
      .panel.stopped .dot { background: #8b98a9; animation: none; }
      .time { font-variant-numeric: tabular-nums; font-family: ui-monospace, Consolas, monospace; }
      .spacer { flex: 1 1 auto; }
      .model { opacity: .68; max-width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .btn {
        all: unset;
        cursor: pointer;
        padding: 2px 7px;
        border-radius: 6px;
        font-size: 11px;
        color: rgba(233,238,245,.72);
        background: rgba(255,255,255,.07);
      }
      .btn:hover { background: rgba(255,255,255,.16); color: #fff; }
      .btn.close { padding: 2px 6px; background: transparent; font-size: 14px; line-height: 1; }
      .btn.latest { display: none; }
      .btn.latest.show { display: inline-block; }

      .body {
        flex: 1 1 auto;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 6px 10px 10px;
        scrollbar-width: thin;
      }
      .body::-webkit-scrollbar { width: 8px; }
      .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 4px; }
      .body::-webkit-scrollbar-track { background: transparent; }

      .row {
        display: flex;
        gap: 8px;
        padding: 3px 4px 3px 7px;
        border-left: 2px solid transparent;
        border-radius: 3px;
        margin-bottom: 2px;
      }
      .row .t {
        flex: 0 0 auto;
        font-family: ui-monospace, Consolas, monospace;
        font-size: .78em;
        color: #6f8bb5;
        padding-top: .28em;
        user-select: none;
      }
      .row .s { flex: 1 1 auto; word-break: break-word; white-space: pre-wrap; }
      .row.cur { border-left-color: #3b82f6; background: rgba(59,130,246,.12); }
      .row.cur .s { color: #fff; }
      .row.partial { opacity: .62; border-left-color: rgba(233,238,245,.25); }
      .row.partial .s { font-style: italic; }
      .row.partial .t { color: #5b6879; }

      .tail {
        display: none;
        align-items: center;
        gap: 6px;
        padding: 4px 7px;
        color: rgba(233,238,245,.45);
        font-style: italic;
        font-size: .9em;
      }
      .tail.show { display: flex; }
      .tail i {
        width: 6px; height: 6px; border-radius: 50%; background: #3b82f6;
        animation: pulse 1s infinite; display: inline-block;
      }

      .empty { color: rgba(233,238,245,.42); font-style: italic; padding: 6px 7px; }

      /* 「生成中」独立一栏：和已确认的正文分开，避免半句话混进稿子里 */
      .live {
        display: none;
        border-top: 1px solid rgba(255,255,255,.10);
        background: rgba(59,130,246,.07);
        padding: 6px 10px 7px;
        flex: 0 0 auto;
        max-height: 34%;
        overflow: hidden;
      }
      .live.show { display: block; }
      .live .live-label {
        display: flex; align-items: center; gap: 5px;
        font-size: .78em; letter-spacing: .04em;
        color: #7ea6f5; margin-bottom: 2px;
      }
      .live .live-label i {
        width: 5px; height: 5px; border-radius: 50%; background: #3b82f6;
        animation: pulse 1s infinite; display: inline-block;
      }
      .live .live-text {
        color: rgba(233,238,245,.78);
        font-style: italic;
        line-height: 1.55;
        word-break: break-word;
      }

      .warn {
        display: none;
        padding: 5px 10px;
        font-size: 11px;
        line-height: 1.4;
        color: #ffd48a;
        background: rgba(210, 153, 34, .13);
        border-bottom: 1px solid rgba(210, 153, 34, .25);
        flex: 0 0 auto;
      }
      .warn.show { display: block; }

      .where {
        flex: 0 0 auto;
        padding: 4px 10px 6px;
        font-size: 10.5px;
        color: rgba(233,238,245,.35);
        border-top: 1px solid rgba(255,255,255,.06);
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';

    const head = document.createElement('div');
    head.className = 'head';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = '00:00';

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const model = document.createElement('span');
    model.className = 'model';

    const latestBtn = document.createElement('button');
    latestBtn.className = 'btn latest';
    latestBtn.textContent = '回到最新';
    latestBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      followLatest = true;
      latestBtn.classList.remove('show');
      scrollToBottom();
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn close';
    closeBtn.textContent = '×';
    closeBtn.title = '隐藏面板（可在插件面板里重新打开）';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setEnabled(false);
    });

    head.append(dot, time, spacer, model, latestBtn, closeBtn);

    const body = document.createElement('div');
    body.className = 'body';

    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '正在聆听…';
    body.appendChild(empty);

    const tail = document.createElement('div');
    tail.className = 'tail';
    const tailDot = document.createElement('i');
    const tailText = document.createElement('span');
    tailText.textContent = '识别中…';
    tail.append(tailDot, tailText);

    // 「生成中」栏：只放还没定稿的那句，和正文分开
    const live = document.createElement('div');
    live.className = 'live';
    const liveLabel = document.createElement('div');
    liveLabel.className = 'live-label';
    const liveDot = document.createElement('i');
    const liveLabelText = document.createElement('span');
    liveLabelText.textContent = '生成中';
    liveLabel.append(liveDot, liveLabelText);
    const liveText = document.createElement('div');
    liveText.className = 'live-text';
    live.append(liveLabel, liveText);

    const where = document.createElement('div');
    where.className = 'where';
    const whereCount = document.createElement('span');
    const whereMode = document.createElement('span');
    where.append(whereCount, whereMode);

    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = '⚠ 捕获到的音频是静音：这一页可能被暂停或静音了';

    panel.append(head, warn, body, live, where);
    root.append(style, panel);
    document.addEventListener('fullscreenchange', mount, true);
    document.addEventListener('webkitfullscreenchange', mount, true);

    // 用户手动滚动 → 关掉自动跟随
    body.addEventListener('scroll', () => {
      if (resizing) return;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
      followLatest = atBottom;
      latestBtn.classList.toggle('show', !atBottom);
    });

    head.addEventListener('pointerdown', onDragStart);

    // 拉大小后记住尺寸
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        resizing = true;
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => {
          resizing = false;
          const rect = wrap.getBoundingClientRect();
          if (rect.width < 100 || rect.height < 60) return;
          settings.subtitle = {
            ...(settings.subtitle || DEFAULT_SUB),
            size: { w: Math.round(rect.width), h: Math.round(rect.height) }
          };
          persistSubtitle(settings.subtitle);
        }, 400);
      });
      ro.observe(panel);
    }

    parts = { panel, dot, time, model, body, empty, tail, live, liveText, whereCount, whereMode, latestBtn, warn };
    wrap = panel;

    mount();

    // SPA 页面可能整块替换 body，定时兜底挂回
    setInterval(() => {
      if (dead) return;
      if (host && !host.isConnected) mount();
    }, 2000);
  }

  function mount() {
    if (!host) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;

    // <video> 自己全屏时是 replaced element，子节点不渲染，只能把父容器顶成全屏
    if (fs && fs.tagName === 'VIDEO') {
      const parent = fs.parentElement;
      if (parent && parent !== document.body && !fsFullscreenRetry) {
        fsFullscreenRetry = true;
        try {
          parent.requestFullscreen?.().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      return;
    }
    fsFullscreenRetry = false;

    const target = fs || document.body;
    if (!target) return;
    if (host.parentNode === target) {
      applyLayout();
      return;
    }

    host.style.cssText = fs
      ? 'all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;'
      : 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

    target.appendChild(host);
    applyLayout();
  }

  /* ============================ 拖动 / 布局 ============================ */

  function onDragStart(event) {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return;
    const rect = wrap.getBoundingClientRect();
    dragging = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
    wrap.classList.add('dragging');
    wrap.style.left = rect.left + 'px';
    wrap.style.top = rect.top + 'px';
    wrap.style.bottom = 'auto';
    wrap.style.transform = 'none';
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onDragEnd, true);
    event.preventDefault();
  }

  function onDragMove(event) {
    if (!dragging) return;
    const rect = wrap.getBoundingClientRect();
    const left = Math.min(
      Math.max(4, dragging.left + (event.clientX - dragging.startX)),
      Math.max(4, window.innerWidth - rect.width - 4)
    );
    const top = Math.min(
      Math.max(4, dragging.top + (event.clientY - dragging.startY)),
      Math.max(4, window.innerHeight - rect.height - 4)
    );
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onDragEnd, true);
    wrap.classList.remove('dragging');

    const rect = wrap.getBoundingClientRect();
    settings.subtitle = {
      ...(settings.subtitle || DEFAULT_SUB),
      pos: {
        leftPct: ((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 100,
        bottomPx: Math.max(4, window.innerHeight - rect.bottom)
      }
    };
    persistSubtitle(settings.subtitle);
    dragging = null;
    applyLayout();
  }

  function applyLayout() {
    if (!wrap || dragging) return;
    const sub = { ...DEFAULT_SUB, ...(settings.subtitle || {}) };

    wrap.style.setProperty('--fs', `${sub.fontSize || DEFAULT_SUB.fontSize}px`);
    wrap.style.setProperty('--bg-opacity', String(sub.opacity ?? DEFAULT_SUB.opacity));

    const size = sub.size;
    if (size && size.w > 100 && size.h > 60) {
      wrap.style.width = `${Math.min(size.w, window.innerWidth - 16)}px`;
      wrap.style.height = `${Math.min(size.h, window.innerHeight - 16)}px`;
    }

    const pos = sub.pos;
    if (pos && Number.isFinite(pos.leftPct) && Number.isFinite(pos.bottomPx)) {
      wrap.style.left = `${pos.leftPct}%`;
      wrap.style.bottom = `${pos.bottomPx}px`;
    } else {
      wrap.style.left = '50%';
      wrap.style.bottom = '90px';
    }
    wrap.style.top = 'auto';
    wrap.style.transform = 'translateX(-50%)';
  }

  /* ============================ 存储 ============================ */

  async function persistSubtitle(subtitle) {
    try {
      const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(stored || {}), subtitle } });
    } catch {
      /* 扩展被重载后 chrome.* 会失效 */
    }
  }

  function setEnabled(enabled) {
    settings.subtitle = { ...(settings.subtitle || DEFAULT_SUB), enabled };
    persistSubtitle(settings.subtitle);
    render();
  }

  /* ============================ 渲染 ============================ */

  function fmtClock(sec) {
    const t = Math.max(0, Math.floor(sec));
    const h = Math.floor(t / 3600);
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  function rowTime(item) {
    const v = mappedStart(item);
    if (v != null) return fmtClock(v);
    // 没有视频映射时退回"录音开始后第几秒"
    return fmtClock((item.startMs || 0) / 1000);
  }

  function scrollToBottom() {
    parts.body.scrollTop = parts.body.scrollHeight;
  }

  function rebuildRows(items, partial) {
    const body = parts.body;
    body.textContent = '';
    rowEls = new Map();

    if (!items.length && !partial) {
      body.appendChild(parts.empty);
      return;
    }

    const start = Math.max(0, items.length - MAX_ROWS);
    const frag = document.createDocumentFragment();

    for (let i = start; i < items.length; i++) {
      const item = items[i];
      const row = document.createElement('div');
      row.className = 'row';

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = rowTime(item);

      const s = document.createElement('span');
      s.className = 's';
      s.textContent = item.text;

      row.append(t, s);
      frag.appendChild(row);
      rowEls.set(item.index, row);
    }

    // 未定稿的那句不混进正文，统一放到独立的「生成中」栏（见 updateLive）

    frag.appendChild(parts.tail);
    body.appendChild(frag);
  }

  /** 「生成中」栏：显示还没定稿的那句；没有就按状态显示占位或隐藏 */
  function updateLive(partial) {
    const area = parts.live;
    if (!area) return;
    const text = (partial?.text || '').trim();
    const live = !!session && ACTIVE.has(session.status);

    if (text) {
      parts.liveText.textContent = `${text}…`;
      area.classList.add('show');
      return;
    }
    if (live) {
      parts.liveText.textContent = '正在聆听…';
      area.classList.add('show');
      return;
    }
    parts.liveText.textContent = '';
    area.classList.remove('show');
  }

  function updateHighlight() {
    const video = findVideo();
    const t = video ? video.currentTime : null;
    let curIndex = null;

    if (t != null) {
      // 句子区间可能重叠（合并切句时会有），取"起点最靠后"的那句更符合直觉
      let bestStart = -Infinity;
      for (const item of doneItems()) {
        const start = mappedStart(item);
        if (start == null) continue;
        const end = start + Math.max(0.6, (item.durationMs || 0) / 1000);
        if (t >= start - 0.25 && t < end && start > bestStart) {
          bestStart = start;
          curIndex = item.index;
        }
      }
    }

    for (const [index, el] of rowEls) {
      const should = index === curIndex;
      if (el.classList.contains('cur') !== should) el.classList.toggle('cur', should);
    }

    // 视频跑到识别进度前面 → 显示"识别中"
    let waiting = false;
    if (t != null && rowEls.size) {
      const items = doneItems();
      const last = items[items.length - 1];
      const lastStart = last ? mappedStart(last) : null;
      waiting = lastStart != null && t > lastStart && curIndex === null;
    }
    parts.tail.classList.toggle('show', waiting);
    return { curIndex, waiting };
  }

  function render() {
    if (!wrap) return;

    const sub = { ...DEFAULT_SUB, ...(settings.subtitle || {}) };
    const active = !!session && ACTIVE.has(session.status);

    if (sub.enabled === false) {
      wrap.classList.add('hidden');
      stopTicker();
      return;
    }
    if (!session) {
      wrap.classList.add('hidden');
      stopTicker();
      return;
    }
    if (!forced && !active && session.stoppedAt && Date.now() - session.stoppedAt > IDLE_HIDE_MS) {
      wrap.classList.add('hidden');
      stopTicker();
      return;
    }

    wrap.classList.remove('hidden');
    wrap.classList.toggle('stopped', !active);
    const silent = !!session?.diag?.silent;
    parts.warn.classList.toggle('show', silent);
    applyLayout();

    const items = doneItems();
    ensureMapping(session.segments || []);

    parts.model.textContent = session.model || '';

    const last = items[items.length - 1];
    const partial = session.partial && session.partial.text ? session.partial : null;
    const sig = [
      items.length,
      last?.index ?? '-',
      (last?.text || '').length,
      (partial?.text || '').length,
      sub.fontSize,
      sub.size?.h ?? '-'
    ].join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      const keepTop = parts.body.scrollTop;
      rebuildRows(items, partial);
      if (followLatest) scrollToBottom();
      else parts.body.scrollTop = keepTop;
    }

    updateHighlight();

    // 「生成中」独立一栏，始终同步
    updateLive(partial);

    parts.whereCount.textContent = `${items.length} 句 / ${items.reduce((n, s) => n + s.text.length, 0)} 字`;
    parts.whereMode.textContent = active ? '录制中' : '已停止';

    updateBadge();

    // forced：被「显示到页面」显式唤起。即使已停止，也要跑 ticker，
    // 否则拖动/播放视频时高亮不会更新。
    if (active || forced) {
      startTicker();
    } else {
      stopTicker();
      clearTimeout(hideTimer);
      if (session.stoppedAt) {
        const left = Math.max(0, IDLE_HIDE_MS - (Date.now() - session.stoppedAt));
        hideTimer = setTimeout(render, left + 60);
      }
    }
  }

  function updateBadge() {
    if (!session?.startedAt) {
      parts.time.textContent = '00:00';
      return;
    }
    const end = session.stoppedAt || Date.now();
    parts.time.textContent = fmtClock((end - session.startedAt) / 1000);
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!session) return;
      if (ACTIVE.has(session.status)) {
        sampleTick();
        // 采样点刚到齐的句子要在这里补算映射，否则它永远映射不上（高亮就会失效）
        ensureMapping(session.segments || []);
        updateBadge();
        const { curIndex } = updateHighlight();
        // 高亮换人了才滚，别每 250ms 都拽一次滚动条
        if (curIndex != null && curIndex !== lastCurIndex && followLatest) scrollToBottom();
        lastCurIndex = curIndex;
      } else {
        // 已停止但还在看（例如整段提取后拖时间轴）：也要跟着视频时间刷高亮
        ensureMapping(session.segments || []);
        const { curIndex } = updateHighlight();
        if (curIndex != null && curIndex !== lastCurIndex && followLatest) scrollToBottom();
        lastCurIndex = curIndex;
        updateBadge();
      }
    }, 250);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  /* ============================ 整段预扫 ============================ */

  let lastPrescanAt = 0;

  function sendPrescanDone(reason) {
    try {
      chrome.runtime.sendMessage({ type: 'PRESCAN_DONE', reason });
    } catch {
      /* 扩展可能已重载 */
    }
  }

  function handlePrescan(cmd) {
    if (!cmd || !cmd.at || cmd.at <= lastPrescanAt) return;
    lastPrescanAt = cmd.at;
    runPrescan(Math.min(2, Math.max(1, Number(cmd.rate) || 1.5)));
  }

  /**
   * 注意：这不是"偷偷提前"——视频是真的在快进，只是靠插件的静音录制让它不出声。
   * 所以画面时间轴就是倍速后的时间轴，字幕时间戳依然对得上。
   */
  async function runPrescan(rate) {
    const video = findVideo();
    if (!video) {
      sendPrescanDone('no-video');
      return;
    }

    try {
      video.currentTime = 0;
    } catch {
      /* 有些播放器不允许直接跳 */
    }
    try {
      video.playbackRate = rate;
    } catch {
      /* ignore */
    }
    // 千万不要用元素静音：元素静音会让 tabCapture 抓到纯静音
    video.muted = false;

    try {
      await video.play();
    } catch {
      /* 需要用户手势的站点，尽力而为 */
    }

    const startedAt = Date.now();
    let done = false;

    const cleanup = () => {
      done = true;
      clearInterval(guard);
      video.removeEventListener('ended', onEnded);
    };
    const onEnded = () => {
      if (done) return;
      cleanup();
      sendPrescanDone('ended');
    };

    const guard = setInterval(() => {
      if (done) return;
      const v = findVideo();
      if (!v) return;

      // 页面播放器常会把倍速改回去，这里持续纠正
      if (Math.abs((v.playbackRate || 1) - rate) > 0.01) {
        try {
          v.playbackRate = rate;
        } catch {
          /* ignore */
        }
      }
      if (v.paused && !v.ended) {
        try {
          v.play();
        } catch {
          /* ignore */
        }
      }

      // 安全网：远超预估时长还没结束，就当播完了
      const limitMs = Math.max(120000, ((v.duration || 600) / rate) * 1000 * 1.5 + 30000);
      if (Date.now() - startedAt > limitMs) {
        cleanup();
        sendPrescanDone('timeout');
      }
    }, 1000);

    video.addEventListener('ended', onEnded, { once: true });
  }

  /* ============================ 初始化 ============================ */

  async function load() {
    try {
      const stored = await chrome.storage.local.get([SESSION_KEY, SETTINGS_KEY, 'prescanCommand']);
      // 注意竞态：监听器可能已经先拿到更新的值，
      // 如果这里无条件用"读到的旧快照"覆盖，会话就会被打回 null（面板闪一下空白）。
      if (!sessionTouched) session = stored[SESSION_KEY] || null;
      if (!settingsTouched) {
        settings = { ...settings, ...(stored[SETTINGS_KEY] || {}) };
      }
      settings.subtitle = { ...DEFAULT_SUB, ...(settings.subtitle || {}) };
      render();
      handlePrescan(stored.prescanCommand);
    } catch {
      dead = true;
    }
  }

  /** SW 在「显示到页面」时会发这条，用来压掉空闲自动隐藏 */
  function listenShowForce() {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== 'SHOW_PANEL') return;
        forced = true;
        render();
      });
    } catch {
      /* ignore */
    }
  }
  function listen() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SESSION_KEY]) {
          sessionTouched = true;
          session = changes[SESSION_KEY].newValue || null;
          render();
        }
        if (changes[SETTINGS_KEY]) {
          settingsTouched = true;
          const next = changes[SETTINGS_KEY].newValue || {};
          settings = next;
          settings.subtitle = { ...DEFAULT_SUB, ...(next.subtitle || {}) };
          render();
        }
        if (changes.prescanCommand) {
          handlePrescan(changes.prescanCommand.newValue);
        }
      });
    } catch {
      dead = true;
    }
  }

  try {
    build();
    listen();
    listenShowForce();
    load();
  } catch (err) {
    // 某些沙箱 iframe 里不允许嵌入，不影响录制；但打条日志，出问题时好排查
    try {
      console.warn('[video-asr] 浮窗初始化失败：', err);
    } catch {
      /* ignore */
    }
  }
})();



