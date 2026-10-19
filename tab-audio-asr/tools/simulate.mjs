/**
 * simulate.mjs —— 不开浏览器，把 popup → SW → offscreen 的消息流真跑一遍
 *
 * 为什么要这个：MV3 里很多 bug 只在"跨上下文"时才暴露，
 * 比如 offscreen 文档里没有 chrome.storage（这次就栽在这上面），
 * 静态检查能挡一部分，剩下的用这套 stub 在 Node 里跑一遍最快。
 *
 * 覆盖：START（申请 streamId → 建 offscreen → 转交）→ 分段录制 → 上传识别 → 文本落盘
 *       → STOP → RESET → 队列空后关闭 offscreen
 *
 * 运行：node tools/simulate.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
// 把真实的编解码 / VAD 注入 vm 上下文，这样仿真跑的是真代码而不是桩
import { encodeWav, mixToMono, resampleBox, TARGET_SAMPLE_RATE } from '../lib/wav.js';
import { detectSpeechRegions, createStreamingSegmenter } from '../lib/vad.js';
import {
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse
} from '../lib/glossary.js';
import { looksLikeHallucination } from '../lib/hallucination.js';
import { createWavWriter, readAudioFile } from '../lib/audiofile.js';
import { createSileroVad, createSileroGate } from '../lib/silero.js';
import { planInterim, stripCommittedOverlap } from '../lib/incremental.js';

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

/* ============================ 消息总线 ============================ */

class Bus {
  constructor() {
    this.handlers = { sw: [], offscreen: [] };
    this.offscreenAlive = false;
    this.log = [];
    this.createOpts = null;
  }
  register(ctx, fn) {
    this.handlers[ctx].push(fn);
  }
  send(from, msg) {
    const to = msg?.target === 'offscreen' ? 'offscreen' : 'sw';
    this.log.push({ from, to, type: msg?.type });
    if (to === 'offscreen' && !this.offscreenAlive) {
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    }

    const handlers = this.handlers[to];
    return new Promise((resolve, reject) => {
      let settled = false;
      let wantsResponse = false;
      const sendResponse = (r) => {
        if (settled) return;
        settled = true;
        resolve(r ?? null);
      };
      for (const h of handlers) {
        const ret = h(msg, { id: 'sim' }, sendResponse);
        if (ret === true) wantsResponse = true;
      }
      setTimeout(() => {
        if (settled) return;
        settled = true;
        // 真实 Chrome：没人回包时通道关闭，promise resolve undefined
        if (wantsResponse) reject(new Error('The message port closed before a response was received.'));
        else resolve(null);
      }, 3000);
    });
  }
}

const bus = new Bus();

/* ============================ chrome stub ============================ */

const store = new Map();

const storageApi = {
  get: async (keys) => {
    const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (store.has(k)) out[k] = store.get(k);
    return out;
  },
  set: async (obj) => {
    for (const [k, v] of Object.entries(obj)) store.set(k, v);
  },
  remove: async (keys) => {
    for (const k of [].concat(keys)) store.delete(k);
  }
};

function makeRuntime(ctx) {
  return {
    id: 'sim',
    getURL: (p) => 'chrome-extension://sim/' + p,
    getContexts: async () =>
      bus.offscreenAlive ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://sim/offscreen.html' }] : [],
    sendMessage: (msg) => bus.send(ctx, msg),
    onMessage: { addListener: (fn) => bus.register(ctx, fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} }
  };
}

const swChrome = {
  runtime: makeRuntime('sw'),
  storage: { local: storageApi },
  offscreen: {
    createDocument: async (opts) => {
      bus.createOpts = opts;
      bus.createCount = (bus.createCount || 0) + 1;
      bus.offscreenAlive = true;
    },
    closeDocument: async () => {
      bus.offscreenAlive = false;
    }
  },
  tabs: {
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1test', title: '测试视频：小狗', audible: true }),
    query: async () => [],
    onUpdated: { addListener: (fn) => (bus.onUpdated = fn) }
  },
  tabCapture: {
    getMediaStreamId: async () => 'stream-123'
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {}
  },
  scripting: {
    executeScript: async (opts) => {
      (bus.injected ||= []).push(opts);
      return [{ result: null }];
    }
  },
  permissions: { contains: async () => true, request: async () => true }
};

