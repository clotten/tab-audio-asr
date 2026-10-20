/**
 * offscreen.js —— 真正的干活的文件
 *
 * 流水线：
 *   tabCapture 音频流
 *     → MediaRecorder 每 N 秒切一个独立 webm 片段（不设 timeslice，保证每段都能单独解码）
 *     → decodeAudioData 解码 → 混单声道 → 降采样 16k → 编码 WAV
 *     → fetch POST /v1/audio/transcriptions（串行队列 + 失败重试）
 *     → 文本按顺序追加，写进 chrome.storage.local，popup 实时读取
 *
 * 为什么放在 offscreen：Service Worker 里没有 MediaRecorder / Web Audio，而且
 * 30 秒空闲就会被回收；offscreen 文档是有生命周期的扩展页面，能撑住 1 小时的录音。
 */

import { encodeWav, mixToMono, resampleBox, TARGET_SAMPLE_RATE } from './lib/wav.js';
import { createWavWriter, readAudioFile } from './lib/audiofile.js';
import { looksLikeHallucination } from './lib/hallucination.js';
import { createSileroVad, createSileroGate } from './lib/silero.js';
import { planInterim, stripCommittedOverlap } from './lib/incremental.js';
import { detectSpeechRegions, createStreamingSegmenter } from './lib/vad.js';
import {
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse
} from './lib/glossary.js';

const TARGET_RATE = TARGET_SAMPLE_RATE;

/**
 * ⚠️ 关键约束：offscreen 文档里**只有 chrome.runtime**。
 * Chrome 官方文档明确写了"仅向屏幕外文档公开 chrome.runtime Messaging API"，
 * 也就是说这里没有 chrome.storage —— 写了就是 `Cannot read properties of undefined (reading 'local')`。
 * 所以：状态留在内存里，落盘全部通过消息交给 Service Worker。
 */

const DEFAULTS = {
  apiKey: '',
  model: 'Qwen/Qwen3-ASR-1.7B',
  baseUrl: 'https://api.siliconflow.cn/v1',
  segmentSeconds: 20,
  maxChunkMs: 10000,      // 单句上限：超过就在能量最低处切开，保证字幕粒度
  mutePlayback: false,    // 静音录制：捕获声音但不回放到扬声器
  saveAudio: false,       // 同时把音频存成 WAV（收尾后可在弹窗里下载）
  incrementalAsr: true,   // 增量识别：说话过程中先出临时预览（边说边出字）
  interimIntervalMs: 2000,  // 两次预览之间至少隔这么久
  interimMinMs: 1800,       // 这句至少说了这么久才值得预览
  sileroVad: true,        // 用 Silero VAD 判别"这段是不是人声"（拦掉音乐/掌声）
  vadThreshold: 0.25,     // 段平均语音概率低于这个值就丢掉
  correctModel: 'Qwen/Qwen2.5-7B-Instruct', // 事后纠错用的对话模型（实测最快且不乱编）
  glossary: '',           // 空 = 用内置默认术语表
  subtitle: { enabled: true, fontSize: 15 }
};

/** 第一段故意录短一点，让第一句文字尽快出来 */
const FIRST_SEGMENT_SECONDS = 6;

const MIN_SEG_SECONDS = 10;
const MAX_SEG_SECONDS = 600;

/* ---------------------------- 运行时状态 ---------------------------- */

let settings = { ...DEFAULTS };
let state = null;            // 对外发布到 storage 的会话状态
let stream = null;           // 捕获到的标签页音频流
let monitorEl = null;        // 用来把声音放回给用户听的 <audio>（兜底方案）
let monitorCtx = null;       // 用来把声音放回给用户听的 AudioContext（首选方案）
let recorder = null;         // 当前分段的 MediaRecorder
let segTimer = null;
let decodeCtx = null;
let segCounter = 0;
let chunkSeq = 0;            // 第几个录音块（用来让第一块短一点）
let uploadChain = Promise.resolve();

// 实时 PCM 通路（首选）：AudioWorklet 直取采样，边收边切句
let pcmCtx = null;
let pcmNode = null;
let pcmSource = null;
let pcmSink = null;
let segmenter = null;
let segmenterRate = 0;
let pcmOffsetMs = 0;
let pcmBlocks = 0;
let silentRunMs = 0;   // 连续静音了多久（用来提示"页面被暂停/静音了"）

// 同时保存音频（可选）
let audioWriter = null;
let audioChain = Promise.resolve();

// 增量识别（边说边出字）：同一时刻只跑一个预览请求
let lastInterimAt = 0;
let interimBusy = false;
let finalsPending = 0; // 队列里还有没传完的定稿时，跳过预览（定稿优先，别抢请求）

// 增量提交的状态：已提交文本尾巴（去重用）、攒下的碎片、是否已提交过
let interimTail = '';
let interimPending = '';
let interimActive = false;

// Silero VAD（可选）：判别"这段是不是人声"，用来拦掉音乐/掌声被送去识别
let sileroVad = null;
let sileroGate = null;
let sileroStatus = 'idle'; // idle | loading | ready | failed
// 加载期间先把 PCM 存着，加载完补喂进去（片头音乐就在这段里，不能漏）
let pcmBacklog = [];
let pcmBacklogSamples = 0;
const BACKLOG_MAX_SAMPLES = 48000 * 3 * 60; // 最多缓存 3 分钟
let saveTimer = null;
let closeTimer = null;

/* ---------------------------- 小工具 ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给可能永远 pending 的 Promise 加个上限，防止启动流程被卡死 */
function withTimeout(promise, ms) {
  return Promise.race([Promise.resolve(promise).catch(() => {}), sleep(ms)]);
}

function clampSegment(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.segmentSeconds;
  return Math.min(MAX_SEG_SECONDS, Math.max(MIN_SEG_SECONDS, Math.round(n)));
}

/** 给 Service Worker 发消息（offscreen 唯一能用的扩展 API 就是它） */
function notifySw(payload) {
  return chrome.runtime.sendMessage({ target: 'background', ...payload }).catch(() => null);
}

function saveSoon(delay = 200) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState().catch(() => {});
  }, delay);
}

async function saveState() {
  if (!state) return;
  const segs = state.segments || [];
  state.pending = segs.filter((s) => s.status === 'uploading').length;
  state.done = segs.filter((s) => s.status === 'done').length;
  state.failed = segs.filter((s) => s.status === 'error').length;
  state.skipped = segs.filter((s) => s.status === 'skipped').length;
  state.transcript = segs
    .filter((s) => s.status === 'done' && s.text)
    .map((s) => s.text)
    .join('\n');
  state.updatedAt = Date.now();
  await notifySw({ type: 'STATE_SET', state });
}

