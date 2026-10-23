/**
 * compare-subs.mjs —— 把"我们的转录"和"参考字幕"逐句对比，算漏了多少
 *
 * 用法：
 *   node tools/compare-subs.mjs <参考字幕文件> <我们的转录文件>
 *
 * 参考字幕支持两种格式：
 *   `MM:SS` 文本      ← B 站/剪藏导出的样式
 *   MM:SS --> MM:SS   ← SRT
 * 我们的转录就是纯文本（TXT 导出的也行）。
 *
 * 判定方式：按"实词命中率"逐句比对（忽略 the/a 这类虚词），
 * 命中 < 50% 的句子列为疑似漏句。这是实测最灵敏的方式——
 * 字数比会被"意译 vs 直译"干扰，实词命中不会。
 */
import { readFileSync } from 'node:fs';

const [, , refPath, ourPath] = process.argv;
if (!refPath || !ourPath) {
  console.log('用法: node tools/compare-subs.mjs <参考字幕> <我们的转录>');
  process.exit(1);
}

const STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','at','for','with','that','this','it','is','are','was','were',
  'be','been','i','you','he','she','we','they','me','my','your','his','her','our','their','so','if','when','as','do',
  'not','no','just','like','what','who','how','get','got'
]);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const contentWords = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

function parseRef(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m1 = line.match(/^`?(\d{1,2}:\d{2})`?\s+(.*)$/);
    const m2 = line.match(/^(\d{1,2}:\d{2}:\d{2},\d{3})\s*-->/);
    if (m1) out.push({ t: m1[1], text: m1[2].trim() });
    else if (!m2 && out.length && line.trim() && !/^\d+$/.test(line.trim())) {
      // SRT 正文行：接到上一条
      out[out.length - 1].text += ' ' + line.trim();
    }
  }
  return out.filter((x) => x.text && contentWords(x.text).length);
}

const ref = parseRef(readFileSync(refPath, 'utf8'));
const oursRaw = readFileSync(ourPath, 'utf8');
const oursSet = new Set(contentWords(oursRaw));
const ours = oursRaw.split(/\r?\n/).filter(Boolean);

let total = 0;
let hit = 0;
const missed = [];
for (const line of ref) {
  const w = contentWords(line.text);
  total += w.length;
  const h = w.filter((x) => oursSet.has(x)).length;
  hit += h;
  if (h / w.length < 0.5) missed.push({ ...line, h, n: w.length });
}

console.log(`参考字幕：${ref.length} 条 / ${total} 个实词`);
console.log(`我们的转录：${ours.length} 行 / ${contentWords(oursRaw).length} 个实词`);
console.log(`实词命中率：${((hit / total) * 100).toFixed(1)}%（${hit}/${total}）`);
console.log(`\n疑似漏句（命中 < 50%）：${missed.length} 条`);
for (const m of missed) console.log(`  ${m.t}  [${m.h}/${m.n}]  ${m.text.slice(0, 80)}`);
console.log(missed.length ? `\n结论：漏了约 ${((missed.length / ref.length) * 100).toFixed(0)}% 的句子` : '\n结论：没有明显漏句');