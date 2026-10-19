/**
 * replay-live.mjs —— 真·实时回放：按 1 倍速播一遍真实录音，看插件会怎么表现
 *
 * 和 simulate.mjs 的区别：
 *   - simulate 是 6 倍速喂假音频、假 onnxruntime，只验证"消息流/状态机"；
 *   - 这个脚本按 **128ms 一块**（和 AudioWorklet 一模一样）喂**真实录音**，
 *     用 **onnxruntime-node 跑真实 Silero 模型**，走**真实识别接口**，
 *     所以能测出真实的时间线：播放到第几秒出字、每句延迟多少、哪些段被 VAD 丢掉。
 *
 * 用法：
 *   node tools/replay-live.mjs <音频.wav> [--speed 1] [--no-silero] [--no-interim] [--out 前缀]
 *   （需要先在 _node/ 里装 onnxruntime-node；没有就自动退化成纯能量 VAD）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mixToMono, resampleBox, encodeWav, TARGET_SAMPLE_RATE } from '../lib/wav.js';
import { createStreamingSegmenter } from '../lib/vad.js';
import { createSileroVad, createSileroGate } from '../lib/silero.js';
import { planInterim, stripCommittedOverlap } from '../lib/incremental.js';
import { DEFAULT_GLOSSARY_TEXT, parseGlossary, applyGlossary } from '../lib/glossary.js';
import { looksLikeHallucination } from '../lib/hallucination.js';
import { readChannels } from './wav-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key：设置 SILICONFLOW_API_KEY_FILE');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const ASR_MODEL = process.env.ASR_MODEL || 'Qwen/Qwen3-ASR-1.7B';

/* ---------------------------- 参数 ---------------------------- */

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--') && /\.(wav|mp3|m4a)$/i.test(a));
if (!input) {
  console.error('用法：node tools/replay-live.mjs <音频.wav> [--speed 1] [--no-silero] [--no-interim] [--out 前缀]');
  process.exit(1);
}
const getOpt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const SPEED = Math.max(0.5, Number(getOpt('speed', 1)) || 1);
const useSilero = !has('no-silero');
const useInterim = !has('no-interim');
const outPrefix = getOpt('out', join(dirname(input), basename(input, extname(input)) + '-live'));

// 切句参数可覆盖，用来做对比实验
const SEG_OPTS = {};
if (getOpt('silence-gap')) SEG_OPTS.silenceGapMs = Number(getOpt('silence-gap'));
if (getOpt('target-min')) SEG_OPTS.targetMinMs = Number(getOpt('target-min'));
if (getOpt('grace')) SEG_OPTS.graceSilenceMs = Number(getOpt('grace'));

const INTERIM_INTERVAL = Number(getOpt('interim-interval', 2000));
const INTERIM_MIN = Number(getOpt('interim-min', 1800));

const BLOCK = 2048; // 和 pcm-worklet.js 的 blockSize 一致（128ms @16k）
const BLOCK_MS = (BLOCK / TARGET_SAMPLE_RATE) * 1000;

const glossaryPath = getOpt('glossary', '');
const glossary = parseGlossary(glossaryPath && existsSync(glossaryPath) ? readFileSync(glossaryPath, 'utf8') : DEFAULT_GLOSSARY_TEXT);
const clean = (t) => applyGlossary(String(t || '').trim(), glossary);

/* ---------------------------- 读音频 ---------------------------- */

const { header, channels } = readChannels(readFileSync(input));
const mono = mixToMono({ numberOfChannels: channels.length, length: header.frames, getChannelData: (i) => channels[i] });
const samples = header.sampleRate === TARGET_SAMPLE_RATE ? mono : resampleBox(mono, header.sampleRate, TARGET_SAMPLE_RATE);
const totalMs = (samples.length / TARGET_SAMPLE_RATE) * 1000;

