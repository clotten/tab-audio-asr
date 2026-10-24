/**
 * model-compare.mjs —— 到底是"模型不行"还是"上下文不够"？
 *
 * 做法：把同一段网课内容用 TTS 合成两版
 *   短版：单独一句"802.11 无线局域网主要定义了 MAC 协议和帧格式"
 *   长版：前面加两句铺垫，总长约 12 秒
 * 然后拿账号里**所有可用的识别模型**分别识别，检查三个关键术语：
 *   802.11 / MAC / 无线局域网
 *
 * 用法：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/model-compare.mjs
 */

import { readFileSync } from 'node:fs';

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const TTS_MODEL = 'fnlp/MOSS-TTSD-v0.5';
const TTS_VOICE = 'fnlp/MOSS-TTSD-v0.5:alex';

const SHORT = '[S1]802.11 无线局域网主要定义了 MAC 协议和帧格式。';
const LONG =
  '[S1]今天我们来学习无线局域网的组成。[S2]本部分包括三个内容。[S1]802.11 无线局域网主要定义了 MAC 协议和帧格式。';

const TERMS = ['802.11', 'MAC', '无线局域网'];

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
  return Buffer.from(await res.arrayBuffer());
}

function wavInfo(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
  let offset = 12;
  let rate = 16000;
  let blockAlign = 2;
  let dataSize = 0;
  while (offset + 8 <= ab.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      rate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === 'data') {
      dataSize = Math.min(size, ab.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  return { durationSec: dataSize / (rate * blockAlign) };
}

async function asr(wav, model) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'cmp.wav');
  form.append('model', model);
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
  return { status: res.status, cost: Date.now() - t0, text: String(out).trim() };
}

/** 每个术语单独判对错，比整体相似度更能说明问题 */
function termHits(text) {
  const hits = [];
  for (const term of TERMS) {
    if (term === '802.11') {
      hits.push(/802[.\s]*11|八零二点(幺幺|一一|十一)/.test(text) ? '802.11✓' : '802.11✗');
    } else if (term === 'MAC') {
      hits.push(/\bMAC\b|MAC/i.test(text.replace(/MA[Xx]/g, 'MAC')) ? 'MAC✓' : 'MAC✗');
    } else {
      hits.push(text.includes('无线局域网') ? '无线局域网✓' : '无线局域网✗');
    }
  }
  return hits.join(' ');
}

const models = (await (async () => {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const data = await res.json();
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => /ASR|SenseVoice|Paraformer|TeleSpeech/i.test(id) && !/Diarize/i.test(id));
})());

console.log(`可用识别模型：${models.join(', ')}\n`);

for (const [label, text] of [
  ['短版（单句，约 5 秒）', SHORT],
  ['长版（三句，约 12 秒）', LONG]
]) {
  const wav = await tts(text);
  const { durationSec } = wavInfo(wav);
  console.log(`\n===== ${label}  实际 ${durationSec.toFixed(1)}s =====`);
  console.log('模型'.padEnd(40) + '耗时    术语命中');
  console.log('─'.repeat(96));

  for (const model of models) {
    try {
      const r = await asr(wav, model);
      if (r.status !== 200) {
        console.log(`${model.padEnd(40)}${r.status}     ${String(r.text).slice(0, 40)}`);
        continue;
      }
      console.log(`${model.padEnd(40)}${String(r.cost + 'ms').padEnd(8)}${termHits(r.text)}`);
      console.log(`  ${r.text}`);
    } catch (err) {
      console.log(`${model.padEnd(40)}失败：${err.message}`);
    }
  }
}
