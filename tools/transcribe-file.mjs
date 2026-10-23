/**
 * transcribe-file.mjs —— 离线把整个音频文件转成高质量文稿
 *
 * 和插件里的实时通路相比，这里**没有延迟压力**，所以可以：
 *   1. 用更长的语音段（默认 20 秒）送识别 —— 上下文足，术语认得准；
 *   2. 全部转完后做一次整段 LLM 纠错；
 *   3. 丢掉幻觉段（片头音乐那种）。
 *
 * 用法：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/transcribe-file.mjs <音频.wav> [--out 前缀] [--max-region 20000] [--compare 参考.srt] [--no-correct]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { mixToMono, resampleBox, encodeWav, TARGET_SAMPLE_RATE } from '../lib/wav.js';
import { detectSpeechRegions } from '../lib/vad.js';
import {
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse
} from '../lib/glossary.js';
import { looksLikeHallucination } from '../lib/hallucination.js';
import { readChannels } from './wav-read.mjs';

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key：设置 SILICONFLOW_API_KEY 或 SILICONFLOW_API_KEY_FILE');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const ASR_MODEL = process.env.ASR_MODEL || 'Qwen/Qwen3-ASR-1.7B';
const CORRECT_MODEL = process.env.CORRECT_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

/* ---------------------------- 参数 ---------------------------- */

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--') && /\.(wav|mp3|m4a|ogg)$/i.test(a));
if (!input) {
  console.error('用法：node tools/transcribe-file.mjs <音频文件> [--out 前缀] [--max-region 毫秒] [--compare x.srt] [--no-correct]');
  process.exit(1);
}
const getOpt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes('--' + name);

const outPrefix = getOpt('out', join(dirname(input), basename(input, extname(input)) + '-asr'));
const maxRegionMs = Number(getOpt('max-region', 20000));
const comparePath = getOpt('compare', null);
const doCorrect = !hasFlag('no-correct');

// 术语表默认空（通用）；需要时用 --glossary 指向自己的文件，例如 examples/glossary-计算机网络.txt
const glossaryPath = getOpt('glossary', '');
const glossary = parseGlossary(glossaryPath && existsSync(glossaryPath) ? readFileSync(glossaryPath, 'utf8') : DEFAULT_GLOSSARY_TEXT);
if (glossaryPath) {
  console.log(` 术语表: ${basename(glossaryPath)}（${glossary.pairs.length} 条替换 / ${glossary.terms.length} 个术语）`);
}
const clean = (t) => applyGlossary(String(t || '').trim(), glossary);

/* ---------------------------- 读音频 ---------------------------- */

console.log(`\n读取 ${basename(input)} …`);
const raw = readFileSync(input);
const { header, channels } = readChannels(raw);
const mono = mixToMono({
  numberOfChannels: channels.length,
  length: header.frames,
  getChannelData: (i) => channels[i]
});
const samples = header.sampleRate === TARGET_SAMPLE_RATE ? mono : resampleBox(mono, header.sampleRate, TARGET_SAMPLE_RATE);
const durSec = samples.length / TARGET_SAMPLE_RATE;

console.log(`  ${header.sampleRate}Hz / ${header.channels}ch → 16k 单声道，时长 ${durSec.toFixed(1)}s（${(durSec / 60).toFixed(2)} 分钟）`);

/* ---------------------------- 切句 ---------------------------- */

const regions = detectSpeechRegions(samples, TARGET_SAMPLE_RATE, {
  maxRegionMs,
  targetMinMs: 3000,
  minGapMs: 700,
  maxJoinGapMs: 2500
});

console.log(`  切出 ${regions.length} 段，平均 ${(regions.reduce((n, r) => n + r.durationMs, 0) / Math.max(1, regions.length) / 1000).toFixed(1)}s/段`);

/* ---------------------------- 逐段识别 ---------------------------- */

const fmtMmSs = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
};

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

async function transcribe(region) {
  const slice = samples.subarray(region.startSample, region.endSample);
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
      await new Promise((r) => setTimeout(r, 1200 * attempt));
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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  throw new Error('重试 3 次失败');
}

const items = [];
let dropped = 0;
const t0 = Date.now();