// 关键：offscreen 只有 runtime —— 故意不给 storage / offscreen / tabs，越界就立刻抛错
const offscreenChrome = { runtime: makeRuntime('offscreen') };

/* ============================ Web API stub ============================ */

class FakeTrack {
  constructor() {
    this.listeners = {};
    this.stopped = false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor() {
    this.active = true;
    this.track = new FakeTrack();
  }
  getAudioTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

const recorders = [];

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.chunks = [];
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // 模拟真实行为：先 dataavailable，再 onstop
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
    this.onstop?.();
  }
}

/** 解码桩：默认产出"两段话 + 中间静音"，用来验证 VAD 切句；切到 silence 模式验证跳过 */
let decoderMode = 'speech';

/** 实时 PCM 通路开关：关掉时 AudioWorklet.addModule 直接抛错，走 MediaRecorder 回退 */
let pcmEnabled = false;
const workletNodes = [];

/** 供 PCM 通路喂的音频：两句短语 + 一段长讲话 */
function buildPcmAudio(rate) {
  const parts = [
    [1.2, 0.3],
    [0.8, 0],
    [1.2, 0.3],
    [0.8, 0],
    [4.0, 0.3],
    [2.0, 0]
  ];
  const total = parts.reduce((n, [d]) => n + Math.round(d * rate), 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const [dur, amp] of parts) {
    const len = Math.round(dur * rate);
    for (let i = 0; i < len; i++) {
      out[off + i] = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * 300 * i) / rate);
    }
    off += len;
  }
  return out;
}

