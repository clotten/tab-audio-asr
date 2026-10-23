/**
 * build-dist.mjs —— 打包一个可以发给朋友的扩展目录
 *
 * 只拷"运行时会用到的文件"：
 *   要：manifest / background / offscreen / popup / content / lib / vendor / icons / demo / examples
 *   不要：tools（开发工具、需要 node）、开发笔记、复盘、make_icons.py
 *
 * 输出：dist/tab-audio-asr/（可直接"加载解压缩的扩展"）
 *
 * 运行：node tools/build-dist.mjs
 */

import { cpSync, rmSync, mkdirSync, statSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'tab-audio-asr');

/** 要带上的目录（整个复制） */
const DIRS = ['content', 'lib', 'vendor', 'icons', 'demo', 'examples'];

/** 要带上的单文件 */
const FILES = [
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md'
];

function sizeOf(dir) {
  let total = 0;
  let count = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        total += st.size;
        count += 1;
      }
    }
  };
  walk(dir);
  return { total, count };
}

console.log(`\n构建目录 -> ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src = join(root, f);
  if (!existsSync(src)) {
    console.log(`  跳过（不存在）${f}`);
    continue;
  }
  cpSync(src, join(outDir, f));
  copied += 1;
}
for (const d of DIRS) {
  const src = join(root, d);
  if (!existsSync(src)) {
    console.log(`  跳过（不存在）${d}/`);
    continue;
  }
  cpSync(src, join(outDir, d), { recursive: true });
  copied += 1;
}

// 给朋友一页说明
writeFileSync(
  join(outDir, '给朋友看的说明.txt'),
  [
    '网页音频转文字（Edge / Chrome 扩展，MV3）',
    '',
    '安装：',
    '  1. 打开 edge://extensions/ （Chrome 是 chrome://extensions/）',
    '  2. 打开右上角「开发人员模式」',
    '  3. 点「加载解压缩的扩展」，选这个文件夹（不是压缩包）',
    '',
    '首次使用：',
    '  1. 点工具栏上的插件图标 → 「设置」标签',
    '  2. 填自己的 API Key（硅基流动 https://cloud.siliconflow.cn 注册后创建）',
    '  3. 「转录」标签 → 点一下视频播放 → 点「整段提取」或「开始转录」',
    '',
    '说明：',
    '  · 识别在云端完成，音频会上传到 siliconflow.cn；本插件不保存、不上传日志。',
    '  · API Key 只存在你自己的浏览器里，换电脑要重新填。',
    '  · 直链 mp4 的网站可以「整段提取」（不用等播放）；blob: 的网站只能用实时转录。',
    ''
  ].join('\r\n'),
  'utf8'
);

const { total, count } = sizeOf(outDir);
console.log(`\n完成：${count} 个文件，共 ${(total / 1048576).toFixed(1)} MB`);
console.log('其中体积最大的是 vendor/（ONNX 运行时 + Silero 模型，必须带上，否则 VAD 不可用）');