const clock = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(t / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${m}:${s}`;
};
const sec1 = (ms) => (ms / 1000).toFixed(1) + 's';

console.log(`\n回放 ${basename(input)}`);
console.log(`  时长 ${sec1(totalMs)} ｜ 速度 ${SPEED}x ｜ 分块 ${BLOCK} 采样（${BLOCK_MS}ms）`);
console.log(`  Silero: ${useSilero ? '真模型' : '关闭'} ｜ 增量预览: ${useInterim ? '开' : '关'}\n`);

/* ---------------------------- 真 Silero ---------------------------- */

let vad = null;
if (useSilero) {
  const depDirs = [
    join(ROOT, '..', '_node', 'node_modules', 'onnxruntime-node'),
    join(ROOT, '..', 'node_modules', 'onnxruntime-node')
  ];
  const found = depDirs.find((p) => existsSync(join(p, 'package.json')));

  if (!found) {
    console.log('⚠ 没找到 onnxruntime-node（跳过 Silero，只用能量 VAD）\n');
  } else {
    try {
      const pkg = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8'));
      const entry = join(found, pkg.main || 'dist/index.js');
      const ort = await import(pathToFileURL(entry).href);
      const ortAdapter = {
        Tensor: ort.Tensor,
        InferenceSession: { create: (buf) => ort.InferenceSession.create(buf) }
      };
      const modelBuffer = readFileSync(join(ROOT, 'vendor', 'silero_vad_v5.onnx'));
      vad = await createSileroVad({
        ort: ortAdapter,
        modelBuffer: modelBuffer.buffer.slice(modelBuffer.byteOffset, modelBuffer.byteOffset + modelBuffer.byteLength),
        sampleRate: TARGET_SAMPLE_RATE
      });
      console.log('✓ Silero 已加载（onnxruntime-node + 真模型）\n');
    } catch (err) {
      console.log(`⚠ Silero 加载失败：${err.message}（退回能量 VAD）\n`);
    }
  }
}

const gate = vad ? createSileroGate({ vad, sampleRate: TARGET_SAMPLE_RATE }) : null;
const VAD_THRESHOLD = 0.25;

/* ---------------------------- 识别 ---------------------------- */

const started = Date.now();
let consumedMs = 0; // 已经"播放"到的位置

async function transcribe(slice, durationMs) {
  const wav = Buffer.from(encodeWav(slice, TARGET_SAMPLE_RATE));
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', ASR_MODEL);

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        body: form
      });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      let out = text;
      try {
        out = JSON.parse(text).text ?? text;
      } catch {
        /* 纯文本 */
      }
      return String(out).trim();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  throw new Error('重试失败');
}

/* ---------------------------- 管线状态 ---------------------------- */

const segmenter = createStreamingSegmenter(TARGET_SAMPLE_RATE, SEG_OPTS);
const finals = [];
const latencies = [];
let uploadChain = Promise.resolve();
let interimBusy = false;
let lastInterimAt = 0;
let requestCount = 0;
let dropped = 0;
let previewCount = 0;
let interimTail = '';
let interimPending = '';
let interimActive = false;
let trimmedMs = 0;
let finalsPending = 0; // 队列里还有没传完的定稿时，跳过预览（定稿优先）

function enqueueFinal(seg) {
  const item = { startMs: seg.startMs, durationMs: seg.durationMs, text: '', reason: seg.reason };
  finals.push(item);
  if (typeof globalThis.__onFinal === 'function') globalThis.__onFinal(item);

  const slice = seg.samples;
  finalsPending += 1;

  uploadChain = uploadChain.then(async () => {
    // 先问 Silero：不是人声就别浪费请求
    if (gate) {
      const p = await gate.meanProb(seg.startMs, seg.startMs + seg.durationMs);
      if (p != null && p < VAD_THRESHOLD) {
        item.dropped = `vad ${p.toFixed(3)}`;
        dropped += 1;
        print(`  ⨯ 丢弃 ${clock(seg.startMs)}–${clock(seg.startMs + seg.durationMs)}（VAD ${p.toFixed(3)}）`);
        return;
      }
      item.vadProb = p;
    }

    requestCount += 1;
    let raw = '';
    try {
      raw = await transcribe(slice, seg.durationMs);
    } catch (err) {
      item.error = err.message;
      print(`  ✗ ${clock(seg.startMs)} 识别失败：${err.message}`);
      return;
    }

    let text = clean(raw);
    if (interimActive) {
      text = clean(stripCommittedOverlap(text, interimTail));
      if (interimPending) text = interimPending + text;
      interimTail = '';
      interimPending = '';
      interimActive = false;
    }
    const now = consumedMs;
    if (!text || looksLikeHallucination(text, seg.durationMs)) {
      item.dropped = 'hallucination';
      dropped += 1;
      print(`  ⨯ 丢弃 ${clock(seg.startMs)}（疑似幻觉）：${raw}`);
      return;
    }

    item.text = text;
    const latency = Math.max(0, now - (seg.startMs + seg.durationMs));
    latencies.push(latency);
    print(
      `  ✓ 定稿 ${clock(seg.startMs)}–${clock(seg.startMs + seg.durationMs)}` +
        `  延迟 ${sec1(latency)}（播到 ${clock(now)} 才出）  「${text}」`
    );
  })
    .finally(() => {
      finalsPending = Math.max(0, finalsPending - 1);
    })
    .catch(() => {});
}

function maybeInterim() {
  if (!useInterim || interimBusy) return;
  // 定稿还排着队就别再插预览了：预览和定稿抢请求配额，会把定稿拖慢
  if (finalsPending > 0) return;
  const now = Date.now();
  if (now - lastInterimAt < INTERIM_INTERVAL) return;

  const peek = segmenter.peek?.();
  if (!peek || peek.durationMs < INTERIM_MIN) return;

  lastInterimAt = now;
  interimBusy = true;

  (async () => {
    try {
      if (gate) {
        const p = await gate.meanProb(peek.startMs, peek.startMs + peek.durationMs);
        if (p != null && p < VAD_THRESHOLD) return;
      }
      requestCount += 1;
      const raw = await transcribe(peek.samples, peek.durationMs);
      const text = clean(raw);
      if (!text || looksLikeHallucination(text, peek.durationMs)) return;

      // 增量提交：除最后一句外都已完整 → 提交并把对应音频剪掉
      const plan = planInterim({
        text,
        committedTail: interimTail,
        bufferStartMs: peek.startMs,
        bufferDurationMs: peek.durationMs,
        pending: interimPending
      });

      for (const c of plan.commits) {
        const lat = Math.max(0, consumedMs - (c.startMs + c.durationMs));
        latencies.push(lat);
        finals.push({ startMs: c.startMs, durationMs: c.durationMs, text: c.text, incremental: true });
        print(`  ⚡ 增量 ${clock(c.startMs)}–${clock(c.startMs + c.durationMs)}  延迟 ${sec1(lat)}  「${c.text}」`);
      }

      if (plan.commits.length) {
        interimTail = plan.tail;
        interimPending = plan.pending;
        interimActive = true;
        if (plan.trimMs > 0) {
          const cut = segmenter.trimFront(Math.round((plan.trimMs / 1000) * TARGET_SAMPLE_RATE));
          trimmedMs += Math.round((cut / TARGET_SAMPLE_RATE) * 1000);
        }
      }

      if (plan.remainder) {
        previewCount += 1;
        const lastCommit = plan.commits[plan.commits.length - 1];
        const at = lastCommit ? lastCommit.startMs + lastCommit.durationMs : peek.startMs;
        print(`  … 正在说 ${clock(at)}「${plan.remainder}」`);
      }
    } catch {
      /* 预览失败无所谓 */
    } finally {
      interimBusy = false;
    }
  })();
}

function print(s) {
  console.log(s);
}

/* ---------------------------- 实时喂音频 ---------------------------- */

console.log('开始回放（音频位置 | 事件）\n');

let offset = 0;
const timer = setInterval(() => {
  if (offset >= samples.length) return;

  const block = samples.subarray(offset, Math.min(offset + BLOCK, samples.length));
  offset += block.length;
  consumedMs = (offset / TARGET_SAMPLE_RATE) * 1000;

  if (gate) gate.push(block);
  const emitted = segmenter.push(block);
  maybeInterim();
  for (const seg of emitted) enqueueFinal(seg);

  // 声音检测（只用于展示）
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  const rms = Math.sqrt(sum / block.length);

  if (process.stdout.isTTY && Math.round(consumedMs / 1000) !== Math.round((consumedMs - BLOCK_MS) / 1000)) {
    process.stdout.write(`\r播放中 ${clock(consumedMs)} / ${clock(totalMs)}   rms=${rms.toFixed(3)}   `);
  }
}, BLOCK_MS / SPEED);

/* ---------------------------- 收尾 ---------------------------- */

await new Promise((resolve) => {
  const check = setInterval(() => {
    if (offset >= samples.length) {
      clearInterval(check);
      resolve();
    }
  }, 200);
});

clearInterval(timer);
process.stdout.write('\n');
console.log(`\n音频播完（${sec1(consumedMs)}），等待队列里的识别完成…`);

for (const seg of segmenter.flush()) enqueueFinal(seg);
await uploadChain;
await new Promise((r) => setTimeout(r, 300));

/* ---------------------------- 统计 ---------------------------- */

const ok = finals.filter((f) => f.text);
latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);

console.log(`\n===== 结果 =====`);
console.log(`  定稿句子：${ok.length}　被丢弃：${dropped}　预览次数：${previewCount}　识别请求：${requestCount}`);
if (latencies.length) {
  console.log(
    `  延迟（说完 → 出字）：最小 ${sec1(latencies[0])}　中位 ${sec1(pct(50))}　p90 ${sec1(pct(90))}　最大 ${sec1(latencies[latencies.length - 1])}`
  );
}
const chars = ok.reduce((n, f) => n + f.text.length, 0);
const frameOk = (ok.map((f) => f.text).join('').match(/帧/g) || []).length;
const frameBad = (ok.map((f) => f.text).join('').match(/[针真贞]/g) || []).length;
const macOk = (ok.map((f) => f.text).join('').match(/MAC/g) || []).length;
console.log(`  字数 ${chars}　帧 ${frameOk}　针/真/贞 ${frameBad}　MAC ${macOk}`);

/* ---------------------------- 输出 SRT ---------------------------- */

const srtTime = (ms) => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  let rest = Math.max(0, Math.round(ms));
  const h = Math.floor(rest / 3600000);
  rest -= h * 3600000;
  const m = Math.floor(rest / 60000);
  rest -= m * 60000;
  const s = Math.floor(rest / 1000);
  rest -= s * 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
};

const srt = ok
  .map((f, i) => `${i + 1}\n${srtTime(f.startMs)} --> ${srtTime(f.startMs + Math.max(600, f.durationMs))}\n${f.text}\n`)
  .join('\n');

writeFileSync(`${outPrefix}.srt`, srt, 'utf8');
console.log(`\n已写出 ${outPrefix}.srt`);
console.log(`总耗时 ${sec1(Date.now() - started)}（音频 ${sec1(totalMs)}，速度 ${SPEED}x）`);
process.exit(0);