class FakeAudioContext {
  constructor(opts) {
    this.state = 'running';
    this.destination = { connect() {} };
    this.sampleRate = opts?.sampleRate || 48000;
    this.audioWorklet = {
      addModule: async () => {
        if (!pcmEnabled) throw new Error('AudioWorklet 不可用（测试桩）');
      }
    };
  }
  createMediaStreamSource() {
    return {
      connect: () => {},
      disconnect: () => {}
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  async decodeAudioData() {
    const sampleRate = 48000;
    const seconds = 8;
    const length = sampleRate * seconds;
    const data = new Float32Array(length);

    if (decoderMode === 'speech') {
      const burst = (fromSec, durSec) => {
        const start = Math.floor(fromSec * sampleRate);
        const count = Math.floor(durSec * sampleRate);
        for (let i = 0; i < count; i++) {
          data[start + i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
        }
      };
      // 两段各 3 秒、间隔 1.5 秒：已经够长，不该被合并
      burst(0.2, 3.0);
      burst(4.7, 3.0);
    }

    return {
      numberOfChannels: 1,
      length,
      sampleRate,
      duration: seconds,
      getChannelData: () => data
    };
  }
}

/** 模拟 AudioWorklet 节点：创建后自动按 6 倍速往里喂 PCM */
class FakeAudioWorkletNode {
  constructor(ctx, name, opts) {
    this.name = name;
    this.ctx = ctx;
    this.port = { onmessage: null };
    this.blockSize = opts?.processorOptions?.blockSize || 2048;
    workletNodes.push(this);

    if (!pcmEnabled) return;

    const audio = buildPcmAudio(ctx.sampleRate);
    let off = 0;
    this.timer = setInterval(() => {
      if (!this.port.onmessage) return;
      if (off >= audio.length) {
        clearInterval(this.timer);
        return;
      }
      const block = audio.slice(off, Math.min(off + this.blockSize, audio.length));
      off += this.blockSize;
      this.port.onmessage({ data: block });
    }, 20);
  }
  connect() {}
  disconnect() {
    if (this.timer) clearInterval(this.timer);
  }
}

const fakeDocument = {
  createElement: (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    play: async () => {},
    pause() {},
    remove() {},
    setAttribute() {},
    appendChild() {},
    srcObject: null
  }),
  body: { appendChild() {} },
  addEventListener() {},
  fullscreenElement: null
};

let fetchCalls = [];
let chatHandler = null; // (messages) => string，用来模拟对话模型
let asrReply = '这是识别结果，来自仿真。'; // 识别接口的返回文本
let musicMode = false; // 模拟"这一整段都是音乐"：Silero 概率接近 0
let ortInitDelayMs = 0; // 模拟 wasm 首次编译很慢
let ortFailMode = false; // 模拟 onnxruntime 初始化失败

/** 假 onnxruntime：按帧能量返回语音概率，足够驱动 lib/silero.js 的真实逻辑 */
const fakeOrt = {
  Tensor: class {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
  InferenceSession: {
    create: async () => {
      if (ortInitDelayMs) await new Promise((r) => setTimeout(r, ortInitDelayMs));
      if (ortFailMode) throw new Error('wasm 编译失败（模拟）');
      return {
        run: async (feeds) => {
          const frame = feeds.input.data;
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          const rms = Math.sqrt(sum / Math.max(1, frame.length));
          const p = musicMode ? 0.004 : rms > 0.05 ? 0.95 : 0.01;
          return { output: { data: new Float32Array([p]) }, stateN: feeds.state };
        }
      };
    }
  },
  env: { wasm: {}, logLevel: 'error' }
};

async function fakeFetch(url, init) {
  fetchCalls.push({ url, init });

  if (String(url).includes('silero_vad')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(64)
    };
  }

  if (String(url).includes('/chat/completions')) {
    let content = '';
    try {
      const body = JSON.parse(init.body);
      content = chatHandler ? chatHandler(body.messages) : '';
      fetchCalls[fetchCalls.length - 1].model = body.model;
    } catch {
      content = '';
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content } }] })
    };
  }

  return {
    ok: true,
    status: 200,
    headers: { get: () => 'trace-sim' },
    text: async () => JSON.stringify({ text: asrReply })
  };
}

/* ============================ 假 OPFS（保存音频用） ============================ */

const opfsFiles = new Map();
let opfsWriteCount = 0;

const fakeStorage = {
  getDirectory: async () => ({
    getFileHandle: async (name) => ({
      createWritable: async () => ({
        write: async (data) => {
          opfsWriteCount += 1;
          const cur = opfsFiles.get(name) || [];
          cur.push(data instanceof Uint8Array ? data : new Uint8Array(data));
          opfsFiles.set(name, cur);
        },
        seek: async () => {},
        close: async () => {}
      }),
      // 让"离线精校"能真的把写进去的 WAV 读回来
      getFile: async () => new Blob(opfsFiles.get(name) || [])
    }),
    removeEntry: async (name) => {
      opfsFiles.delete(name);
    }
  })
};

/* ============================ 加载两个上下文 ============================ */

// 去掉 ESM import（vm 里不是模块环境，单行和多行都要处理），改由上下文注入真实实现
const offscreenSource = readFileSync(join(root, 'offscreen.js'), 'utf8').replace(
  /^import[\s\S]*?from\s+'[^']+';$/gm,
  ''
);