function noteError(message) {
  if (!state) return;
  state.lastError = message;
  saveSoon(0);
}

/* ---------------------------- 开始 ---------------------------- */

/**
 * 把捕获到的音频重新接到扬声器上。
 * 不做这一步，用户看视频时会突然没声音——这是 tabCapture 最容易被忽略的副作用。
 */
async function setupMonitor() {
  if (!stream || !state) return;

  // 静音录制：故意不把声音接回扬声器。tabCapture 已经把音频从扬声器"借走"了，
  // 不回放就等于用户听不到、但音频照样进麦克风——这正是"想静音播放又想要文字"的场景。
  if (settings.mutePlayback) {
    state.mutedPlayback = true;
    return;
  }

  /* 首选：Web Audio 直接把流接到输出设备 */
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    monitorCtx = new Ctx();
    const source = monitorCtx.createMediaStreamSource(stream);
    source.connect(monitorCtx.destination);
    if (monitorCtx.state !== 'running') {
      // 注意：被自动播放策略挡住时 resume() 可能一直 pending，必须限时，不能把启动流程卡死
      await withTimeout(monitorCtx.resume(), 500);
    }
    if (monitorCtx.state === 'running') return;
    // 没跑起来（多见于自动播放策略限制），关掉走兜底
    await monitorCtx.close().catch(() => {});
    monitorCtx = null;
  } catch {
    monitorCtx = null;
  }

  // 兜底：<audio> 元素直接播这个流
  try {
    monitorEl = document.createElement('audio');
    monitorEl.srcObject = stream;
    monitorEl.autoplay = true;
    monitorEl.volume = 1;
    document.body.appendChild(monitorEl);
    await withTimeout(monitorEl.play(), 800);
  } catch (err) {
    // 回放失败只影响"能不能听见"，不影响录制本身
    state.monitorMuted = true;
    state.lastError = `音频回放被拦截（录制不受影响）：${err?.message || err}`;
    saveSoon(0);
  }
}

/* ---------------------------- Silero VAD ---------------------------- */

function vadThreshold() {
  const t = Number(settings.vadThreshold);
  return Number.isFinite(t) && t > 0 && t < 1 ? t : DEFAULTS.vadThreshold;
}

/**
 * 后台加载 Silero，**不阻塞录制**。
 *
 * 之前的写法是 `await withTimeout(initSilero(), 8000)`，两个问题：
 *   1. 15.9MB 的 wasm + 2.2MB 模型首次加载经常超过 8 秒 → 回退成能量 VAD；
 *   2. withTimeout 会把真实报错吞成"超时"，排查时看不到原因。
 * 现在：先开录，加载期间把 PCM 缓存下来，就绪后回填——片头音乐那段也不会漏。
 */
function startSileroLoad() {
  if (!state) return;

  if (settings.sileroVad === false) {
    sileroStatus = 'failed';
    state.diag.vad = 'energy';
    state.diag.vadError = '已关闭';
    return;
  }

  sileroStatus = 'loading';
  state.diag.vad = 'loading';

  const timeout = sleep(30000).then(() => {
    throw new Error('初始化超时（30 秒）');
  });

  Promise.race([initSilero(), timeout])
    .then(() => {
      sileroStatus = 'ready';
      if (!state) return;
      state.diag.vad = 'silero';
      delete state.diag.vadError;

      // 回填等待期间的音频
      const backlog = pcmBacklog;
      pcmBacklog = [];
      pcmBacklogSamples = 0;
      if (sileroGate) for (const block of backlog) sileroGate.push(block);

      saveSoon(0);
    })
    .catch((err) => {
      sileroStatus = 'failed';
      sileroGate = null;
      sileroVad = null;
      pcmBacklog = [];
      pcmBacklogSamples = 0;
      if (state) {
        state.diag.vad = 'energy';
        state.diag.vadError = String(err?.message || err).slice(0, 160);
        saveSoon(0);
      }
    });
}
async function initSilero() {
  if (settings.sileroVad === false) return;

  const ortGlobal = globalThis.ort;
  if (!ortGlobal?.InferenceSession) throw new Error('onnxruntime 未加载');

  // ORT 1.30 的 wasm 后端先动态 import 一个 .mjs 加载器，再由它去取 .wasm。
  // 两个文件的名字必须对得上，且都得打包进 vendor/（漏过 .mjs，报 "Failed to fetch dynamically imported module"）。
  const base = chrome.runtime.getURL('vendor/');
  ortGlobal.env.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.wasm`
  };
  ortGlobal.env.wasm.numThreads = 1; // 没有 COOP/COEP，用单线程
  try {
    ortGlobal.env.logLevel = 'error';
  } catch {
    /* 老版本可能没有这个字段 */
  }

  const res = await fetch(chrome.runtime.getURL('vendor/silero_vad_v5.onnx'));
  if (!res.ok) throw new Error(`模型加载失败 HTTP ${res.status}`);

  const modelBuffer = await res.arrayBuffer();
  const rate = segmenterRate || TARGET_RATE;

  sileroVad = await createSileroVad({ ort: ortGlobal, modelBuffer, sampleRate: rate });
  sileroGate = createSileroGate({ vad: sileroVad, sampleRate: rate });
}

/* ---------------------------- 实时 PCM 通路 ---------------------------- */

/**
 * 用 AudioWorklet 直接拿 16k PCM，边收边切句：一句说完（停顿 600ms）就立刻上传，
 * 不用再等"整块 20 秒录完"。这是把出字延迟从最多 19 秒压到 1 秒级的关键。
 */
async function startPcmCapture() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  pcmCtx = new Ctx({ sampleRate: TARGET_RATE });
  segmenterRate = pcmCtx.sampleRate || TARGET_RATE;

  await pcmCtx.audioWorklet.addModule('lib/pcm-worklet.js');

  pcmSource = pcmCtx.createMediaStreamSource(stream);
  pcmNode = new AudioWorkletNode(pcmCtx, 'pcm-tap', { processorOptions: { blockSize: 2048 } });

  // 关键：必须连到 destination（这里用 0 增益），否则节点不会被拉取处理
  pcmSink = pcmCtx.createGain();
  pcmSink.gain.value = 0;
  pcmNode.connect(pcmSink);
  pcmSink.connect(pcmCtx.destination);

  segmenter = createStreamingSegmenter(segmenterRate, {});
  pcmOffsetMs = Date.now() - state.startedAt;
  pcmBlocks = 0;
  silentRunMs = 0;

  // 可选：同时把音频写进 WAV 文件（边录边写，不占内存）
  if (settings.saveAudio) {
    try {
      const name = `tab-audio-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      audioWriter = await createWavWriter(name, segmenterRate);
      state.diag.audioFile = name;
    } catch (err) {
      state.diag.saveAudioError = String(err?.message || err).slice(0, 160);
    }
  }

  // 加载 Silero：后台进行，不阻塞录制（就绪后会回填这段期间的音频）
  startSileroLoad();

  let markFirst = null;
  const firstBlock = new Promise((resolve) => {
    markFirst = resolve;
  });

  pcmNode.port.onmessage = (event) => {
    if (markFirst) {
      markFirst();
      markFirst = null;
    }
    handlePcm(event.data);
  };

  pcmSource.connect(pcmNode);

  if (pcmCtx.state !== 'running') {
    await withTimeout(pcmCtx.resume(), 500);
  }

  // 等第一块数据：拿不到说明上下文被挂起（自动播放策略），交给上层回退
  await withTimeout(firstBlock, 2500);
  if (!pcmBlocks) throw new Error(`没有收到 PCM 数据（context=${pcmCtx.state}）`);
}

