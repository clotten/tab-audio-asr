/**
 * check-syntax.mjs —— 逐个文件做语法检查（不能只靠 node --check 手点）
 *
 * 为什么单独做一个工具：
 *   popup.js 里多声明一个 const，整个脚本**直接不执行**——弹窗上所有字段变成"—"，
 *   页面也不报错，只有打开 DevTools 才看得到 "Identifier 'x' has already been declared"。
 *   这类事故靠人肉检查太容易漏，所以放进测试套件里跑。
 *
 * 运行：node tools/check-syntax.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { walkFiles } from './_walk.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 按"模块"编译：扩展里的 .js 大多是 ESM（background/popup/offscreen/lib），
 *  用 SourceTextModule 才能抓到重复声明、保留字等早期错误。 */
function checkModule(source, filename) {
  // Node 的 vm.SourceTextModule 需要 --experimental-vm-modules；
  // 没有它时退化成 new Function（仍能抓大部分语法错误）。
  if (typeof vm.SourceTextModule === 'function') {
    try {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(source, { identifier: filename });
      return null;
    } catch (err) {
      return err;
    }
  }
  try {
    // 去掉 import/export 后当函数体编译（重复声明同样会报错）
    const stripped = source
      .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/^\s*export\s+/gm, '')
      .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
    // eslint-disable-next-line no-new-func
    new Function(stripped);
    return null;
  } catch (err) {
    return err;
  }
}

const files = walkFiles(root, { ext: ['.js'] }).filter((f) => {
  const rel = relative(root, f);
  return !rel.startsWith('vendor') && !rel.includes('node_modules');
});

let bad = 0;
for (const file of files) {
  const rel = relative(root, file);
  const err = checkModule(readFileSync(file, 'utf8'), rel);
  if (err) {
    bad++;
    const line = String(err.stack || '').match(/evalmachine\.<anonymous>:(\d+)/) || [];
    console.log(`  FAIL  ${rel}${line[1] ? ':' + line[1] : ''} → ${err.message}`);
  }
}

console.log('');
if (bad) {
  console.log(`${bad} 个文件有语法错误（共检查 ${files.length} 个）`);
  process.exit(1);
}
console.log(`全部通过（检查了 ${files.length} 个 JS 文件）`);