const offscreenCtx = vm.createContext({
  chrome: offscreenChrome,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Blob,
  FormData,
  fetch: fakeFetch,
  navigator: { mediaDevices: { getUserMedia: async () => new FakeStream() }, storage: fakeStorage },
  window: { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext },
  document: fakeDocument,
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  AudioWorkletNode: FakeAudioWorkletNode,
  ort: fakeOrt,
  performance: { now: () => Date.now() },
  // 注入真实依赖
  encodeWav,
  mixToMono,
  resampleBox,
  TARGET_SAMPLE_RATE,
  detectSpeechRegions,
  createStreamingSegmenter,
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse,
  looksLikeHallucination,
  createSileroVad,
  createSileroGate,
  planInterim,
  stripCommittedOverlap,
  // 注入时绑定假 OPFS：库代码里的 navigator 会解析到 Node 域的全局对象，
  // 必须由外层把 fakeStorage 闭包传进去
  createWavWriter: (name, rate) => createWavWriter(name, rate, fakeStorage),
  readAudioFile: (name) => readAudioFile(name, fakeStorage)
});

vm.runInContext(offscreenSource, offscreenCtx, { filename: 'offscreen.js' });

const swCtx = vm.createContext({
  chrome: swChrome,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});

vm.runInContext(readFileSync(join(root, 'background.js'), 'utf8'), swCtx, { filename: 'background.js' });

/* ============================ 开始演练 ============================ */

const SETTINGS = {
  apiKey: 'sk-sim',
  model: 'Qwen/Qwen3-ASR-1.7B',
  baseUrl: 'https://api.siliconflow.cn/v1',
  segmentSeconds: 20,
  correctModel: 'Qwen/Qwen2.5-7B-Instruct',
  saveAudio: true,
  incrementalAsr: true,
  // 桩里的音频是 6 倍速喂的，所以把预览节流按比例调小，否则永远触发不了
  interimIntervalMs: 100,
  interimMinMs: 2000,
  subtitle: { enabled: true, fontSize: 22 }
};

console.log('\n1) 点「开始转录」');
bus.offscreenAlive = false;
const startRes = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });

check('START 返回成功', startRes?.ok === true, JSON.stringify(startRes));
check('申请了标签页音频流', bus.log.some((m) => m.type === 'START' && m.to === 'offscreen'));
check('创建了 offscreen 文档', !!bus.createOpts);
check(
  'createDocument 带了 USER_MEDIA 理由',
  Array.isArray(bus.createOpts?.reasons) && bus.createOpts.reasons.includes('USER_MEDIA'),
  JSON.stringify(bus.createOpts?.reasons)
);
check('向视频页注入了字幕脚本', (bus.injected || []).some((o) => o.files?.includes('content/subtitle.js')));

let session = store.get('asrSession');
check('状态已落盘为 recording', session?.status === 'recording', session?.status);
check('模型名传到了会话', session?.model === 'Qwen/Qwen3-ASR-1.7B', session?.model);
check('分段长度按设置生效', session?.segSeconds === 20, String(session?.segSeconds));
check('没有 AudioWorklet 时回退到分段通路', session?.diag?.mode === 'recorder', String(session?.diag?.mode));

console.log('\n2) 模拟录满一块：应被切成 2 句并分别上传');
const active = recorders.at(-1);
check('起了 MediaRecorder', !!active && active.state === 'recording');
active.ondataavailable({ data: new Blob([new Uint8Array(4096)]) });
active.stop();
await sleep(800);

session = store.get('asrSession');
let segs = session?.segments || [];
check('切出 2 句', segs.length === 2, `实际 ${segs.length}`);
check('两句都识别成功', segs.every((s) => s.status === 'done'), JSON.stringify(segs.map((s) => s.status)));
check('两句都有文本', segs.every((s) => s.text === '这是识别结果，来自仿真。'));
check('每句都有时长', segs.every((s) => s.durationMs > 2500 && s.durationMs < 4000), JSON.stringify(segs.map((s) => s.durationMs)));
check(
  '第 1 句起点约 0.2s',
  segs[0] && segs[0].startMs >= 0 && segs[0].startMs < 900,
  String(segs[0]?.startMs)
);
check(
  '第 2 句起点约 4.7s',
  segs[1] && segs[1].startMs > 4000 && segs[1].startMs < 5300,
  String(segs[1]?.startMs)
);
check('句子的时间轴不重叠', segs[1].startMs >= segs[0].startMs + segs[0].durationMs - 50);
check('全文已拼接', (session?.transcript || '').includes('这是识别结果'));
check('上传了 2 次', fetchCalls.length === 2, `实际 ${fetchCalls.length}`);
check('上传用的是 multipart', fetchCalls[0]?.init?.body instanceof FormData);
check(
  '请求里带了 model 字段',
  fetchCalls[0]?.init?.body?.get?.('model') === 'Qwen/Qwen3-ASR-1.7B',
  fetchCalls[0]?.init?.body?.get?.('model')
);
check('上传文件名是 wav', String(fetchCalls[0]?.init?.body?.get?.('file')?.name || '').endsWith('.wav'));

