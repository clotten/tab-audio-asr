/**
 * correct-test.mjs —— 用真实接口验证"整段纠错"的提示词效果
 *
 * 跑的是插件里真实使用的 buildCorrectionMessages / parseCorrectionResponse，
 * 输入是截图里真实的错字稿。所以这个脚本通过了，插件里那条链路就是通的。
 *
 * 用法：
 *   $env:SILICONFLOW_API_KEY_FILE="C:\...\.siliconflow-key"
 *   node tools/correct-test.mjs [模型名]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse
} from '../lib/glossary.js';

const KEY_FILE = process.env.SILICONFLOW_API_KEY_FILE;
const KEY = (process.env.SILICONFLOW_API_KEY || (KEY_FILE ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('缺少 key');
  process.exit(1);
}

const BASE = 'https://api.siliconflow.cn/v1';
const MODEL = process.argv[2] || 'Qwen/Qwen3-8B';

/** 截图里 00:29–00:52 那段真实识别结果 */
const RAW = [
  { time: '00:29', text: '我们学习无限。' },
  { time: '00:32', text: '本部分包括以下四个内容。' },
  { time: '00:37', text: '县局网的组成。' },
  { time: '00:39', text: '二么么局域网的物理层。' },
  { time: '00:42', text: '么么局域网的MAX协议。' },
  { time: '00:45', text: '八零二么么局域网的麦克针，今天我们学习。' },
  { time: '00:52', text: '嗯。' }
];

const glossaryFile =
  process.argv[3] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'glossary-计算机网络.txt');
const glossary = parseGlossary(readFileSync(glossaryFile, 'utf8'));
console.log(`术语表: ${path.basename(glossaryFile)}（${glossary.pairs.length} 条替换 / ${glossary.terms.length} 个术语）`);

console.log('本地替换后：');
const localFixed = RAW.map((l) => ({ ...l, text: applyGlossary(l.text, glossary) }));
for (const l of localFixed) console.log(`  ${l.time}  ${l.text}`);

console.log(`\n调用 ${MODEL} 做整段纠错…`);
const messages = buildCorrectionMessages(localFixed, glossary);

const t0 = Date.now();
const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, max_tokens: 1024 })
});

if (!res.ok) {
  console.log(`HTTP ${res.status}：${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

const data = await res.json();
const content = data?.choices?.[0]?.message?.content || '';
const parsed = parseCorrectionResponse(content);

console.log(`HTTP 200  ${Date.now() - t0}ms  返回 ${parsed.length}/${RAW.length} 行\n`);
console.log('纠错结果：');
for (const l of parsed) console.log(`  ${l.time}  ${l.text}`);

const merged = localFixed.map((l) => {
  const hit = parsed.find((p) => p.time === l.time);
  return { time: l.time, before: l.text, after: hit ? hit.text : l.text };
});

console.log('\n差异：');
let changed = 0;
for (const m of merged) {
  if (m.before !== m.after) {
    changed++;
    console.log(`  ${m.time}  ${m.before}`);
    console.log(`        → ${m.after}`);
  }
}
console.log(`\n共修改 ${changed}/${merged.length} 行`);