function handlePcm(block) {
  if (!state || state.status !== 'recording' || !segmenter) return;
  pcmBlocks += 1;

  // 静音检测：切成别的标签页后，被捕获的页面可能被暂停/静音，
  // 这时候 VAD 什么都不会产出，用户会以为插件坏了。这里持续盯能量。
  const blockMs = (block.length / (segmenterRate || TARGET_RATE)) * 1000;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  const rms = Math.sqrt(sum / Math.max(1, block.length));

  if (rms < 0.002) {
    silentRunMs += blockMs;
    state.diag.silentMs = Math.round(silentRunMs);
  } else {
    silentRunMs = 0;
    state.diag.silentMs = 0;
  }

  const silent = silentRunMs > 8000;
  if (silent !== !!state.diag.silent) {
    state.diag.silent = silent;
    saveSoon(0);
  }

  // 写盘也走串行链，避免 100ms 一块的写入抢 I/O
  if (audioWriter) {
    const w = audioWriter;
    audioChain = audioChain
      .then(() => w.write(block))
      .catch((err) => {
        if (state) state.diag.saveAudioError = String(err?.message || err).slice(0, 160);
      });
  }

  // 送进 Silero：按帧算语音概率，事后按段判定
  if (sileroGate) {
    sileroGate.push(block);
  } else if (sileroStatus === 'loading') {
    // 模型还在加载：先把音频存着，就绪后回填（片头音乐就在这段里，不能漏）
    pcmBacklog.push(block);
    pcmBacklogSamples += block.length;
    while (pcmBacklogSamples > BACKLOG_MAX_SAMPLES && pcmBacklog.length > 1) {
      pcmBacklogSamples -= pcmBacklog.shift().length;
    }
  }

  const emitted = segmenter.push(block);

  // 语音还在继续、但一句还没说完 → 先出个临时预览
  maybeInterim();

  for (const seg of emitted) enqueuePcmSegment(seg);
}

/* ---------------------------- 增量识别（预览） ---------------------------- */

const interimIntervalMs = () => Math.max(1000, Number(settings.interimIntervalMs) || DEFAULTS.interimIntervalMs);
const interimMinMs = () => Math.max(600, Number(settings.interimMinMs) || DEFAULTS.interimMinMs);

/**
 * 增量识别（边说边出字）—— 借鉴 LiveTranslate 的增量 ASR。
 *
 * 和"只做预览"的区别：识别结果里**除了最后一句**（还在说）之外都已经完整了，
 * 所以可以直接提交进正文，并把对应音频从缓冲头部剪掉（trimFront）。
 * 好处是长段独白也能一句一句地出字，而且切点由**文本标点**决定，
 * 不会像能量法那样把句子从中间切断（那正是"定稿比预览还差"的根因）。
 *
 * 防重复靠两件事：剪掉已提交的音频 + 记住已提交的文本尾巴做去重。
 */
function maybeInterim() {
  if (settings.incrementalAsr === false) return;
  if (!state || state.status !== 'recording') return;
  if (interimBusy || !segmenter?.peek) return;
  if (finalsPending > 0) return; // 定稿优先，预览别抢请求配额

  const now = Date.now();
  if (now - lastInterimAt < interimIntervalMs()) return;

  const peek = segmenter.peek();
  if (!peek || peek.durationMs < interimMinMs()) return;

  lastInterimAt = now;
  interimBusy = true;

  const wav = new Blob([encodeWav(peek.samples, TARGET_RATE)], { type: 'audio/wav' });

  (async () => {
    try {
      if (state) state.diag.interimCalls = (state.diag.interimCalls || 0) + 1;

      // 先问 Silero：这段要是音乐/噪声，就别浪费一次请求
      if (sileroGate) {
        const p = await sileroGate.meanProb(peek.startMs, peek.startMs + peek.durationMs);
        if (p != null && p < vadThreshold()) return;
      }

      const raw = await callTranscribe(wav, -1);
      if (!state || state.status !== 'recording') return;

      const text = acceptText(raw, peek.durationMs);
      if (!text) {
        state.diag.interimRejected = (state.diag.interimRejected || 0) + 1;
        return;
      }

      const plan = planInterim({
        text,
        committedTail: interimTail,
        bufferStartMs: pcmOffsetMs + peek.startMs,
        bufferDurationMs: peek.durationMs,
        pending: interimPending
      });

      for (const c of plan.commits) {
        pushItem({
          startMs: c.startMs,
          durationMs: c.durationMs,
          status: 'done',
          text: c.text,
          reason: 'incremental'
        });
      }

      if (plan.commits.length) {
        state.diag.commits = (state.diag.commits || 0) + plan.commits.length;
        interimTail = plan.tail;
        interimPending = plan.pending;
        interimActive = true;

        if (plan.trimMs > 0) {
          const cut = segmenter.trimFront(Math.round((plan.trimMs / 1000) * TARGET_RATE));
          if (cut > 0) state.diag.trimmedMs = (state.diag.trimmedMs || 0) + Math.round((cut / TARGET_RATE) * 1000);
        }
      }

      // 最后一句还在说：显示成灰色预览，等这句说完会被定稿覆盖
      const last = plan.commits[plan.commits.length - 1];
      state.partial = plan.remainder
        ? {
            text: plan.remainder,
            startMs: last ? last.startMs + last.durationMs : Math.round(pcmOffsetMs + peek.startMs),
            durationMs: 0
          }
        : null;

      saveSoon(0);
    } catch {
      /* 预览失败无所谓，定稿还会再来一次 */
    } finally {
      interimBusy = false;
    }
  })();
}