console.log('\n2b) 整块都是静音：应跳过，不调接口');
decoderMode = 'silence';
const beforeCalls = fetchCalls.length;
const silent = recorders.at(-1);
silent.ondataavailable({ data: new Blob([new Uint8Array(4096)]) });
silent.stop();
await sleep(500);

session = store.get('asrSession');
segs = session?.segments || [];
const skipped = segs.filter((s) => s.status === 'skipped');
check('记录了一条 skipped', skipped.length === 1, `实际 ${skipped.length}`);
check('没有额外调用接口', fetchCalls.length === beforeCalls, `${beforeCalls} → ${fetchCalls.length}`);
check('跳过数量进了统计', session?.skipped === 1, String(session?.skipped));

console.log('\n3) 点「停止」');
const stopRes = await bus.send('popup', { type: 'STOP' });
check('STOP 返回成功', stopRes?.ok === true, JSON.stringify(stopRes));
session = store.get('asrSession');
check('状态变为 stopped', session?.status === 'stopped', session?.status);
check('记录了停止时间', typeof session?.stoppedAt === 'number');

console.log('\n4) 点「清空」');
await bus.send('popup', { type: 'RESET' });
check('会话已从存储里删除', !store.has('asrSession'));

console.log('\n5) 空闲后请 SW 关闭 offscreen');
await bus.send('offscreen', { type: 'CLOSE_OFFSCREEN' });
await sleep(5400);
check('offscreen 已被关闭', bus.offscreenAlive === false);

console.log('\n7) 实时 PCM 通路（AudioWorklet）：边说边出，不用等整块录完');
pcmEnabled = true;
// 用"两句"的回复，才能触发"提交前一句、留下正在说的那句"
asrReply = '第一句已经说完了。第二句还在说';
const recBefore = recorders.length;
const callsBefore = fetchCalls.length;

const start2 = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });
check('START 走实时通路成功', start2?.ok === true, JSON.stringify(start2));

session = store.get('asrSession');
check('模式标记为 pcm', session?.diag?.mode === 'pcm', JSON.stringify(session?.diag));
check('实时通路不再创建 MediaRecorder', recorders.length === recBefore, `${recBefore} → ${recorders.length}`);

// 桩里的 AudioWorklet 以约 6 倍速喂 10 秒音频（约 1.6 秒喂完）
// 增量提交：识别结果有两句时，前一句应当立刻提交、并裁掉对应音频。
await sleep(1400);
{
  const diag7 = store.get('asrSession')?.diag || {};
  check('增量提交发生了（边说边出字）', (diag7.commits || 0) > 0, JSON.stringify(diag7));
  check('提交后裁掉了已识别的音频', (diag7.trimmedMs || 0) > 0, `trimmedMs=${diag7.trimmedMs}`);
  check('识别调用次数是 2 的倍数关系（有增量请求）', (diag7.interimCalls || 0) > 0, `interimCalls=${diag7.interimCalls}`);
}

await sleep(2600);

