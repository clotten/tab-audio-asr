/**
 * lint-offscreen-apis.mjs —— 专门拦"offscreen 文档里用了 chrome.storage"这类 bug
 *
 * 背景：Chrome 只向屏幕外文档暴露 chrome.runtime Messaging API。
 * 在 offscreen.js 里写 chrome.storage.local 不会在加载时报错，
 * 而是等到真正调用时才抛 `Cannot read properties of undefined (reading 'local')`，
 * 表现得像是"点了开始没反应"——非常难查。所以用静态检查提前拦住。
 *
 * 运行：node tools/lint-offscreen-apis.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 允许在 offscreen 文档里出现的扩展 API（只有 messaging） */
const ALLOWED = new Set(['runtime']);

/** 只检查代码行：整行注释 / 块注释行先剔掉，避免把文档说明误判成调用 */
function codeLines(source) {
  return source
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return true;
    });
}

const FILES = ['offscreen.js'];

let failed = 0;

for (const file of FILES) {
  const source = readFileSync(join(root, file), 'utf8');
  const violations = [];

  for (const { line, no } of codeLines(source)) {
    const matches = line.matchAll(/chrome\.([a-zA-Z]+)/g);
    for (const m of matches) {
      const api = m[1];
      if (!ALLOWED.has(api)) {
        violations.push({ no, api, line: line.trim() });
      }
    }
  }

  if (violations.length) {
    failed += violations.length;
    console.log(`\n✗ ${file}`);
    for (const v of violations) {
      console.log(`   第 ${v.no} 行用了 chrome.${v.api}（offscreen 里不可用）`);
      console.log(`      ${v.line}`);
    }
  } else {
    console.log(`✓ ${file} —— 只用了 chrome.runtime`);
  }
}

console.log('');
if (failed) {
  console.log(`发现 ${failed} 处越界调用。offscreen 文档只有 chrome.runtime，`);
  console.log('其它扩展 API 请通过消息交给 Service Worker 处理。');
  process.exit(1);
}
console.log('检查通过：offscreen 没有越界使用扩展 API。');
