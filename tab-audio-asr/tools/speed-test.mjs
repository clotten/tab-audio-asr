/**
 * speed-test.mjs —— 验证"加速播放能否缩短整体转写时间"
 *
 * 做法：同一段文字，用 TTS 以不同语速合成，再分别送 ASR，比较识别相似度。
 * 结论用来判断"把视频拖到 1.5/2 倍速边播边录"这个提速技巧是否靠谱。
 *
 * 用法：
 *   $env:SILICONFLOW_API_KEY_FILE="...\.siliconflow-key"
 *   node tools/speed-test.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mixToMono, resampleBox, encodeWav, TARGET_SAMPLE_RATE } from '../lib/wav.js';
import { readChannels } from './wav-read.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const API_KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!API_KEY) {
  console.error('缺少 key：设置 SILICONFLOW_API_KEY 或 SILICONFLOW_API_KEY_FILE');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const MODEL_TTS = 'fnlp/MOSS-TTSD-v0.5';
const MODEL_ASR = 'Qwen/Qwen3-ASR-1.7B';
const VOICE = 'fnlp/MOSS-TTSD-v0.5:alex';

const TEXT =
  '[S1]今天我们来讨论一个很实际的问题，网页上的视频怎样快速变成文字。[S2]核心难点不在于识别，而在于音频要跟着播放才能拿到。' +
  '[S1]如果把播放速度调快，是不是就能节省时间呢。[S2]我们来实测一下不同语速下的识别准确率。';

const SPEEDS = [1.0, 1.25, 1.5, 2.0];

function clean(s) {
  return s.replace(/[\s，。、！？,.!?：:；;"'「」『』（）()【】\-—…]/g, '');
}

function similarity(a, b) {
  const A = clean(a);
  const B = clean(b);
  if (!A || !B) return 0;
  const setA = new Set(A);
  const setB = new Set(B);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter++;
  return inter / (setA.size + setB.size - inter);
}

async function tts(text, speed) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_TTS,
      input: text,
      voice: VOICE,
      response_format: 'wav',
      sample_rate: 16000,
      speed
    })
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function toPipelineWav(input) {
  const { header, channels } = readChannels(input);
  const merged = {
    numberOfChannels: channels.length,
    length: header.frames,
    getChannelData: (i) => channels[i]
  };
  const mono = mixToMono(merged);
  const resampled = resampleBox(mono, header.sampleRate, TARGET_SAMPLE_RATE);
  return { buffer: Buffer.from(encodeWav(resampled, TARGET_SAMPLE_RATE)), durationSec: header.durationSec };
}

async function asr(buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speed-test.wav');
  form.append('model', MODEL_ASR);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form
  });
  const cost = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) return { ok: false, cost, status: res.status, text };
  let out = text;
  try {
    out = JSON.parse(text).text ?? text;
  } catch {
    /* 已经是纯文本 */
  }
  return { ok: true, cost, status: res.status, text: out };
}

console.log(`原文（${TEXT.length} 字）\n`);
console.log('语速   音频时长   识别耗时   相似度   识别文本');
console.log('─'.repeat(96));

const results = [];
for (const speed of SPEEDS) {
  try {
    const wav = await tts(TEXT, speed);
    const { buffer, durationSec } = toPipelineWav(wav);
    writeFileSync(join(OUT, `speed-${speed}.wav`), buffer);

    const r = await asr(buffer);
    if (!r.ok) {
      console.log(`${speed.toFixed(2)}   ${durationSec.toFixed(2)}s     HTTP ${r.status}   ${r.text.slice(0, 60)}`);
      continue;
    }
    const sim = similarity(TEXT, r.text);
    results.push({ speed, durationSec, sim, cost: r.cost });
    console.log(
      `${speed.toFixed(2)}   ${durationSec.toFixed(2).padStart(6)}s   ${String(r.cost).padStart(6)}ms   ` +
        `${(sim * 100).toFixed(1).padStart(5)}%   ${r.text.slice(0, 40)}`
    );
  } catch (err) {
    console.log(`${speed.toFixed(2)}   失败：${err.message}`);
  }
}

console.log('\n结论参考：');
for (const r of results) {
  const realtime = r.durationSec / (r.cost / 1000);
  console.log(
    `  语速 ${r.speed}x → 相似度 ${(r.sim * 100).toFixed(1)}%，音频 ${r.durationSec.toFixed(1)}s，识别 ${r.cost}ms（${realtime.toFixed(1)} 倍实时）`
  );
}
