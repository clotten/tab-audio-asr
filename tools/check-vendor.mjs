/**
 * check-vendor.mjs —— 检查 vendor/ 里的 ONNX 运行时是否完整
 *
 * 为什么需要：onnxruntime-web 的 wasm 版本由两个文件组成
 *   ort-wasm-simd-threaded.mjs   ← 加载器（约 24KB）
 *   ort-wasm-simd-threaded.wasm  ← 真正的二进制（13.6MB）
 * 第一次打包时我只拷了 .wasm，结果浏览器报
 *   "no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module"
 * 静态检查能提前拦住这种"少拷一个文件"的问题。
 *
 * 运行：node tools/check-vendor.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

const bundlePath = join(vendorDir, 'ort.wasm.min.js');
const modelPath = join(vendorDir, 'silero_vad_v5.onnx');

console.log('\n1) 必需文件存在');
check('ort.wasm.min.js', existsSync(bundlePath));
check('silero_vad_v5.onnx', existsSync(modelPath));

if (!existsSync(bundlePath)) {
  console.log('\nvendor 缺文件，后续检查跳过');
  process.exit(1);
}

const bundle = readFileSync(bundlePath, 'utf8');

console.log('\n2) bundle 引用的加载器都打包了');
const referenced = [...new Set([...bundle.matchAll(/ort-wasm[a-z0-9.-]*\.(?:mjs|wasm)/g)].map((m) => m[0]))];
check('bundle 里能找到 wasm 文件名', referenced.length > 0, `解析到 ${referenced.length} 个`);

for (const name of referenced) {
  const p = join(vendorDir, name);
  const ok = existsSync(p);
  check(`${name}`, ok, ok ? `${Math.round(statSync(p).size / 1024)}KB` : '缺失');

  // .mjs 里还会引用它要加载的 .wasm，一并核对
  if (ok && name.endsWith('.mjs')) {
    const mjs = readFileSync(p, 'utf8');
    const inner = [...new Set([...mjs.matchAll(/ort-wasm[a-z0-9.-]*\.wasm/g)].map((m) => m[0]))];
    for (const w of inner) {
      check(`  └ ${w}（由 mjs 引用）`, existsSync(join(vendorDir, w)), '缺失');
    }
  }
}

console.log('\n3) 体积合理');
if (existsSync(modelPath)) {
  const mb = statSync(modelPath).size / 1048576;
  check('模型约 2MB 量级', mb > 1 && mb < 5, `${mb.toFixed(2)}MB`);
}
const wasmName = referenced.find((n) => n.endsWith('.wasm'));
if (wasmName && existsSync(join(vendorDir, wasmName))) {
  const mb = statSync(join(vendorDir, wasmName)).size / 1048576;
  check('wasm 约 13MB 量级', mb > 8 && mb < 30, `${mb.toFixed(2)}MB（应该是完整二进制，不是占位文件）`);
}

console.log('\n4) manifest 允许 wasm');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy?.extension_pages || '';
check('CSP 含 wasm-unsafe-eval', csp.includes('wasm-unsafe-eval'), csp || '（未设置）');

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