/** 增量提交过之后，把"尾巴识别结果"拼成最终一句：去重叠 + 接碎片 */
function joinRemainder(raw, tail, pending) {
  const stripped = stripCommittedOverlap(String(raw || '').trim(), tail || '');
  const head = pending || '';
  if (!stripped) return head;
  return head ? head + stripped : stripped;
}

function resetInterim() {
  interimTail = '';
  interimPending = '';
  interimActive = false;
}

function releasePcm() {
  try {
    if (pcmNode) {
      pcmNode.port.onmessage = null;
      pcmNode.disconnect();
    }
  } catch {
    /* ignore */
  }
  try {
    if (pcmSource) pcmSource.disconnect();
    if (pcmSink) pcmSink.disconnect();
  } catch {
    /* ignore */
  }
  try {
    if (pcmCtx) pcmCtx.close();
  } catch {
    /* ignore */
  }
  pcmCtx = null;
  pcmNode = null;
  pcmSource = null;
  pcmSink = null;
  segmenter = null;
  sileroGate = null;
  sileroVad = null;
  sileroStatus = 'idle';
  pcmBacklog = [];
  pcmBacklogSamples = 0;
}

/** 一段切好的音频 → 立刻编码上传（不进队列等待，只保持串行以免打爆限流） */
function enqueuePcmSegment(seg) {
  if (!state) return;

  let samples = seg.samples;
  if (segmenterRate && segmenterRate !== TARGET_RATE) {
    samples = resampleBox(samples, segmenterRate, TARGET_RATE);
  }

  const wav = new Blob([encodeWav(samples, TARGET_RATE)], { type: 'audio/wav' });
  const item = pushItem({
    startMs: Math.round(pcmOffsetMs + seg.startMs),
    durationMs: seg.durationMs,
    status: 'uploading',
    reason: seg.reason
  });
  item.bytes = wav.size;
  // 定稿来了，正在说的那句就不算"预览"了
  state.partial = null;
  finalsPending += 1;
  lastInterimAt = 0;
  saveSoon(0);

  uploadChain = uploadChain
    .then(async () => {
      try {
        // 先问 Silero：这一段到底是不是人声？音乐/掌声直接丢，别送去识别
        if (sileroGate) {
          const p = await sileroGate.meanProb(seg.startMs, seg.startMs + seg.durationMs);
          if (p != null) {
            item.vadProb = Number(p.toFixed(3));
            if (p < vadThreshold()) {
              item.status = 'skipped';
              await saveState();
              return;
            }
          }
        }

        const raw = await callTranscribe(wav, item.index);
        item.raw = raw;

        // 增量提交已经出过一部分时，这段是"剩下的尾巴"：去掉重叠、接上攒的碎片
        let text = '';
        if (interimActive) {
          text = acceptText(joinRemainder(raw, interimTail, interimPending), item.durationMs);
          resetInterim();
        } else {
          text = acceptText(raw, item.durationMs);
        }

        if (text) {
          item.text = text;
          item.status = 'done';
        } else {
          // 静音/音乐上编出来的内容，直接丢掉
          item.status = 'skipped';
        }
      } catch (err) {
        item.status = 'error';
        item.error = String(err?.message || err);
        if (state) state.lastError = item.error;
      }
      await saveState();
    })
    .finally(() => {
      finalsPending = Math.max(0, finalsPending - 1);
    })
    .catch(() => {});
}

/**
 * VAD 自检：一步步走完"加载运行时 → 取模型 → 建会话 → 跑一帧推理"，
 * 失败时返回具体是哪一步挂的，省得靠猜。
 */
async function handleVadSelftest() {
  const out = { ok: false, step: 'start' };
  try {
    if (!globalThis.ort?.InferenceSession) {
      throw new Error('onnxruntime 未加载：vendor/ort.wasm.min.js 没载入（检查 offscreen.html）');
    }
    out.step = 'ort-loaded';

    const base = chrome.runtime.getURL('vendor/');
    globalThis.ort.env.wasm.wasmPaths = {
      mjs: `${base}ort-wasm-simd-threaded.mjs`,
      wasm: `${base}ort-wasm-simd-threaded.wasm`
    };
    globalThis.ort.env.wasm.numThreads = 1;
    out.step = 'config';

    const res = await fetch(`${base}silero_vad_v5.onnx`);
    if (!res.ok) throw new Error(`模型下载失败 HTTP ${res.status}`);
    out.step = 'model-fetch';

    const modelBuffer = await res.arrayBuffer();
    out.modelBytes = modelBuffer.byteLength;
    out.step = 'model-read';

    const vad = await createSileroVad({ ort: globalThis.ort, modelBuffer, sampleRate: 16000 });
    out.step = 'session-created';

    // 灌一帧 300Hz 正弦（模拟有声），看能不能出概率
    const frame = new Float32Array(512);
    for (let i = 0; i < frame.length; i++) frame[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 16000);

    const started = Date.now();
    const prob = await vad.push(frame);
    out.inferMs = Date.now() - started;
    out.prob = Number(prob.toFixed(3));
    out.step = 'inference';
    out.ok = true;
    return out;
  } catch (err) {
    out.error = String(err?.message || err).slice(0, 300);
    return out;
  }
}