for (let i = 0; i < regions.length; i++) {
  const r = regions[i];
  let text = '';
  try {
    text = await transcribe(r);
  } catch (err) {
    console.log(`  [${i + 1}/${regions.length}] 失败：${err.message}`);
    continue;
  }

  const fixed = clean(text);
  const bad = !fixed || looksLikeHallucination(fixed, r.durationMs);

  if (bad) {
    dropped += 1;
    console.log(`  [${i + 1}/${regions.length}] ${fmtMmSs(r.startMs)} 丢弃（疑似幻觉/噪声）：${text}`);
    continue;
  }

  items.push({ startMs: r.startMs, durationMs: r.durationMs, text: fixed });
  console.log(`  [${i + 1}/${regions.length}] ${fmtMmSs(r.startMs)} ${fixed}`);
}

console.log(`\n识别完成：${items.length} 句，丢弃 ${dropped} 段，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ---------------------------- 整段纠错 ---------------------------- */

if (doCorrect && items.length) {
  console.log(`\n整段纠错（${CORRECT_MODEL}）…`);
  const BATCH = 40;
  let changed = 0;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const lines = batch.map((it) => ({ time: fmtMmSs(it.startMs), text: it.text }));
    const messages = buildCorrectionMessages(lines, glossary);

    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CORRECT_MODEL, messages, temperature: 0.1, max_tokens: 2048 })
      });
      if (!res.ok) {
        console.log(`  HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
        continue;
      }
      const data = await res.json();
      const parsed = parseCorrectionResponse(data?.choices?.[0]?.message?.content || '');

      for (let k = 0; k < batch.length; k++) {
        const it = batch[k];
        const next = parsed.length === batch.length ? parsed[k]?.text : parsed.find((p) => p.time === fmtMmSs(it.startMs))?.text;
        if (!next) continue;
        const fixed = clean(next);
        if (fixed && fixed !== it.text) {
          it.before = it.text;
          it.text = fixed;
          changed += 1;
        }
      }
    } catch (err) {
      console.log(`  纠错失败：${err.message}`);
    }
  }
  console.log(`  改动 ${changed}/${items.length} 句`);
  for (const it of items) {
    if (it.before) console.log(`    ${fmtMmSs(it.startMs)}  ${it.before}\n         → ${it.text}`);
  }
}

/* ---------------------------- 输出 ---------------------------- */

const srt = items
  .map((it, i) => {
    const start = it.startMs;
    const end = start + Math.max(600, it.durationMs);
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${it.text}\n`;
  })
  .join('\n');

writeFileSync(`${outPrefix}.srt`, srt, 'utf8');
writeFileSync(
  `${outPrefix}.txt`,
  items.map((it) => `[${fmtMmSs(it.startMs)}] ${it.text}`).join('\n'),
  'utf8'
);

console.log(`\n已写出：\n  ${outPrefix}.srt\n  ${outPrefix}.txt`);

/* ---------------------------- 与参考 SRT 对比 ---------------------------- */

if (comparePath) {
  const ref = readFileSync(comparePath, 'utf8');
  const refSegs = [...ref.matchAll(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?=\n\d+\n|\n*$)/g)].map((m) => ({
    start: m[1],
    text: m[3].trim().replace(/\n/g, ' ')
  }));

  const refText = refSegs.map((s) => s.text).join('');
  const newText = items.map((s) => s.text).join('');

  // 用"错误写法出现次数"当质量指标：帧被听成针/真/贞，MAC 被听成 MAX/back 等
  const probes = [
    ['帧（正确）', /帧/g],
    ['针/真/贞（错）', /[针真贞]/g],
    ['MAC（正确）', /MAC/g],
    ['MAX/back（错）', /MA[Xx]|back/gi],
    ['802.11 变体', /八[零点]|幺幺|二幺幺|幺点|802[.\s]*11/g],
    ['首部（正确）', /首部/g],
    ['手部（错）', /手部/g]
  ];

  console.log(`\n===== 对比：插件实时 SRT（${refSegs.length} 句）vs 离线（${items.length} 句） =====`);
  console.log('指标'.padEnd(18) + '插件实时'.padStart(10) + '离线'.padStart(12));
  console.log('─'.repeat(46));
  console.log('总字数'.padEnd(17) + String(refText.length).padStart(11) + String(newText.length).padStart(12));
  for (const [label, re] of probes) {
    const a = (refText.match(re) || []).length;
    const b = (newText.match(re) || []).length;
    console.log(label.padEnd(17) + String(a).padStart(11) + String(b).padStart(12));
  }
}

