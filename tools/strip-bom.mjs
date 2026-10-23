/**
 * strip-bom.mjs —— 去掉扩展源码里的 UTF-8 BOM
 *
 * 为什么需要：Windows PowerShell 的某些写法（ConvertTo-Json | Set-Content 等）
 * 会给文件加上 BOM。对 Chrome 来说 manifest.json 带 BOM 会直接报
 * "Manifest is not valid JSON"，整个扩展装不上；JS/CSS 带 BOM 大多没事，
 * 但会让 `node --check` 之类的工具在别的机器上出怪问题，统一清掉更省心。
 *
 * 运行：node tools/strip-bom.mjs        只检查，不改
 *       node tools/strip-bom.mjs --fix  检查并修复
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');
const EXT = /\.(js|mjs|json|html|css|md|txt)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

const files = walk(root);
const withBom = [];
for (const f of files) {
  const buf = readFileSync(f);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    withBom.push(f);
    if (fix) writeFileSync(f, buf.subarray(3));
  }
}

console.log(`\n扫描 ${files.length} 个文本文件`);
if (!withBom.length) {
  console.log('  PASS  没有 BOM');
} else if (fix) {
  console.log(`  已修复 ${withBom.length} 个文件：`);
  for (const f of withBom) console.log(`    ${relative(root, f)}`);
} else {
  console.log(`  FAIL  ${withBom.length} 个文件带 BOM（加 --fix 修掉）：`);
  for (const f of withBom) console.log(`    ${relative(root, f)}`);
  process.exit(1);
}
console.log('\n全部通过');