async function handleStart(msg) {
  if (state && (state.status === 'recording' || state.status === 'starting')) {
    return { ok: false, error: '已经有一个转录任务在跑了，请先停止。' };
  }

  // 设置由 popup 每次 START 时带过来；offscreen 读不到 storage，不做自行加载
  settings = { ...DEFAULTS, ...(msg.settings || {}) };
  settings.segmentSeconds = clampSegment(settings.segmentSeconds);

  if (!settings.apiKey) {
    return { ok: false, error: '还没有填 API Key，请先在设置里填好硅基流动的密钥。' };
  }

  clearTimeout(closeTimer);
  segCounter = 0;
  chunkSeq = 0;
  silentRunMs = 0;
  lastInterimAt = 0;
  interimBusy = false;
  uploadChain = Promise.resolve();

  state = {
    status: 'starting',
    tabId: msg.tabId,
    tabTitle: msg.tabTitle || '',
    startedAt: Date.now(),
    stoppedAt: null,
    segments: [],
    transcript: '',
    pending: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    segSeconds: settings.segmentSeconds,
    maxChunkMs: settings.maxChunkMs || DEFAULTS.maxChunkMs,
    model: settings.model,
    lastError: '',
    monitorMuted: false,
    mutedPlayback: false,
    partial: null,
    diag: {}
  };
  await saveState();

  /* --- 1. 拿到标签页音频流 --- */
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: msg.streamId
        }
      },
      video: false
    });
  } catch (err) {
    state.status = 'error';
    state.lastError = `获取标签页音频失败：${err?.message || err}`;
    await saveState();
    return { ok: false, error: state.lastError };
  }

  if (!stream.getAudioTracks().length) {
    state.status = 'error';
    state.lastError = '捕获到的流里没有音轨（该标签页可能本来就没有声音）。';
    await saveState();
    releaseStream();
    return { ok: false, error: state.lastError };
  }

  /* --- 2. 把声音放回给用户听 ---
     tabCapture 会把标签页的声音从扬声器"夺走"，不回放的话用户看视频就没声音了。
     主用 Web Audio（source → destination），失败再退回 <audio srcObject>。 */
  await setupMonitor();

  /* --- 3. 标签页音频消失（关闭标签页 / 停止播放）时收尾 --- */
  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', () => {
    stopInternal('标签页音频已结束');
  });

  /* --- 4. 开跑：优先走实时 PCM 通路，失败退回 MediaRecorder --- */
  state.status = 'recording';
  await saveState();

  try {
    await startPcmCapture();
    state.diag.mode = 'pcm';
  } catch (err) {
    releasePcm();
    state.diag.mode = 'recorder';
    state.diag.pcmError = String(err?.message || err).slice(0, 160);
    try {
      startSegment();
    } catch (err2) {
      state.status = 'error';
      state.lastError = `启动录制失败：${err2?.message || err2}`;
      releaseStream();
      await saveState();
      return { ok: false, error: state.lastError };
    }
  }

  await saveState();
  return { ok: true };
}

/* ---------------------------- 分段录制 ---------------------------- */

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* ignore */
    }
  }
  return undefined; // 交给浏览器自己选
}

/**
 * 关键点：每段都用"新的 MediaRecorder + 不设 timeslice"。
 * 如果对一个 recorder 用 timeslice 切 chunk，只有第一块带 WebM 头，
 * 后面的块单独 decodeAudioData 会直接报错 —— 这是最常见的踩坑点。
 */
function startSegment() {
  if (!stream || !stream.active || !state || state.status !== 'recording') return;

  const mimeType = pickMimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
  const chunks = [];
  const startOffsetMs = Date.now() - state.startedAt;
  // 第一段短、后面按设置：让第一句文字尽快出现
  const limitMs = (chunkSeq === 0 ? Math.min(state.segSeconds, FIRST_SEGMENT_SECONDS) : state.segSeconds) * 1000;
  chunkSeq += 1;

  rec.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  rec.onstop = () => {
    clearTimeout(segTimer);
    segTimer = null;

    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });

    // 先无缝接上下一段，再做耗时的解码/切句/上传
    if (state && state.status === 'recording' && stream && stream.active) {
      try {
        startSegment();
      } catch (err) {
        noteError(`无法开始下一段：${err?.message || err}`);
      }
    }

    if (blob.size > 1500) {
      enqueueChunk(blob, startOffsetMs);
    }
  };

  rec.onerror = (event) => {
    noteError(`录制出错：${event?.error?.message || 'unknown'}`);
  };

  recorder = rec;
  state.diag.mimeType = rec.mimeType || mimeType || '(浏览器默认)';
  rec.start();
  saveSoon();

  segTimer = setTimeout(() => {
    if (rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
  }, limitMs);
}

/* ---------------------------- 录音块 → 句子 → 上传 ---------------------------- */

function pushItem(patch) {
  if (!state) return null;
  const item = {
    index: segCounter++,
    startMs: 0,
    durationMs: 0,
    status: 'queued',
    text: '',
    error: '',
    bytes: 0,
    ...patch
  };
  state.segments.push(item);
  return item;
}

/**
 * 一个录音块（默认 20 秒）进来后：
 *   解码 → 单声道 16k → 按静音切成句子 → 每句单独上传
 * 这样每句都自带精确的开始时间和时长，字幕才能按时间轴走。
 */
function enqueueChunk(blob, chunkStartMs) {
  if (!state) return;

  uploadChain = uploadChain
    .then(() => handleChunk(blob, chunkStartMs))
    .catch((err) => {
      noteError(String(err?.message || err));
    });
}

async function handleChunk(blob, chunkStartMs) {
  if (!state) return;

  let samples;
  try {
    samples = await blobToSamples(blob);
  } catch (err) {
    pushItem({
      startMs: chunkStartMs,
      status: 'error',
      error: `音频解码失败：${err?.message || err}`
    });
    await saveState();
    return;
  }

  const regions = detectSpeechRegions(samples, TARGET_RATE, {
    maxRegionMs: settings.maxChunkMs || DEFAULTS.maxChunkMs
  });

  if (!regions.length) {
    // 整块都是静音/音乐，没有可识别的内容
    pushItem({
      startMs: chunkStartMs,
      durationMs: Math.round((samples.length / TARGET_RATE) * 1000),
      status: 'skipped'
    });
    await saveState();
    return;
  }

  for (const region of regions) {
    if (!state) return;

    const item = pushItem({
      startMs: chunkStartMs + region.startMs,
      durationMs: region.durationMs,
      status: 'uploading'
    });
    saveSoon(0);

    try {
      const slice = samples.subarray(region.startSample, region.endSample);
      const wav = new Blob([encodeWav(slice, TARGET_RATE)], { type: 'audio/wav' });
      item.bytes = wav.size;
      const raw = await callTranscribe(wav, item.index);
      item.raw = raw;
      const text = acceptText(raw, item.durationMs);
      if (text) {
        item.text = text;
        item.status = 'done';
      } else {
        item.status = 'skipped';
      }
    } catch (err) {
      item.status = 'error';
      item.error = String(err?.message || err);
      if (state) state.lastError = item.error;
    }

    await saveState();
  }
}

/* ---------------------------- 音频转换 + 上传 ---------------------------- */

function getDecodeContext() {
  if (!decodeCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new Ctx();
  }
  return decodeCtx;
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  return base + path;
}

/* ---------------------------- 术语表 / 事后纠错 ---------------------------- */

let glossaryCache = null;
let glossarySource = null;

function glossaryOf() {
  const text = settings.glossary || DEFAULT_GLOSSARY_TEXT;
  if (glossarySource !== text) {
    glossarySource = text;
    glossaryCache = parseGlossary(text);
  }
  return glossaryCache;
}

