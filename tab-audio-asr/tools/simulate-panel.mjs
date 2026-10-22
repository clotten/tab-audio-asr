/**
 * simulate-panel.mjs —— 用最小 DOM 桩把 content/subtitle.js 真跑一遍
 *
 * 面板跑在网页里，普通单测覆盖不到。这里手写一个够用的假 DOM
 * （元素、DocumentFragment、classList、ShadowRoot、storage 事件），验证：
 *   建面板 → 渲染句子行 → 时间戳 → 按视频时间高亮 → 开关隐藏/恢复 → 自动滚到底
 *
 * 运行：node tools/simulate-panel.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 假 DOM ============================ */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classes = new Set();
    this.style = {
      _p: {},
      setProperty(k, v) {
        this._p[k] = v;
      },
      getPropertyValue(k) {
        return this._p[k];
      }
    };
    this.listeners = {};
    this.id = '';
    this.title = '';
    this._text = '';
    this.scrollTop = 0;
    this.clientHeight = 320;
  }

  get className() {
    return [...this.classes].join(' ');
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach((x) => self.classes.add(x)),
      remove: (...c) => c.forEach((x) => self.classes.delete(x)),
      contains: (c) => self.classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self.classes.has(c) : !!force;
        if (on) self.classes.add(c);
        else self.classes.delete(c);
        return on;
      }
    };
  }

  get isConnected() {
    return true;
  }

  get scrollHeight() {
    return this.children.reduce((n, c) => n + (c.tagName === 'STYLE' ? 0 : 30), 0);
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }

  appendChild(node) {
    // 假的 DocumentFragment：子节点摊平到父节点（真实 DOM 就是这个语义）
    if (node.tagName === '#FRAGMENT') {
      const kids = [...node.children];
      node.children = [];
      kids.forEach((c) => this.appendChild(c));
      return node;
    }
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n));
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
  }
  dispatch(type, event = {}) {
    (this.listeners[type] || []).forEach((fn) => fn({ ...event, target: this }));
  }
  closest(sel) {
    if (sel !== 'button') return null;
    if (this.tagName === 'BUTTON') return this;
    let p = this.parentNode;
    while (p) {
      if (p.tagName === 'BUTTON') return p;
      p = p.parentNode;
    }
    return null;
  }
  getBoundingClientRect() {
    return { left: 100, top: 100, width: 420, height: 320, right: 520, bottom: 420 };
  }
  attachShadow() {
    const shadow = new FakeEl('#shadow-root');
    this.shadowRoot = shadow;
    return shadow;
  }
}

/* ============================ 假视频（时间和录音一起走） ============================ */

const videoStart = Date.now() - 1200;
const fakeVideo = new FakeEl('video');

let videoSeekedTo = null;
let videoRate = 1;
let videoPlaying = true;

Object.defineProperties(fakeVideo, {
  currentTime: {
    get: () => (videoSeekedTo != null ? videoSeekedTo : (Date.now() - videoStart) / 1000),
    set: (v) => {
      videoSeekedTo = v;
    }
  },
  duration: { get: () => 600 },
  paused: { get: () => !videoPlaying },
  playbackRate: {
    get: () => videoRate,
    set: (v) => {
      videoRate = v;
    }
  }
});

fakeVideo.play = async () => {
  videoPlaying = true;
};

const bodyEl = new FakeEl('body');
const fakeDocument = {
  createElement: (tag) => new FakeEl(tag),
  getElementById: () => null, // 面板会查有没有僵尸面板，桩里一律返回 null
  createDocumentFragment: () => new FakeEl('#fragment'),
  body: bodyEl,
  documentElement: new FakeEl('html'),
  fullscreenElement: null,
  addEventListener() {},
  querySelectorAll: (sel) => (sel === 'video' ? [fakeVideo] : []),
  location: { href: 'https://course.example.com/lesson/1' }
};

/* ============================ 假 chrome.storage ============================ */