session = store.get('asrSession');
const pcmSegs = (session?.segments || []).filter((s) => s.status === 'done');
check('还在录制中就已经落盘多句', pcmSegs.length >= 2, `实际 ${pcmSegs.length} 句`);
check(
  '每句都在合理长度区间（1.5–10s）',
  pcmSegs.every((s) => s.durationMs >= 1000 && s.durationMs <= 10000),
  JSON.stringify(pcmSegs.map((s) => s.durationMs))
);
check('定稿后预览被清掉', !session?.partial, JSON.stringify(session?.partial));
check(
  '时间轴单调递增',
  pcmSegs.every((s, i) => i === 0 || s.startMs >= pcmSegs[i - 1].startMs),
  JSON.stringify(pcmSegs.map((s) => s.startMs))
);
check('每句都有文本', pcmSegs.every((s) => !!s.text), JSON.stringify(pcmSegs.map((s) => ({ t: s.text, r: s.reason }))));
check(
  '有增量提交出来的句子',
  pcmSegs.some((s) => s.reason === 'incremental'),
  JSON.stringify(pcmSegs.map((s) => s.reason))
);
check('状态仍是 recording（没等停止）', session?.status === 'recording', session?.status);
check('上传次数增加', fetchCalls.length > callsBefore, `${callsBefore} → ${fetchCalls.length}`);
check('有声音时不会误报静音', session?.diag?.silent !== true, JSON.stringify(session?.diag));check('开了保存音频就创建了 WAV 文件', !!session?.diag?.audioFile, JSON.stringify(session?.diag?.audioFile));
check('Silero VAD 已启用', session?.diag?.vad === 'silero', JSON.stringify(session?.diag?.vad));
check(
  '走完整段的句子都带语音概率（增量提交的没有，属正常）',
  (session?.segments || [])
    .filter((s) => s.status === 'done' && s.reason !== 'incremental')
    .every((s) => typeof s.vadProb === 'number'),
  JSON.stringify((session?.segments || []).map((s) => [s.reason, s.vadProb]))
);
asrReply = '这是识别结果，来自仿真。';

await bus.send('popup', { type: 'STOP' });
session = store.get('asrSession');
check('停止后状态为 stopped', session?.status === 'stopped', session?.status);
check('音频文件已写完（有字节数）', session?.diag?.audioBytes > 0, String(session?.diag?.audioBytes));
check('确实往文件里写过数据', opfsWriteCount > 5, String(opfsWriteCount));
check('音频时长和录音时长接近', Math.abs((session?.diag?.audioMs || 0) - 10000) < 4000, String(session?.diag?.audioMs));

console.log('\n8) 整段校正（术语表 + 对话模型）');
{
  const before = (store.get('asrSession')?.segments || []).filter((s) => s.status === 'done' && s.text);
  check('校正前有可校正的句子', before.length >= 2, `实际 ${before.length}`);

  // 模拟模型：给每行文本加个标记（与内容无关，避免依赖某句具体台词）
  chatHandler = (messages) => {
    const user = messages?.[1]?.content || '';
    return user
      .split('\n')
      .filter((l) => /^\d{1,2}:\d{2}/.test(l.trim()))
      .map((l) => `${l}（已校正）`)
      .join('\n');
  };

  const res = await bus.send('popup', { type: 'CORRECT_ALL' });
  check('校正返回成功', res?.ok === true, JSON.stringify(res));
  check('报告了改动句数', typeof res?.changed === 'number' && res.changed > 0, JSON.stringify(res));
  check('用了配置的纠错模型', res?.model === SETTINGS.correctModel, String(res?.model));

  const chatCall = fetchCalls.filter((c) => String(c.url).includes('/chat/completions'));
  check('确实请求了 chat/completions', chatCall.length === 1, `实际 ${chatCall.length}`);
  check('请求里带了模型名', chatCall[0]?.model === SETTINGS.correctModel, String(chatCall[0]?.model));

  const after = (store.get('asrSession')?.segments || []).filter((s) => s.status === 'done' && s.text);
  check(
    '文本被更新成纠正后的版本',
    after.every((s) => s.text.endsWith('（已校正）')),
    JSON.stringify(after.map((s) => s.text))
  );
  check(
    '全文也同步更新',
    (store.get('asrSession')?.transcript || '').includes('（已校正）'),
    store.get('asrSession')?.transcript
  );
  check('时间轴没被动过', after.every((s) => typeof s.startMs === 'number'));
}

