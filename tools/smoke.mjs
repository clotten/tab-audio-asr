/**
 * smoke.mjs —— 冒烟测试：**打包出来的东西**能不能被浏览器接受
 *
 * 单元测试和仿真测的是源码逻辑；这个脚本测的是"交付物"：
 *   - dist/ 里的 manifest 能被 JSON 解析、没有 BOM、版本号存在
 *   - manifest 引用的每个文件都真的在包里（少一个扩展就装不上）
 *   - 所有 JS 语法可解析
 *   - HTML 里没有内联脚本 / on*= 属性（MV3 CSP 会拦）
 *   - 关键模块能被 Node 真正 import（导出名对得上，不是"看起来对"）
 *   - 包里没有 API Key 泄漏
 *
 * 它故意只依赖 Node 标准库，能在任何机器上跑：
 *   node tools/smoke.mjs            检查 dist/（默认）
 *   node tools/smoke.mjs --src      检查源码目录（还没打包时用）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const asSrc = process.argv.includes('--src');
const root = asSrc ? join(here, '..') : join(here, '..', 'dist', 'tab-audio-asr');

let failed = 0;
let passed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log(`\n冒烟测试：${asSrc ? '源码目录' : 'dist 交付物'} → ${root}`);
if (!existsSync(root)) {
  console.log(`  FAIL  目录不存在：先跑 node tools/build-dist.mjs（默认检查 dist/，加 --src 检查源码目录）`);
  process.exit(1);
}

/* ---------------- 1. manifest ---------------- */
console.log('\n1) manifest');
const manifestPath = join(root, 'manifest.json');
check('manifest.json 存在', existsSync(manifestPath));
const rawManifest = readFileSync(manifestPath);
check('没有 BOM', !(rawManifest[0] === 0xef && rawManifest[1] === 0xbb && rawManifest[2] === 0xbf));

let manifest = null;
try {
  manifest = JSON.parse(rawManifest.toString('utf8'));
} catch (err) {
  check('manifest 能被 JSON 解析', false, String(err.message).slice(0, 80));
}
if (manifest) {
  check('manifest 能被 JSON 解析', true);
  check('manifest_version = 3', manifest.manifest_version === 3, String(manifest.manifest_version));
  check('有版本号', /^\d+\.\d+/.test(String(manifest.version || '')), String(manifest.version));
  check('有 name', !!manifest.name);

  const perms = manifest.permissions || [];
  for (const need of ['tabCapture', 'offscreen', 'storage', 'scripting']) {
    check(`权限包含 ${need}`, perms.includes(need), perms.join(','));
  }
  const csp = manifest.content_security_policy?.extension_pages || '';
  check('CSP 允许 wasm', csp.includes('wasm-unsafe-eval'), csp);
  check('CSP 没放宽到 unsafe-inline', !csp.includes('unsafe-inline'), csp);

  /* ---------------- 2. 引用的文件都在 ---------------- */
  console.log('\n2) manifest 引用的文件');
  const refs = new Set();
  const bg = manifest.background?.service_worker;
  if (bg) refs.add(bg);
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons || {})) refs.add(icon);
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) refs.add(f);
  }
  check('至少引用了一个文件', refs.size > 0, String(refs.size));
  for (const f of refs) {
    check(`存在 ${f}`, existsSync(join(root, f)));
  }
}

/* ---------------- 3. 关键模块能被 import ---------------- */
console.log('\n3) 关键模块可 import（导出名对得上）');
const modules = [
  ['lib/docstore.js', ['buildDoc', 'upsertDoc', 'sanitizeDocs']],
  ['lib/videokey.js', ['videoKeyOf', 'normalizeVideoUrl']],
  ['lib/translate.js', ['buildTranslateMessages', 'parseTranslateReply']],
  ['lib/coverage.js', ['looksTruncated', 'endsMidSentence', 'shouldRetrySplit']],
  ['lib/hallucination.js', ['looksLikeHallucination', 'contentLength']],
  ['lib/incremental.js', ['planInterim', 'splitSentences']],
  ['lib/vad.js', ['detectSpeechRegions', 'createStreamingSegmenter']]
];
for (const [rel, names] of modules) {
  const full = join(root, rel);
  if (!existsSync(full)) {
    check(`${rel} 存在`, false);
    continue;
  }
  try {
    const mod = await import('file://' + full.replace(/\\/g, '/'));
    const missing = names.filter((n) => typeof mod[n] !== 'function');
    check(`${rel} 导出齐全`, missing.length === 0, missing.join(','));
  } catch (err) {
    check(`${rel} 可加载`, false, String(err.message).slice(0, 80));
  }
}

/* ---------------- 4. 静态检查（HTML / JS 语法） ---------------- */
console.log('\n4) HTML 与 JS');
const files = walk(root);
const html = files.filter((f) => f.endsWith('.html'));
const js = files.filter((f) => f.endsWith('.js') && !f.includes('vendor'));

check('至少有一个 HTML', html.length > 0, String(html.length));
for (const f of html) {
  const text = readFileSync(f, 'utf8');
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(text);
  const inlineHandler = /<[a-z][^>]*\son[a-z]+\s*=\s*["']/i.test(text);
  check(`${relative(root, f)} 无内联脚本`, !inlineScript);
  check(`${relative(root, f)} 无 on*= 属性`, !inlineHandler);
}

// JS 语法：用 new Function 粗验（能捕获语法错，不执行）
let syntaxBad = 0;
for (const f of js) {
  const text = readFileSync(f, 'utf8');
  try {
    // 去掉 ESM 语法后扔进 Function，只为验证可解析
    const stripped = text
      .replace(/^\s*export\s+/gm, '')
      .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '');
    // eslint-disable-next-line no-new-func
    new Function(stripped);
  } catch (err) {
    syntaxBad++;
    console.log(`  FAIL  ${relative(root, f)} 语法 → ${String(err.message).slice(0, 70)}`);
  }
}
check('全部 JS 语法可解析', syntaxBad === 0, `${syntaxBad} 个文件有问题`);

/* ---------------- 5. 敏感信息 ---------------- */
console.log('\n5) 敏感信息');
const textFiles = files.filter((f) => /\.(js|json|html|css|md|txt)$/.test(f) && !f.includes('vendor'));
let leaked = 0;
for (const f of textFiles) {
  const text = readFileSync(f, 'utf8');
  if (/sk-[A-Za-z0-9]{20,}/.test(text)) {
    leaked++;
    console.log(`  FAIL  ${relative(root, f)} 里有硬编码的 sk- Key`);
  }
}
check('没有硬编码 API Key', leaked === 0);

/* ---------------- 6. 体积 ---------------- */
console.log('\n6) 体积');
let total = 0;
for (const f of files) total += statSync(f).size;
const mb = total / 1048576;
check('总大小 < 30MB', mb < 30, `${mb.toFixed(1)}MB`);
check('vendor 里有 wasm', files.some((f) => f.includes('vendor') && f.endsWith('.wasm')));
check('vendor 里有 Silero 模型', files.some((f) => f.endsWith('.onnx')));

/* ---------------- 汇总 ---------------- */
const digest = createHash('sha256').update(String(passed) + ':' + String(failed)).digest('hex').slice(0, 8);
console.log('');
if (failed) {
  console.log(`${failed} 项失败（通过 ${passed} 项，指纹 ${digest}）`);
  process.exit(1);
}
console.log(`全部通过：${passed} 项冒烟检查（指纹 ${digest}）`);
