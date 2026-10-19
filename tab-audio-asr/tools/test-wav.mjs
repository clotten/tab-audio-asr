/**
 * wav.js 的离线自测：验证 WAV 头、时长、降采样。
 * 运行：node tools/test-wav.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeWav, makeToneWav, resampleBox, TARGET_SAMPLE_RATE } from '../lib/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

function parseWav(buffer) {
  const view = new DataView(buffer);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(buffer, o, n));
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    totalBytes: buffer.byteLength
  };
}

console.log('1) WAV 头结构');
const tone = makeToneWav({ seconds: 1, freq: 440 });
const h = parseWav(tone);
check('RIFF/WAVE', h.riff === 'RIFF' && h.wave === 'WAVE');
check('PCM 格式', h.audioFormat === 1, `got ${h.audioFormat}`);
check('单声道', h.channels === 1, `got ${h.channels}`);
check('16kHz', h.sampleRate === TARGET_SAMPLE_RATE, `got ${h.sampleRate}`);
check('16bit', h.bitsPerSample === 16);
check('byteRate = rate*2', h.byteRate === h.sampleRate * 2, `got ${h.byteRate}`);
check('blockAlign = 2', h.blockAlign === 2);
check('dataSize 正确', h.dataSize === 1 * TARGET_SAMPLE_RATE * 2, `got ${h.dataSize}`);
check('总长度 = 44 + dataSize', h.totalBytes === 44 + h.dataSize);

console.log('2) 时长与振幅');
const frames = (h.dataSize / 2);
check('1 秒 = 16000 帧', frames === 16000, `got ${frames}`);
const view = new DataView(tone);
let peak = 0;
let sumSq = 0;
for (let i = 0; i < frames; i++) {
  const v = view.getInt16(44 + i * 2, true) / 32768;
  peak = Math.max(peak, Math.abs(v));
  sumSq += v * v;
}
const rms = Math.sqrt(sumSq / frames);
check('峰值不超过 1', peak <= 1, `peak=${peak.toFixed(3)}`);
check('不是静音', rms > 0.05, `rms=${rms.toFixed(3)}`);
check('振幅符合 0.3 设计值', Math.abs(peak - 0.3) < 0.02, `peak=${peak.toFixed(3)}`);

console.log('3) 降采样 48k -> 16k');
const in48 = new Float32Array(48000);
for (let i = 0; i < in48.length; i++) in48[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
const out16 = resampleBox(in48, 48000, 16000);
check('长度 1/3', out16.length === 16000, `got ${out16.length}`);
let peak2 = 0;
for (const v of out16) peak2 = Math.max(peak2, Math.abs(v));
check('振幅基本保持', Math.abs(peak2 - 0.5) < 0.06, `peak=${peak2.toFixed(3)}`);

console.log('4) 同采样率不重采样');
const same = resampleBox(in48, 48000, 48000);
check('原样返回', same === in48);

const out = join(here, 'tone.wav');
writeFileSync(out, Buffer.from(tone));
console.log(`\n已写出 ${out}（${tone.byteLength} 字节）`);

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
