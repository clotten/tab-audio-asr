/**
 * check-sendresponse.mjs —— 用 sendResponse 就必须在 onMessage 签名里声明它
 *
 * 踩过两次：写了 `chrome.runtime.onMessage.addListener((msg) => { ... sendResponse(...) })`，
 * 运行时直接 `sendResponse is not defined`，整条消息链路失效，而且只在真机上才暴露。
 *
 * 运行：node tools/check-sendresponse.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './_walk.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let bad = 0;
let checked = 0;

for (const f of walkFiles(root, { ext: ['.js'] })) {
  const src = readFileSync(f, 'utf8');
  if (!/sendResponse\s*\(/.test(src)) continue;

  checked += 1;
  const listener = src.match(/onMessage\.addListener\(([^)]*)\)/);
  const sig = listener ? listener[1] : '';
  const ok = /\bsendResponse\b/.test(sig);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${relative(root, f)} 签名=${sig.trim() || '（没找到监听器）'}`);
  if (!ok) bad += 1;
}

console.log('');
if (bad) {
  console.log(`${bad} 个文件用了 sendResponse 但签名里没声明（共检查 ${checked} 个）`);
  process.exit(1);
}
console.log(`全部通过（检查了 ${checked} 个文件）`);
