/**
 * overlap-test.mjs —— 量化"冷启动"问题：给每段音频带上多少前置上下文，术语才认得对？
 *
 * 背景：同一个 12 秒音频，所有模型都能认出 802.11 / MAC / 无线局域网；
 * 把同一句单独切出来（5 秒），所有模型都错成"二十的二班是摊"。
 * 说明切句边界让模型失去了声学/语言上下文。
 *
 * 本脚本用 TTS 造两句话 A、B，把 A 的尾巴按不同长度拼到 B 前面，
 * 看 802.11 / MAC / 无线局域网 三个术语在什么条件下能被认对。
 *
 * 用法：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/overlap-test.mjs
 */

import { readFileSync } from 'node:fs';
import { encodeWav, mixToMono, resampleBox, TARGET_SAMPLE_RATE } from '../lib/wav.js';
import { readChannels } from './wav-read.mjs';

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const TTS_MODEL = 'fnlp/MOSS-TTSD-v0.5';
const TTS_VOICE = 'fnlp/MOSS-TTSD-v0.5:alex';
const ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B';

const A = '[S1]今天我们来学习无线局域网的组成。';
const B = '[S1]802.11 无线局域网主要定义了 MAC 协议和帧格式。';

async function tts(text) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: 'wav',
      sample_rate: 16000
    })
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { header, channels } = readChannels(buf);
  const mono = mixToMono({
    numberOfChannels: channels.length,
    length: header.frames,
    getChannelData: (i) => channels[i]
  });
  return { samples: resampleBox(mono, header.sampleRate, TARGET_SAMPLE_RATE), rate: TARGET_SAMPLE_RATE };
}

function take(samples, fromSec, toSec) {
  const a = Math.max(0, Math.round(fromSec * TARGET_SAMPLE_RATE));
  const b = Math.min(samples.length, Math.round(toSec * TARGET_SAMPLE_RATE));
  return samples.subarray(a, b);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function asr(samples) {
  const form = new FormData();
  const wav = Buffer.from(encodeWav(samples, TARGET_SAMPLE_RATE));
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', ASR_MODEL);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form
  });
  const text = await res.text();
  let out = text;
  try {
    out = JSON.parse(text).text ?? text;
  } catch {
    /* 纯文本 */
  }
  return { cost: Date.now() - t0, text: String(out).trim(), samples };
}

function terms(text) {
  return [
    /802[.\s]*11|八零二点(幺幺|一一|十一)/.test(text) ? '802.11✓' : '802.11✗',
    /MAC/i.test(text.replace(/MA[Xx]/g, 'MAC')) ? 'MAC✓' : 'MAC✗',
    text.includes('无线局域网') ? '无线局域网✓' : '无线局域网✗'
  ].join('  ');
}

const a = await tts(A);
const b = await tts(B);
const aDur = a.samples.length / TARGET_SAMPLE_RATE;
const bDur = b.samples.length / TARGET_SAMPLE_RATE;

console.log(`A（前一句）${aDur.toFixed(2)}s：${A}`);
console.log(`B（目标句）${bDur.toFixed(2)}s：${B}\n`);

const variants = [
  { label: 'B 单独（冷启动，当前实现的边界情况）', from: 0 },
  { label: '0.6s 前置', from: 0.6 },
  { label: '1.2s 前置', from: 1.2 },
  { label: '2.0s 前置', from: 2.0 },
  { label: '整段 A + B', from: aDur }
];

console.log('前置长度      音频时长   耗时     术语命中');
console.log('─'.repeat(100));

for (const v of variants) {
  const head = v.from > 0 ? take(a.samples, Math.max(0, aDur - v.from), aDur) : new Float32Array(0);
  const chunk = concat(head, b.samples);
  const totalDur = chunk.length / TARGET_SAMPLE_RATE;
  const r = await asr(chunk);
  console.log(
    `${v.label.padEnd(14)}${totalDur.toFixed(2).padStart(7)}s  ${String(r.cost + 'ms').padStart(8)}  ${terms(r.text)}`
  );
  console.log(`  ${r.text}`);
  console.log('');
}
