/**
 * api-check.mjs —— 真机联调脚本
 *
 * 目的：不开浏览器，把插件实际会走的链路跑通：
 *   TTS 生成语音（MOSS-TTSD）
 *     → 转成插件发送的格式（16k / 16bit / 单声道 WAV）
 *     → 调 /v1/audio/transcriptions
 *     → 打印识别结果，和原文比对
 *
 * 用法（key 从文件读，不要写进命令历史）：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/api-check.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeWav, resampleBox, mixToMono, TARGET_SAMPLE_RATE } from '../lib/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const BASE = 'https://api.siliconflow.cn/v1';
const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const API_KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();

if (!API_KEY) {
  console.error('缺少 key：设置 SILICONFLOW_API_KEY 或 SILICONFLOW_API_KEY_FILE');
  process.exit(1);
}

const SCRIPT = '[S1]大家好，欢迎来到今天的分享。[S2]今天我们要聊的话题，是网页视频的音频怎么转成文字。[S1]第一步是把标签页正在播放的声音抓下来。[S2]第二步是分段上传，让文字尽快出来。';
const SPEECH_MODEL = 'fnlp/MOSS-TTSD-v0.5';
const VOICE = 'fnlp/MOSS-TTSD-v0.5:alex';

const line = (t = '') => console.log(t);
const hr = (t) => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);

/* --------------------------- 工具 --------------------------- */

/** Node 的 Buffer 不能直接喂给 DataView，先切成独立 ArrayBuffer */
function toArrayBuffer(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/**
 * 严格按 RIFF 规范遍历 chunk 找 fmt / data。
 * 真实世界的 WAV 常常不是"44 字节头 + data"这么干净，
 * 比如 TTS 返回的文件里就夹了额外 chunk，硬编码偏移会读出 0 字节音频。
 */
function parseWav(input) {
  const ab = toArrayBuffer(input);
  const view = new DataView(ab);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));

  if (ab.byteLength < 12) throw new Error('文件太小，不是 WAV');
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件');

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= ab.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, ab.byteLength - body) };
      break;
    }
    offset = body + size + (size % 2); // chunk 按 2 字节对齐
  }

  if (!fmt) throw new Error('找不到 fmt chunk');
  if (!data) throw new Error('找不到 data chunk');

  return {
    ...fmt,
    dataOffset: data.offset,
    dataSize: data.size,
    frames: Math.floor(data.size / (fmt.blockAlign || fmt.channels * (fmt.bitsPerSample / 8))),
    durationSec: data.size / (fmt.sampleRate * fmt.blockAlign)
  };
}

/** 把任意 WAV 转成插件发送的格式：16k / 16bit / 单声道 */
function toPipelineWav(input) {
  const buffer = toArrayBuffer(input);
  const h = parseWav(buffer);
  if (h.audioFormat !== 1) throw new Error(`不是 PCM WAV（format=${h.audioFormat}）`);

  const bytesPerSample = h.bitsPerSample / 8;
  const frames = h.frames;
  const view = new DataView(buffer);

  // 读成每声道独立的 Float32
  const channels = [];
  for (let c = 0; c < h.channels; c++) {
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const offset = h.dataOffset + (i * h.channels + c) * bytesPerSample;
      data[i] = h.bitsPerSample === 16 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
    }
    channels.push(data);
  }

  const merged = { numberOfChannels: h.channels, length: frames, getChannelData: (i) => channels[i] };
  const mono = mixToMono(merged);
  const resampled = resampleBox(mono, h.sampleRate, TARGET_SAMPLE_RATE);
  return { buffer: encodeWav(resampled, TARGET_SAMPLE_RATE), header: h, durationSec: frames / h.sampleRate };
}