/** 识别结果先过一遍本地术语表（零延迟），剩下的错字靠"校正全文" */
function finalize(text) {
  return applyGlossary(String(text || '').trim(), glossaryOf());
}

/**
 * 决定这段话该不该收：术语替换 → 幻觉过滤。
 * 幻觉来自"片头音乐被当成语音"这类情况，必须丢掉，
 * 否则字幕里会冒出 "I'm a man of few words." 这种句子。
 */
function acceptText(raw, durationMs) {
  const text = finalize(raw);
  if (!text) return '';
  if (looksLikeHallucination(text, durationMs)) return '';
  return text;
}

function fmtMmSs(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

async function callChat(messages) {
  const url = joinUrl(settings.baseUrl, '/chat/completions');
  const model = settings.correctModel || DEFAULTS.correctModel;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 2048 })
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new Error(`纠错模型不存在（404），检查模型名：${model}`);
    if (res.status === 401 || res.status === 403) throw new Error(`API Key 无权使用纠错模型（${res.status}）`);
    throw new Error(`纠错接口 HTTP ${res.status}：${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('纠错接口返回了非 JSON');
  }
  return String(data?.choices?.[0]?.message?.content || '');
}

const CORRECT_BATCH = 40;

/* ---------------------------- 离线精校 ---------------------------- */

/** 每次处理 3 分钟，控制内存（1 小时音频解码后是 230MB，不能一次全读） */
const REFINE_WINDOW_SEC = 180;

/** 从我们自己写出的 WAV 里取出 PCM（16bit 单声道） */
function wavToSamples(arrayBuffer) {
  if (arrayBuffer.byteLength < 44) throw new Error('WAV 文件太短');
  const view = new DataView(arrayBuffer);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(arrayBuffer, o, n));

  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= arrayBuffer.byteLength) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        rate: view.getUint32(body + 4, true),
        channels: view.getUint16(body + 2, true),
        bits: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, arrayBuffer.byteLength - body) };
      break;
    }
    off = body + size + (size % 2);
  }

  if (!fmt || !data) throw new Error('WAV 结构无法解析');
  if (fmt.bits !== 16) throw new Error('只支持 16bit WAV');

  // 头里的长度可能是 0（录制中途崩溃，收尾时没来得及回填），
  // 也可能比实际大（文件被截断）。两种情况都按实际可用字节算。
  const available = arrayBuffer.byteLength - data.offset;
  const size = data.size > 0 && data.size <= available ? data.size : available;

  const frames = Math.floor(size / (2 * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += view.getInt16(data.offset + (i * fmt.channels + c) * 2, true) / 32768;
    }
    out[i] = sum / fmt.channels;
  }
  return { samples: out, rate: fmt.rate };
}

/**
 * 离线精校：拿"同时保存音频"存下来的 WAV，按长上下文重新识别一遍。
 *
 * 为什么值得：实测同一段 8.9 分钟网课
 *   实时（切句 1–6 秒）：146 句 / 1397 字，"帧"只对 12 次，"针/真/贞"错 24 次
 *   离线（20 秒上下文）：81 句 / 1893 字，"帧"对 51 次，"针/真/贞"只错 2 次
 * 差别全在上下文长度上。
 */
/**
 * 把一段完整的 16k 单声道 PCM 按窗口切句后逐段转写。
 * 「离线精校」和「整段提取」共用这一条路——两者的差别只在音频从哪来。
 */
async function transcribeWindowed(samples, { maxRegionMs = 20000, onProgress } = {}) {
  const total = samples.length;
  const winSamples = REFINE_WINDOW_SEC * TARGET_RATE;
  const out = [];

  for (let start = 0; start < total; start += winSamples) {
    const end = Math.min(total, start + winSamples);
    const window = samples.subarray(start, end);

    // 每个窗口内再按能量切句：窗口 3 分钟是为了不让单次切句的内存无限涨
    const regions = detectSpeechRegions(window, TARGET_RATE, {
      maxRegionMs,
      targetMinMs: 3000,
      minGapMs: 700,
      maxJoinGapMs: 2500
    });

    for (const region of regions) {
      const absStartMs = Math.round((start / TARGET_RATE) * 1000) + region.startMs;
      const slice = window.subarray(region.startSample, region.endSample);
      const wav = new Blob([encodeWav(slice, TARGET_RATE)], { type: 'audio/wav' });

      let raw = '';
      try {
        raw = await callTranscribe(wav, out.length);
      } catch (err) {
        noteError(`第 ${out.length + 1} 段失败：${err?.message || err}`);
        continue;
      }

      const text = acceptText(raw, region.durationMs);
      if (!text) continue;

      out.push({
        index: out.length,
        startMs: absStartMs,
        durationMs: region.durationMs,
        status: 'done',
        text,
        raw,
        bytes: wav.size
      });

      if (onProgress) await onProgress(out.length);
    }

    if (onProgress) await onProgress(out.length);
  }

  return out;
}

/* ---------------------------- 整段提取（直链） ---------------------------- */

/** 单个媒体文件的上限：超过就别在浏览器里解码了，改用实时录制 */
const INGEST_MAX_BYTES = 600 * 1024 * 1024;
const INGEST_MAX_SECONDS = 45 * 60;

/**
 * 从直链媒体整段提取字幕——**不用等播放**。
 *
 * 这是 tabCapture 之外的回头路：页面里的媒体如果是直链 MP4/m4a/MP3，
 * 就没必要"录声音"，直接把文件下载下来解码、整段转写，播放前就能拿到全稿。
 * 时间轴天然对齐（相对文件开头），比录制推算更准。
 */
function startIngest(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http(s) 直链' };
  if (!settings.apiKey) return { ok: false, error: '缺少 API Key' };
  if (state?.diag?.ingesting) return { ok: false, error: '正在整段提取中，等它跑完再点' };

  if (!state || state.status === 'stopped' || state.status === 'error') {
    state = {
      status: 'processing',
      tabId: null,
      tabTitle: '',
      startedAt: Date.now(),
      stoppedAt: null,
      segments: [],
      transcript: '',
      pending: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      segSeconds: settings.segmentSeconds,
      maxChunkMs: settings.maxChunkMs || DEFAULTS.maxChunkMs,
      model: settings.model,
      lastError: '',
      monitorMuted: false,
      mutedPlayback: false,
      partial: null,
      diag: {}
    };
  }

  state.status = 'processing';
  state.diag = state.diag || {};
  state.diag.ingesting = true;
  state.diag.ingestPhase = 'download';
  state.diag.ingestBytes = 0;
  state.diag.ingestDone = 0;
  state.diag.ingestError = '';
  state.diag.source = 'url'; // 标记：这份稿子来自直链整段提取（不是录制）
  state.diag.ingestUrl = target.slice(0, 300);
  saveState();

  runIngest(target).catch(() => {});

  return { ok: true, started: true };
}

async function runIngest(url) {
  const t0 = Date.now();
  try {
    /* --- 1. 下载 --- */
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > INGEST_MAX_BYTES) {
      throw new Error(`文件太大（${Math.round(buf.byteLength / 1048576)}MB），改用实时录制`);
    }
    state.diag.ingestBytes = buf.byteLength;
    state.diag.ingestPhase = 'decode';
    await saveState();

    /* --- 2. 解码（浏览器自带的解码器，不需要额外依赖）--- */
    const ctx = new AudioContext();
    let audio;
    try {
      audio = await ctx.decodeAudioData(buf);
    } catch (err) {
      throw new Error(`解码失败（可能不是 mp4/mp3/m4a）：${err?.message || err}`);
    }

    if (!Number.isFinite(audio.duration) || !audio.duration) {
      await ctx.close().catch(() => {});
      throw new Error('解码后拿不到时长');
    }
    if (audio.duration > INGEST_MAX_SECONDS) {
      await ctx.close().catch(() => {});
      throw new Error(`音频 ${Math.round(audio.duration / 60)} 分钟，超过 45 分钟上限，改用实时录制`);
    }

    const mono = mixToMono(audio);
    const samples = audio.sampleRate === TARGET_RATE ? mono : resampleBox(mono, audio.sampleRate, TARGET_RATE);
    await ctx.close().catch(() => {});

    state.diag.ingestDurationMs = Math.round(audio.duration * 1000);
    state.diag.ingestPhase = 'transcribe';
    await saveState();

    /* --- 3. 整段转写 --- */
    const items = await transcribeWindowed(samples, {
      onProgress: async (count) => {
        state.diag.ingestDone = count;
        await saveState();
      }
    });

    if (!items.length) throw new Error('没有识别出任何内容（可能整段都是音乐）');

    state.segments = items;
    state.status = 'stopped';
    state.stoppedAt = Date.now();
    state.diag.ingesting = false;
    state.diag.ingestPhase = 'done';
    state.diag.ingestMs = Date.now() - t0;
    await saveState();

    /* --- 4. 顺手整段纠错 --- */
    const correction = await handleCorrectAll().catch((err) => ({ ok: false, error: String(err) }));
    state.diag.ingestCorrection = correction?.ok
      ? { changed: correction.changed, total: correction.corrected }
      : { error: correction?.error || '纠错未执行' };
    await saveState();
  } catch (err) {
    if (state) {
      state.diag.ingesting = false;
      state.diag.ingestPhase = 'error';
      state.diag.ingestError = String(err?.message || err).slice(0, 300);
      if (state.status === 'processing') state.status = 'stopped';
      state.stoppedAt = state.stoppedAt || Date.now();
      await saveState().catch(() => {});
    }
  }
}

async function handleRefine() {
  if (!state) return { ok: false, error: '还没有会话' };
  if (state.diag?.refining) return { ok: false, error: '正在精校中' };

  const name = state.diag?.audioFile;
  if (!name) {
    return { ok: false, error: '这次没有保存音频，无法精校（开始录制前要勾「同时保存音频」）' };
  }
  if (!settings.apiKey) return { ok: false, error: '缺少 API Key' };

  let file;
  try {
    file = await readAudioFile(name);
  } catch (err) {
    return { ok: false, error: `读取音频失败：${err?.message || err}` };
  }

  let parsed;
  try {
    parsed = wavToSamples(await file.arrayBuffer());
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  let samples = parsed.samples;
  if (parsed.rate !== TARGET_RATE) samples = resampleBox(samples, parsed.rate, TARGET_RATE);

  state.diag.refining = true;
  state.diag.refineDone = 0;
  await saveState();

  const refined = await transcribeWindowed(samples, {
    onProgress: async (count) => {
      state.diag.refineDone = count;
      await saveState();
    }
  });

  // 用精校结果整体替换实时结果
  state.segments = refined;
  state.refined = true;
  state.diag.refining = false;
  await saveState();

  // 顺手做一遍整段纠错（这一步能吃掉的错最多）
  const correction = await handleCorrectAll();

  return {
    ok: true,
    segments: refined.length,
    correction: correction?.ok ? { changed: correction.changed, corrected: correction.corrected } : null,
    correctionError: correction?.ok ? null : correction?.error || null
  };
}

/**
 * 整段纠错：把已识别的句子连同术语表交给对话模型，只改错字、不动时间戳。
 * 分批是为了不超出模型上下文；每批 40 句，实测一批约 3 秒。
 */
async function handleCorrectAll() {
  if (!state) return { ok: false, error: '还没有会话' };
  if (!settings.apiKey) return { ok: false, error: '缺少 API Key' };

  const items = (state.segments || []).filter((s) => s.status === 'done' && s.text);
  if (!items.length) return { ok: false, error: '还没有可校正的句子' };

  const glossary = glossaryOf();
  let changed = 0;
  let corrected = 0;

  for (let i = 0; i < items.length; i += CORRECT_BATCH) {
    const batch = items.slice(i, i + CORRECT_BATCH);
    const lines = batch.map((s) => ({ time: fmtMmSs(s.startMs || 0), text: s.text }));

    let content;
    try {
      content = await callChat(buildCorrectionMessages(lines, glossary));
    } catch (err) {
      return { ok: false, error: String(err?.message || err), changed, corrected };
    }

    const parsed = parseCorrectionResponse(content);

    for (let k = 0; k < batch.length; k++) {
      const item = batch[k];
      let next = null;

      if (parsed.length === batch.length) {
        // 行数一致：按顺序对应最稳（时间戳可能撞车）
        next = parsed[k].text;
      } else {
        const hit = parsed.find((p) => p.time === fmtMmSs(item.startMs || 0));
        if (hit) next = hit.text;
      }
      if (!next) continue;

      const clean = finalize(next);
      if (clean && clean !== item.text) {
        item.text = clean;
        changed += 1;
      }
      item.corrected = true;
      corrected += 1;
    }

    await saveState();
  }

  return { ok: true, changed, corrected, model: settings.correctModel || DEFAULTS.correctModel };
}

/**
 * 调用硅基流动语音转文字接口。
 * 文档：POST https://api.siliconflow.cn/v1/audio/transcriptions
 *   - multipart/form-data
 *   - file: 音频文件（≤ 50MB，时长 ≤ 1 小时）
 *   - model: 模型名
 *   - 返回 { "text": "..." }
 */
async function callTranscribe(wavBlob, index) {
  const url = joinUrl(settings.baseUrl, '/audio/transcriptions');
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const form = new FormData();
    form.append('file', wavBlob, `segment-${String(index).padStart(3, '0')}.wav`);
    form.append('model', settings.model || DEFAULTS.model);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: form
      });
    } catch (err) {
      if (attempt === 3) throw new Error(`网络请求失败：${err?.message || err}`);
      await sleep(1200 * attempt);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 有些兼容实现会直接返回纯文本
        return text.trim();
      }
      if (state) state.diag.lastUploadMs = Date.now() - startedAt;
      return String(parsed?.text ?? parsed?.data?.text ?? '').trim();
    }

    const body = await res.text().catch(() => '');

    if (res.status === 401 || res.status === 403) {
      throw new Error(`API Key 无效或没有该模型权限（HTTP ${res.status}）：${body.slice(0, 200)}`);
    }
    if (res.status === 404) {
      throw new Error(`接口或模型不存在（HTTP 404），检查"接口地址"和"模型名"：${body.slice(0, 200)}`);
    }
    if (res.status === 400) {
      // 实测：音频为空或极短时，Qwen3-ASR 返回 400 且响应体是空的
      throw new Error(
        `请求被拒绝（HTTP 400）：这一段音频可能太短或全是静音${body ? `：${body.slice(0, 200)}` : ''}`
      );
    }
    if (res.status === 413) {
      throw new Error('音频太大被拒绝（HTTP 413），把"每段秒数"调小一些。');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1500 * attempt);
      continue;
    }
    throw new Error(`HTTP ${res.status}：${body.slice(0, 300)}`);
  }
  throw new Error('重试 3 次仍然失败。');
}

/** 录音块（webm/opus）→ 16k 单声道 Float32 采样 */
async function blobToSamples(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = getDecodeContext();
  // decodeAudioData 不需要 context 处于 running 状态（纯离线解码），不受自动播放策略影响
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  if (state) {
    state.diag.sourceSampleRate = audioBuffer.sampleRate;
    state.diag.channels = audioBuffer.numberOfChannels;
  }

  const mono = mixToMono(audioBuffer);
  return resampleBox(mono, audioBuffer.sampleRate, TARGET_RATE);
}

/* ---------------------------- 停止 ---------------------------- */

function releaseStream() {
  if (monitorCtx) {
    try {
      monitorCtx.close();
    } catch {
      /* ignore */
    }
    monitorCtx = null;
  }
  if (monitorEl) {
    try {
      monitorEl.pause();
      monitorEl.srcObject = null;
      monitorEl.remove();
    } catch {
      /* ignore */
    }
    monitorEl = null;
  }
  if (stream) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    stream = null;
  }
}

async function stopInternal(reason) {
  clearTimeout(segTimer);
  segTimer = null;

  const wasActive = !!state && (state.status === 'recording' || state.status === 'starting');
  if (!state) {
    releaseStream();
    return { ok: true };
  }

  if (wasActive) state.status = 'stopping';
  await saveState();

  // 实时通路：把最后没说完的半句收尾
  if (segmenter) {
    try {
      for (const seg of segmenter.flush()) enqueuePcmSegment(seg);
    } catch {
      /* ignore */
    }
  }

  // 音频文件收尾：等写完，再回填 WAV 头里的长度
  if (audioWriter) {
    try {
      await audioChain;
      const info = await audioWriter.close();
      if (state) {
        state.diag.audioBytes = info.bytes;
        state.diag.audioMs = info.durationMs;
      }
    } catch (err) {
      if (state) state.diag.saveAudioError = String(err?.message || err).slice(0, 160);
    }
    audioWriter = null;
  }

  releasePcm();

  // 停 recorder 会触发 onstop → 最后一段照样入队上传
  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
  }
  recorder = null;

  releaseStream();

  state.status = 'stopped';
  state.stoppedAt = Date.now();
  state.partial = null;
  if (reason) state.stopReason = reason;
  await saveState();

  scheduleCloseWhenIdle();
  return { ok: true };
}

/**
 * 停止后不立刻销毁 offscreen：还有片段在排队上传。
 * 队列清空后主动请 Service Worker 关掉这个文档（offscreen 自己调不了 chrome.offscreen）。
 */
function scheduleCloseWhenIdle() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    if (!state || state.status !== 'stopped') return;
    if (state.pending > 0) {
      scheduleCloseWhenIdle();
      return;
    }
    await notifySw({ type: 'CLOSE_OFFSCREEN' });
  }, 60000);
}

/* ---------------------------- 状态上报 ---------------------------- */

function getPublicState() {
  // 只回传内部状态，运行时长由 popup 根据 startedAt 自己算，避免每帧写 storage
  return state ? { ...state } : null;
}

/* ---------------------------- 消息入口 ---------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'PING':
          sendResponse({ ok: true, busy: !!state && state.status === 'recording' });
          break;

        case 'START':
          sendResponse(await handleStart(msg));
          break;

        case 'STOP':
          sendResponse(await stopInternal('用户手动停止'));
          break;

        case 'GET_STATE':
          sendResponse({ ok: true, state: getPublicState() });
          break;

        case 'RESTORE_STATE': {
          // 文档被回收后重建时，靠这条消息把会话和设置救回来
          if (!state && msg.state) state = msg.state;
          if (msg.settings) {
            settings = { ...DEFAULTS, ...msg.settings };
            settings.segmentSeconds = clampSegment(settings.segmentSeconds);
          }
          sendResponse({ ok: true, restored: !!state });
          break;
        }

        case 'CORRECT_ALL':
          sendResponse(await handleCorrectAll());
          // 如果这个文档只是为了纠错才被重建的，用完还给它安排回收
          if (state?.status === 'stopped') scheduleCloseWhenIdle();
          break;

        case 'REFINE':
          sendResponse(await handleRefine());
          break;

        case 'INGEST_URL':
          // 直链整段提取：立刻返回，进度靠 state.diag 推给弹窗
          sendResponse(startIngest(msg.url));
          break;

        case 'VAD_SELFTEST':
          sendResponse(await handleVadSelftest());
          break;

        case 'RESET':
          await stopInternal('重置');
          state = null;
          await notifySw({ type: 'STATE_CLEAR' });
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `未知消息类型：${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true;
});

/* 这个文档没有 chrome.storage，设置一律由 popup 在 START 时带进来 */