const store = new Map();
const changeListeners = [];
const runtimeMessages = [];
const chromeStub = {
  runtime: {
    onMessage: {
      _listeners: [],
      addListener(fn) {
        this._listeners.push(fn);
      }
    },
    sendMessage: async (msg) => {
      runtimeMessages.push(msg);
      return null;
    }
  },
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: v };
          store.set(k, v);
        }
        for (const fn of changeListeners) fn(changes, 'local');
      }
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) }
  }
};

/* ============================ 初始会话（必须在跑脚本之前准备好） ============================ */

const startedAt = Date.now() - 1200;
store.set('asrSettings', { subtitle: { enabled: true, fontSize: 15 } });
store.set('asrSession', {
  status: 'recording',
  startedAt,
  stoppedAt: null,
  model: 'Qwen/Qwen3-ASR-1.7B',
  segments: [
    // 两句时间区间故意重叠，用来验证"起点最靠后的那句优先"
    { index: 0, startMs: 0, durationMs: 3000, status: 'done', text: '同学们好。' },
    { index: 1, startMs: 800, durationMs: 2000, status: 'done', text: '今天我们学习 MAC 帧。' }
  ]
});

/* ============================ 加载脚本 ============================ */

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ctx = vm.createContext({
  location: { href: 'https://course.example.com/lesson/1' },
  chrome: chromeStub,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  document: fakeDocument,
  ResizeObserver: FakeResizeObserver,
  window: {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    ResizeObserver: FakeResizeObserver
  },
  Date,
  Math
});

vm.runInContext(readFileSync(join(root, 'content/subtitle.js'), 'utf8'), ctx, { filename: 'subtitle.js' });

/* ============================ 演练 ============================ */

function getPanel() {
  const host = bodyEl.children.find((c) => c.id === '__video_asr_panel_host');
  return host?.shadowRoot?.children.find((c) => c.classList.contains('panel'));
}

console.log('\n1) 面板是否建出来');
const hostEl = bodyEl.children.find((c) => c.id === '__video_asr_panel_host');
check('挂载了 host 节点', !!hostEl);
check('建了 ShadowRoot', !!hostEl?.shadowRoot);
check('建了 .panel', !!getPanel());
check('初始不隐藏', getPanel() && !getPanel().classList.contains('hidden'));

console.log('\n2) 渲染句子行（含时间戳）');
await sleep(300);
let body = getPanel().children.find((c) => c.classList.contains('body'));
let rows = body.children.filter((c) => c.classList.contains('row'));
check('渲染出 2 行', rows.length === 2, `实际 ${rows.length}`);
check('第 1 行文本正确', rows[0]?.children[1]?.textContent === '同学们好。', rows[0]?.children[1]?.textContent);
check(
  '每行都有时间戳',
  rows.every((r) => /^\d+:\d\d/.test(r.children[0]?.textContent || '')),
  rows.map((r) => r.children[0]?.textContent).join(' / ')
);
check('末尾挂着"识别中"尾巴', body.children.some((c) => c.classList.contains('tail')));

console.log('\n3) 按视频时间高亮');
await sleep(400);
const cur = rows.filter((r) => r.classList.contains('cur'));
check('最多只有一行被高亮', cur.length <= 1, `实际 ${cur.length}`);
check(
  '高亮的是起点最靠后的那句',
  cur.length === 1 && rows.indexOf(cur[0]) === rows.length - 1,
  `高亮「${cur[0]?.children[1]?.textContent}」，共 ${rows.length} 行`
);

console.log('\n4) 关掉开关 → 隐藏');
await chromeStub.storage.local.set({ asrSettings: { subtitle: { enabled: false, fontSize: 15 } } });
await sleep(250);
check('面板被隐藏', getPanel().classList.contains('hidden'), getPanel().className);