function similarity(a, b) {
  const clean = (s) => s.replace(/[\s，。、！？,.!?：:；;"'「」『』（）()【】\-—…]/g, '');
  const A = clean(a);
  const B = clean(b);
  if (!A || !B) return 0;
  // 用字符集合的 Jaccard 系数做个粗估
  const setA = new Set(A);
  const setB = new Set(B);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter++;
  return inter / (setA.size + setB.size - inter);
}

async function asJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/* --------------------------- 1. 模型列表 --------------------------- */

hr('1. 你的 key 能看到哪些语音模型');
try {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const { json, text } = await asJson(res);
  line(`HTTP ${res.status}`);
  if (json?.data) {
    const ids = json.data.map((m) => m.id);
    line(`模型总数：${ids.length}`);
    for (const kw of ['ASR', 'TTSD', 'SenseVoice', 'TeleSpeech', 'CosyVoice']) {
      const hits = ids.filter((id) => id.toLowerCase().includes(kw.toLowerCase()));
      line(`  含 "${kw}"：${hits.length ? hits.join(', ') : '（无）'}`);
    }
  } else {
    line(text.slice(0, 300));
  }
} catch (err) {
  line(`失败：${err.message}`);
}

/* --------------------------- 2. TTS 合成 --------------------------- */

hr('2. 用 MOSS-TTSD 合成一段中文对话');
let speechWav = null;
try {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SPEECH_MODEL,
      input: SCRIPT,
      voice: VOICE,
      response_format: 'wav',
      sample_rate: 16000
    })
  });
  const cost = Date.now() - t0;
  line(`HTTP ${res.status}  耗时 ${cost}ms  content-type=${res.headers.get('content-type')}`);

  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    speechWav = buf;
    writeFileSync(join(OUT, 'tts.wav'), buf);
    const h = parseWav(buf);
    line(`收到音频：${buf.length} 字节  ${h.sampleRate}Hz / ${h.channels}ch / ${h.bitsPerSample}bit`);
    line(`时长约 ${h.durationSec.toFixed(2)} 秒`);
    line(`已保存 tools/out/tts.wav`);
  } else {
    line('失败响应：' + (await res.text()).slice(0, 400));
  }
} catch (err) {
  line(`请求失败：${err.message}`);
}

/* --------------------------- 3. 转成插件发送的格式 --------------------------- */

hr('3. 转成插件实际发送的格式（16k / 16bit / 单声道 WAV）');
let pipelineWav = null;
if (speechWav) {
  try {
    const { buffer, header } = toPipelineWav(speechWav);
    pipelineWav = Buffer.from(buffer);
    writeFileSync(join(OUT, 'pipeline-16k-mono.wav'), pipelineWav);
    const h = parseWav(pipelineWav);
    line(`原格式 ${header.sampleRate}Hz/${header.channels}ch → 新格式 ${h.sampleRate}Hz/${h.channels}ch/${h.bitsPerSample}bit`);
    line(`体积 ${speechWav.length} → ${pipelineWav.length} 字节`);
    line('已保存 tools/out/pipeline-16k-mono.wav');
  } catch (err) {
    line(`转换失败：${err.message}`);
  }
} else {
  line('跳过（没有 TTS 音频）');
}

/* --------------------------- 4. 语音转文字 --------------------------- */

hr('4. 调语音转文字接口');

const cases = [
  { model: 'Qwen/Qwen3-ASR-1.7B', label: 'Qwen3-ASR-1.7B（你手上这个）' },
  { model: 'FunAudioLLM/SenseVoiceSmall', label: 'SenseVoiceSmall（文档里写的）' },
  { model: 'TeleAI/TeleSpeechASR', label: 'TeleSpeechASR（文档里写的）' }
];

const audio = pipelineWav || speechWav;

for (const item of cases) {
  line(`\n--- ${item.label} ---`);
  if (!audio) {
    line('跳过：没有音频');
    continue;
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'segment-000.wav');
    form.append('model', item.model);

    const t0 = Date.now();
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form
    });
    const cost = Date.now() - t0;
    const { json, text } = await asJson(res);

    line(`HTTP ${res.status}  耗时 ${cost}ms`);

    if (res.ok) {
      const out = json?.text ?? text;
      line(`识别结果：${out}`);
      line(`与原文相似度（粗估）：${(similarity(SCRIPT, out) * 100).toFixed(1)}%`);
      if (res.headers.get('x-siliconcloud-trace-id')) {
        line(`trace: ${res.headers.get('x-siliconcloud-trace-id')}`);
      }
    } else {
      line('失败响应：' + text.slice(0, 400));
    }
  } catch (err) {
    line(`请求失败：${err.message}`);
  }
}

hr('跑完了');
