/**
 * sync-permissions.mjs —— 让 manifest 的 host_permissions 覆盖所有平台适配器的媒体域名
 *
 * 为什么需要工具而不是手写：
 *   webRequest 观察器只有在**有该域名 host 权限**时才会收到事件。
 *   少写一个域名，那个平台就"永远抓不到"，而且不报错——很难查。
 *
 * 用法：
 *   node tools/sync-permissions.mjs          检查并打印差异（不写文件）
 *   node tools/sync-permissions.mjs --write   写回 manifest.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../lib/platforms/registry.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const write = process.argv.includes('--write');

const raw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

/** 平台声明的媒体域名 → 需要的 host 权限模式 */
export function requiredOrigins(platforms = PLATFORMS) {
  const out = new Set();
  for (const p of platforms) {
    for (const host of p.mediaHosts || []) out.add(`https://*.${host}/*`);
  }
  return [...out].sort();
}

const have = new Set(manifest.host_permissions || []);
const need = requiredOrigins();
const missing = need.filter((x) => !have.has(x));
const extra = [...have].filter((x) => !need.includes(x) && !x.includes('api.siliconflow.cn'));

console.log(`\n平台媒体域名 ${need.length} 个：`);
for (const x of need) console.log(`  ${have.has(x) ? '✅' : '❌'} ${x}`);

if (missing.length) {
  console.log(`\n缺 ${missing.length} 个 host 权限（没有它们，观察器收不到那些平台的请求）。`);
  if (write) {
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...missing])];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('已写回 manifest.json');
  } else {
    console.log('加 --write 写回 manifest.json');
    process.exitCode = 1;
  }
} else {
  console.log('\nmanifest 已覆盖所有平台 ✓');
}

if (extra.length) {
  console.log(`\n提示：manifest 里还有不属于任何平台的 host 权限：${extra.join(', ')}`);
}