console.log('\n5) 重新打开 → 恢复显示，并追加新句');
await chromeStub.storage.local.set({ asrSettings: { subtitle: { enabled: true, fontSize: 15 } } });
await sleep(200);
check('面板重新显示', !getPanel().classList.contains('hidden'), getPanel().className);

const sess = store.get('asrSession');
sess.segments.push({ index: 2, startMs: 7000, durationMs: 2500, status: 'done', text: '802.11 有三种帧。' });
await chromeStub.storage.local.set({ asrSession: { ...sess } });
await sleep(300);

body = getPanel().children.find((c) => c.classList.contains('body'));
rows = body.children.filter((c) => c.classList.contains('row'));
check('变成 3 行', rows.length === 3, `实际 ${rows.length}`);
check(
  '自动滚到了底部',
  body.scrollTop >= body.scrollHeight - body.clientHeight - 1,
  `${body.scrollTop}/${body.scrollHeight}/${body.clientHeight}`
);

const where = getPanel().children.find((c) => c.classList.contains('where'));
check('底栏句数已更新', (where?.children[0]?.textContent || '').includes('3 句'), where?.children[0]?.textContent);

console.log('\n6) 会话停止');
sess.status = 'stopped';
sess.stoppedAt = Date.now();
await chromeStub.storage.local.set({ asrSession: { ...sess } });
await sleep(250);
const whereMode = getPanel().children.find((c) => c.classList.contains('where'))?.children[1]?.textContent || '';
check('底栏显示已停止', whereMode.includes('已停止'), whereMode);
check('还没到自动淡出时间', !getPanel().classList.contains('hidden'));

  // 超过空闲时间后：默认隐藏，但被「显示到页面」唤起过（forced）就必须留着
  const stale = { ...sess, stoppedAt: Date.now() - 60_000 };
  await chromeStub.storage.local.set({ asrSession: stale });
  await sleep(200);
  check('超过 15 秒后自动隐藏', getPanel().classList.contains('hidden'), getPanel().className);

  // 模拟 SW 发来 SHOW_PANEL（注入后强制显示）
  for (const fn of chromeStub.runtime.onMessage._listeners || []) fn({ type: 'SHOW_PANEL' });
  await sleep(100);
  check('收到 SHOW_PANEL 后强制显示', !getPanel().classList.contains('hidden'), getPanel().className);

console.log('\n7) 整段预扫：拉回开头 + 设倍速 + 不静音元素');
await chromeStub.storage.local.set({ prescanCommand: { at: Date.now(), rate: 1.5 } });
await sleep(200);
check('倍速被设成 1.5', Math.abs(videoRate - 1.5) < 0.01, String(videoRate));
check('视频被拉回开头', videoSeekedTo === 0, String(videoSeekedTo));
check('元素没有被静音（静音就抓不到声音了）', fakeVideo.muted === undefined || fakeVideo.muted === false, String(fakeVideo.muted));
check('没有误发 PRESCAN_DONE', !runtimeMessages.some((m) => m.type === 'PRESCAN_DONE'), JSON.stringify(runtimeMessages));

console.log('\n8) 静音提示（切标签页把页面弄暂停了）');
{
  const s2 = store.get('asrSession');
  s2.diag = { ...(s2.diag || {}), silent: true };
  await chromeStub.storage.local.set({ asrSession: { ...s2 } });
  await sleep(200);
  const warnEl = getPanel().children.find((c) => c.classList.contains('warn'));
  check('面板出现静音警告条', !!warnEl && warnEl.classList.contains('show'), String(warnEl?.className));

  s2.diag.silent = false;
  await chromeStub.storage.local.set({ asrSession: { ...s2 } });
  await sleep(150);
  check('恢复声音后警告消失', !warnEl.classList.contains('show'), String(warnEl?.className));
}