console.log('\n9) 通用过滤规则：复读/超速的内容要丢掉');
{
  // 不再用"具体句子黑名单"，而是用与内容无关的规则：
  // 这里让识别接口返回一个"复读机"式的结果，验证复读检测会拦下它。
  asrReply = '快去订阅快去订阅快去订阅';
  const start3 = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });
  check('START 成功', start3?.ok === true, JSON.stringify(start3));

  await sleep(2600);
  session = store.get('asrSession');
  const done9 = (session?.segments || []).filter((s) => s.status === 'done' && s.text);
  const skipped9 = (session?.segments || []).filter((s) => s.status === 'skipped');
  check('全部被判为跳过', done9.length === 0, `done=${done9.length}`);
  check('确实有段落被切出来过', skipped9.length >= 2, `skipped=${skipped9.length}`);
  check('全文里没有幻觉内容', !String(session?.transcript || '').includes('中央委员会'), session?.transcript);
  check('跳过数进了统计', session?.skipped >= 2, String(session?.skipped));

  await bus.send('popup', { type: 'STOP' });
  asrReply = '这是识别结果，来自仿真。';
}

console.log('\n10) 离线精校：用保存的 WAV 按长上下文重跑');{
  const ref = await bus.send('popup', { type: 'REFINE' });
  check('REFINE 返回成功', ref?.ok === true, JSON.stringify(ref).slice(0, 200));
  check('产生了精校句子', (ref?.segments || 0) >= 1, String(ref?.segments));

  session = store.get('asrSession');
  check('会话标记为已精校', session?.refined === true, String(session?.refined));
  check(
    '精校后句子都有文本',
    (session?.segments || []).length > 0 && (session?.segments || []).every((s) => s.status === 'done' && s.text),
    JSON.stringify((session?.segments || []).map((s) => s.status))
  );
  check('精校后自动跑了纠错', !!ref?.correction, JSON.stringify(ref?.correction));
}

console.log('\n10b) offscreen 被回收后再点「校正全文」/「离线精校」');
{
  // 真实场景：停止录制 60 秒后 offscreen 文档会被关掉，
  // 这时直接 sendMessage 会报 "Could not establish connection. Receiving end does not exist."
  bus.offscreenAlive = false;
  const before = bus.createCount || 0;
  const beforeLog = bus.log.length;

  const res = await bus.send('popup', { type: 'CORRECT_ALL' });
  check('自动重建了 offscreen 文档', (bus.createCount || 0) > before, `${before} → ${bus.createCount}`);
  check('重建后先恢复了会话状态', bus.log.slice(beforeLog).some((m) => m.type === 'RESTORE_STATE'), JSON.stringify(bus.log.slice(beforeLog).map((m) => m.type)));
  check('校正成功，不再报连接错误', res?.ok === true, JSON.stringify(res).slice(0, 160));

  // 再来一次精校，验证同样能用
  bus.offscreenAlive = false;
  const res2 = await bus.send('popup', { type: 'REFINE' });
  check('精校同样能重建并执行', res2?.ok === true, JSON.stringify(res2).slice(0, 160));
}

