/**
 * lint-csp.mjs —— 检查扩展页面里有没有会被 MV3 CSP 拦掉的写法
 *
 * 背景：为了跑 wasm，manifest 里给扩展页加了
 *   script-src 'self' 'wasm-unsafe-eval'
 * 这条策略**不允许内联脚本**。之前 demo/test-page.html 里有一段
 * `<script>…</script>`，加完 CSP 之后自测页直接报：
 *   "Executing inline script violates the following Content Security Policy directive"
 * 页面功能全挂，但只有真的点开自测页才会发现。
 *
 * 这个检查把这类问题提前到命令行。
 *
 * 运行：node tools/lint-csp.mjs
 */

import { readFileSync } from 'node:fs';
import { walkFiles } from './_walk.mjs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}


const pages = walkFiles(root, { ext: ['.html'] });
console.log(`\n1) 扫描 ${pages.length} 个 HTML`);
check('至少找到一个页面', pages.length > 0, String(pages.length));

console.log('\n2) 不允许内联 <script>（MV3 CSP 会拦）');
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html);
  check(`${relative(root, file)} 没有内联脚本`, !inline, '有 <script> 没写 src');
}

console.log('\n3) 不允许内联事件处理器（onclick 等同样被拦）');
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  // 只看标签内部的属性，避免误伤 JS 字符串
  const hit = [...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=\s*["']/gi)].map((m) => m[0].trim());
  check(`${relative(root, file)} 没有 on*= 属性`, hit.length === 0, hit.slice(0, 3).join(' | '));
}

console.log('\n4) manifest 的 CSP 允许 wasm');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy?.extension_pages || '';
check('含 wasm-unsafe-eval', csp.includes('wasm-unsafe-eval'), csp || '（未设置）');
check("含 script-src 'self'", /script-src[^;]*'self'/.test(csp), csp);
check('没有放宽到 unsafe-inline', !csp.includes('unsafe-inline'), csp);

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