console.log('\n9) 「生成中」独立一栏（不再是正文里的一行）');
{
  const s3 = store.get('asrSession');
  s3.partial = { text: '正在说的半句', startMs: 6000, durationMs: 2000 };
  await chromeStub.storage.local.set({ asrSession: { ...s3 } });
  await sleep(200);

  const live = getPanel().children.find((c) => c.classList.contains('live'));
  check('出现「生成中」栏', !!live && live.classList.contains('show'), String(live?.className));

  const liveText = live && live.children.find((c) => c.classList.contains('live-text'));
  check(
    '栏里显示正在说的那句',
    (liveText?.textContent || '').startsWith('正在说的半句'),
    liveText?.textContent
  );

  const body3 = getPanel().children.find((c) => c.classList.contains('body'));
  check('正文里不再混入半句', !body3.children.some((c) => c.className.includes('partial')));

  s3.partial = null;
  await chromeStub.storage.local.set({ asrSession: { ...s3 } });
  await sleep(150);
  check('定稿后「生成中」栏收起', !live.classList.contains('show'), live.className);
}

console.log('\n10) 静态稿（整段提取）按视频时间轴高亮');
{
  // 老会话形态：只有 ingestUrl、没有 source —— 正是真机上踩过的坑
  const prev = store.get('asrSession');
  const staticSession = {
    ...prev,
    status: 'stopped',
    stoppedAt: Date.now(),
    startedAt: Date.now() - 60000,
    diag: { ingestUrl: 'https://cdn.example.com/a.mp4', ingestPhase: 'done', ingestDurationMs: 30000 },
    segments: [
      { index: 0, startMs: 0, durationMs: 10000, status: 'done', text: '第一句，零到十秒。' },
      { index: 1, startMs: 10000, durationMs: 8000, status: 'done', text: '第二句，十到十八秒。' },
      { index: 2, startMs: 18000, durationMs: 9000, status: 'done', text: '第三句，十八到二十七秒。' }
    ]
  };
  await chromeStub.storage.local.set({ asrSession: staticSession });
  await sleep(250);

  // 视频播到 12 秒 → 应该高亮第二句
  fakeVideo.currentTime = 12;
  await sleep(400);

  const body = getPanel().children.find((c) => c.classList.contains('body'));
  const rows = body.children.filter((c) => c.className.includes('row'));
  const cur = rows.filter((r) => r.classList.contains('cur'));

  console.log('    调试 store:', JSON.stringify((store.get('asrSession')?.segments || []).map((s) => [s.startMs, s.text])));
  console.log('    调试 rows:', JSON.stringify(rows.map((r) => r.children[1]?.textContent)));
  console.log('    调试 diag:', JSON.stringify(store.get('asrSession')?.diag));
  check('按视频时间高亮到唯一一行', cur.length === 1, `cur=${cur.length} / rows=${rows.length}`);
  check(
    '高亮的是 10–18 秒那一句',
    (cur[0]?.children[1]?.textContent || '').includes('第二句'),
    cur[0]?.children[1]?.textContent
  );

  // 拖到 20 秒 → 高亮应换成第三句
  fakeVideo.currentTime = 20;
  await sleep(400);
  const cur2 = body.children.filter((c) => c.className.includes('row') && c.classList.contains('cur'));
  check('拖动后高亮跟着换', (cur2[0]?.children[1]?.textContent || '').includes('第三句'), cur2[0]?.children[1]?.textContent);

  // 跟随状态下，程序自己滚动不能把 followLatest 关掉（否则播放时列表不再跟着走）
  fakeVideo.currentTime = 24;
  await sleep(400);
  const cur3 = body.children.filter((c) => c.className.includes('row') && c.classList.contains('cur'));
  check('继续播放仍会高亮' , cur3.length === 1, `cur=${cur3.length}`);
  const followBtn = getPanel().children.find((c) => c.className.includes('head'))?.children?.find((c) => c.className?.includes('latest'));
  check('跟随按钮保持隐藏（没被误判为用户滚动）', !followBtn?.classList?.contains('show'), followBtn?.className);

  // 顶部显示视频进度而不是处理耗时

  // 空档期（句子之间有停顿）：要停在前面最近的句子，绝不能跳回末尾
  fakeVideo.currentTime = 17.5; // 第二句 10–18 秒刚结束前
  await sleep(350);
  const curGap = body.children.filter((c) => c.className.includes('row') && c.classList.contains('cur'));
  check('空档时仍有高亮（前面最近一句）', curGap.length === 1, `cur=${curGap.length}`);

  fakeVideo.currentTime = 0; // 视频没到任何句子
  await sleep(350);
  const curStart = body.children.filter((c) => c.className.includes('row') && c.classList.contains('cur'));
  check('视频在最开头时高亮第一句而不是最后一句', (curStart[0]?.children[1]?.textContent || '').includes('第一句'), curStart[0]?.children[1]?.textContent);
  const timerText = getPanel().children.find((c) => c.className.includes('head'))?.children?.[1]?.textContent || '';
  check('顶部显示视频进度', /^\d{2}:\d{2}/.test(timerText), timerText);

  fakeVideo.currentTime = 0;
  await chromeStub.storage.local.set({ asrSession: prev });
  await sleep(200);
}