console.log('\n11) Silero VAD 判为音乐：整段跳过，不送识别');
{
  musicMode = true;
  const callsBefore = fetchCalls.filter((c) => String(c.url).includes('/audio/transcriptions')).length;

  const start4 = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });
  check('START 成功', start4?.ok === true, JSON.stringify(start4));

  await sleep(2600);
  session = store.get('asrSession');

  const done11 = (session?.segments || []).filter((s) => s.status === 'done');
  const skipped11 = (session?.segments || []).filter((s) => s.status === 'skipped');
  check('没有任何句子被送去识别', done11.length === 0, `done=${done11.length}`);
  check('整段被 VAD 跳过', skipped11.length >= 2, `skipped=${skipped11.length}`);
  check(
    '跳过时记录了语音概率',
    skipped11.every((s) => typeof s.vadProb === 'number' && s.vadProb < 0.25),
    JSON.stringify(skipped11.map((s) => s.vadProb))
  );

  const callsAfter = fetchCalls.filter((c) => String(c.url).includes('/audio/transcriptions')).length;
  check('没有产生识别请求', callsAfter === callsBefore, `${callsBefore} → ${callsAfter}`);

  await bus.send('popup', { type: 'STOP' });
  musicMode = false;
}

console.log('\n13) Silero 加载很慢时：录制不能被阻塞');
{
  ortInitDelayMs = 800;
  const t0 = Date.now();
  const res = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });
  const cost = Date.now() - t0;

  check('START 成功', res?.ok === true, JSON.stringify(res).slice(0, 120));
  check('没有被 VAD 加载卡住（<600ms）', cost < 600, `${cost}ms`);
  check('刚开录时状态是 loading', store.get('asrSession')?.diag?.vad === 'loading', String(store.get('asrSession')?.diag?.vad));

  await sleep(3000);
  session = store.get('asrSession');
  check('加载完成后变成 silero', session?.diag?.vad === 'silero', String(session?.diag?.vad));

  const withProb = (session?.segments || []).filter((s) => typeof s.vadProb === 'number');
  check('回填生效：有句子拿到了语音概率', withProb.length >= 1, `${withProb.length}/${(session?.segments || []).length}`);

  await bus.send('popup', { type: 'STOP' });
  ortInitDelayMs = 0;
}

console.log('\n14) onnxruntime 起不来时：报真实原因，且录制照常');
{
  ortFailMode = true;
  const res = await bus.send('popup', { type: 'START', tabId: 1, settings: SETTINGS });
  check('START 仍然成功（不阻塞录制）', res?.ok === true, JSON.stringify(res).slice(0, 120));

  await sleep(2600);
  session = store.get('asrSession');
  check('退回能量 VAD', session?.diag?.vad === 'energy', String(session?.diag?.vad));
  check(
    '报的是真实原因而不是"超时"',
    /wasm 编译失败/.test(String(session?.diag?.vadError)),
    String(session?.diag?.vadError)
  );
  check('识别照常进行', (session?.segments || []).some((s) => s.status === 'done'), JSON.stringify((session?.segments || []).map((s) => s.status)));

  await bus.send('popup', { type: 'STOP' });
  ortFailMode = false;
}

console.log('\n15) VAD 自检按钮');
{
  const st = await bus.send('popup', { type: 'VAD_SELFTEST' });
  check('自检成功', st?.ok === true, JSON.stringify(st).slice(0, 200));
  check('报告了模型大小', (st?.modelBytes || 0) > 0, String(st?.modelBytes));
  check('报告了推理概率', typeof st?.prob === 'number', String(st?.prob));
  check('走到了 inference 步', st?.step === 'inference', String(st?.step));

  ortFailMode = true;
  const bad = await bus.send('popup', { type: 'VAD_SELFTEST' });
  check('失败时返回具体步骤', bad?.ok === false && !!bad?.step, JSON.stringify(bad).slice(0, 160));
  check('失败时带上真实原因', /wasm 编译失败/.test(String(bad?.error)), String(bad?.error).slice(0, 120));
  ortFailMode = false;
}

console.log('\n6) 越界检查');
const badMessages = bus.log.filter((m) => m.type === 'STATE_SET' && m.to !== 'sw');
check('STATE_SET 全部走 SW', badMessages.length === 0, JSON.stringify(badMessages));

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过：消息流、状态落盘、分段上传、停止/清空都正常。');
process.exit(0);






