/**
 * probe.mjs —— 三个探针，决定"术语纠正"和"加速播放"两条路怎么走
 *
 * A. 识别接口认不认 prompt / hotwords / language（能不能把术语提示直接喂给 ASR）
 * B. 倍速对准确率的影响（2.5x / 3x / 4x，判断"后台快进一遍"是否可行）
 * C. 用 LLM + 术语表纠错的效果（拿截图里真实的错字当输入）
 *
 * 用法（key 从文件读）：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/probe.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key：设置 SILICONFLOW_API_KEY 或 SILICONFLOW_API_KEY_FILE');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const hr = (t) => console.log(`\n${'='.repeat(66)}\n${t}\n${'='.repeat(66)}`);
const line = (t = '') => console.log(t);

const TEXT =
  '[S1]今天我们来学习无线局域网的组成。[S2]802.11 无线局域网的物理层，主要定义了 MAC 协议和帧格式。';
const TTS_MODEL = 'fnlp/MOSS-TTSD-v0.5';
const TTS_VOICE = 'fnlp/MOSS-TTSD-v0.5:alex';
const ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B';

async function json(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const { data } = await json(res);
  return (data?.data || []).map((m) => m.id);
}

async function tts(speed) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: TEXT,
      voice: TTS_VOICE,
      response_format: 'wav',
      sample_rate: 16000,
      speed
    })
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 极简 16k PCM WAV 读出来再过一遍编码，保证送进去的格式和插件一致 */
function toPcm16k(wav) {
  const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  const view = new DataView(ab);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= ab.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, ab.byteLength - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 解析失败');
  const bps = fmt.bitsPerSample / 8;
  const frames = Math.floor(data.size / (bps * fmt.channels));
  return {
    view,
    dataOffset: data.offset,
    frames,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bytesPerSample: bps,
    durationSec: frames / fmt.sampleRate
  };
}

function asrBlob(wav, extra = {}) {
  return async function call(model) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
    form.append('model', model);
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
    const t0 = Date.now();
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
      body: form
    });
    const { data, text } = await json(res);
    return { status: res.status, cost: Date.now() - t0, text: data?.text ?? text };
  };
}

const clean = (s) => s.replace(/[\s，。、！？,.!?：:；;"'「」『』（）()【】\-—…]/g, '');
function similarity(a, b) {
  const A = clean(a);
  const B = clean(b);
  if (!A || !B) return 0;
  const sa = new Set(A);
  const sb = new Set(B);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/* ==================== A. 识别接口是否支持术语提示 ==================== */

hr('A. 识别接口认不认 prompt / hotwords / language');
{
  const wav = await tts(1.0);
  const base = await asrBlob(wav)(ASR_MODEL);
  line(`基线（不带任何提示）：HTTP ${base.status}  ${base.cost}ms`);
  line(`  ${base.text}`);

  const probes = [
    { name: 'prompt', extra: { prompt: '以下是计算机网络的课程录音，涉及 802.11、MAC 帧、无线局域网。' } },
    { name: 'hotwords', extra: { hotwords: '无线局域网 802.11 MAC帧 RTS CTS' } },
    { name: 'language', extra: { language: 'zh' } },
    { name: 'context', extra: { context: '802.11 无线局域网 MAC 帧' } }
  ];

  for (const p of probes) {
    const r = await asrBlob(wav, p.extra)(ASR_MODEL);
    const same = clean(r.text) === clean(base.text);
    line(`\n带 ${p.name}：HTTP ${r.status}  ${r.cost}ms  ${same ? '（结果与基线相同 → 字段被忽略）' : '（结果有变化 → 可能生效）'}`);
    if (r.status !== 200) line(`  响应体：${String(r.text).slice(0, 200)}`);
    else if (!same) line(`  ${r.text}`);
  }
}

/* ==================== B. 倍速对准确率的影响 ==================== */

hr('B. 倍速播放还能不能识别（决定"后台快进一遍"是否可行）');
{
  line('语速   音频时长   识别耗时   相似度   识别文本');
  line('─'.repeat(96));
  for (const speed of [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]) {
    try {
      const wav = await tts(speed);
      const info = toPcm16k(wav);
      const r = await asrBlob(wav)(ASR_MODEL);
      if (r.status !== 200) {
        line(`${speed.toFixed(1)}x   ${info.durationSec.toFixed(2)}s   HTTP ${r.status}`);
        continue;
      }
      line(
        `${speed.toFixed(1)}x   ${info.durationSec.toFixed(2).padStart(6)}s   ${String(r.cost).padStart(6)}ms   ` +
          `${(similarity(TEXT, r.text) * 100).toFixed(1).padStart(5)}%   ${r.text.slice(0, 46)}`
      );
    } catch (err) {
      line(`${speed.toFixed(1)}x   失败：${err.message}`);
    }
  }
}

/* ==================== C. LLM + 术语表纠错 ==================== */

hr('C. 用 LLM + 术语表纠正截图里的真实错字');
{
  const models = await listModels();
  const candidates = models.filter((m) => /Qwen3-8B|Qwen3-4B|Qwen2\.5-7B|Qwen3-30B|GLM-4-9B|Qwen3-14B/i.test(m));
  line(`可用的对话模型候选：${candidates.slice(0, 8).join(', ') || '（无匹配）'}`);
  const chatModel = candidates.find((m) => /8B/i.test(m)) || candidates[0];

  const garbled = [
    '00:29 我们学习无限。',
    '00:37 县局网的组成。',
    '00:39 二么么局域网的物理层。',
    '00:42 么么局域网的MAX协议。',
    '00:45 八零二么么局域网的麦克针，今天我们学习。'
  ].join('\n');

  const glossary = `无线局域网（不是"无限局域网"）、802.11（不会读成"二么么"或"八零二么么"）、
MAC 协议（不是 MAX 协议）、MAC 帧（不是"麦克针"或"马克帧"）、RTS 帧、CTS 帧、ACK 帧、
物理层、组建、局域网`;

  line(`\n用模型：${chatModel || '（没有可用的对话模型）'}`);
  line(`\n原文（截图里识别的结果）：\n${garbled}`);

  if (!chatModel) {
    line('\n跳过：账号里没有可用的对话模型');
  } else {
    const prompt = `下面是一个视频的语音识别结果，有多处同音错字。请依据术语表改正，保持每行"时间戳 + 文本"的格式和行数不变，不要增删内容，不要解释。

术语表：${glossary}

识别结果：
${garbled}`;

    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: 'system', content: '你是中文语音识别稿的校对员，只做同音错字和术语纠错，严格保持行格式。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 512
      })
    });
    const { data, text } = await json(res);
    line(`\nHTTP ${res.status}`);
    if (res.ok) {
      line('纠正后：');
      line(data?.choices?.[0]?.message?.content || '（空）');
    } else {
      line(String(text).slice(0, 300));
    }
  }
}

hr('跑完了');