/* ============================ 源码不变式 ============================ */
// 这几轮反复出同一类 bug：某条分支忘了按模式决定滚动目标，于是静态稿被滚到底部。
// 用源码级断言钉死：所有"滚动到哪"的决定都必须经过 resolveMode()。

console.log('\n12) 别的视频的稿子不显示在本页');
{
  const base = store.get('asrSession');
  // 给会话打一个"别的视频"的标识
  await chromeStub.storage.local.set({ asrSession: { ...base, videoKey: 'https://other.example.com/x#99s', status: 'stopped', stoppedAt: Date.now() } });
  await sleep(250);

  const body = getPanel().children.find((c) => c.classList.contains('body'));
  const rows = body.children.filter((c) => c.className.includes('row'));
  check('不显示其他视频的字幕行', rows.length === 0, 'rows=' + rows.length);

  const empty = body.children.find((c) => c.classList.contains('empty'));


console.log('\n14) 整段提取期间：不显示「正在聆听」');
{
  const base = store.get('asrSession');
  await chromeStub.storage.local.set({
    asrSession: { ...base, status: 'processing', videoKey: '', segments: [], diag: { source: 'url', ingestPhase: 'decode', ingestDone: 3, ingestUrl: 'https://x/y.mp4' } }
  });
  await sleep(250);

  const body = getPanel().children.find((c) => c.classList.contains('body'));
  const empty = body.children.find((c) => c.classList.contains('empty'));
  check('空状态被隐藏', !empty || empty.classList.contains('hide'), String(empty?.className));

  const live = getPanel().children.find((c) => c.classList.contains('live'));
  const liveText = live && live.children.find((c) => c.classList.contains('live-text'));
  check('进度显示在生成中栏', (liveText?.textContent || '').includes('整段提取'), liveText?.textContent);
  check('不再出现「正在聆听」', !(liveText?.textContent || '').includes('正在聆听'), liveText?.textContent);
}

}
console.log('\n11) 源码不变式：滚动目标必须由模式决定');
{
  const src = readFileSync(new URL('../content/subtitle.js', import.meta.url), 'utf8');

  const modeChecks = (src.match(/scrollTarget === 'current'/g) || []).length;
  check('按模式判断滚动目标的地方 ≥ 4 处', modeChecks >= 4, `实际 ${modeChecks} 处`);

  // 禁止 "if (条件) scrollToBottom();" 这种绕过模式的一行式分叉。
  // （`else scrollToBottom();` 是模式判断的另一侧，属于正确写法，不在禁止范围）
  const bare = /if \([^)]*\) scrollToBottom\(\);/.test(src);
  check('没有绕过模式的 if (...) scrollToBottom()', !bare, '发现了裸分叉');
}
console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过：面板构建、渲染、时间戳、高亮、开关、自动滚动都正常。');
process.exit(0);







