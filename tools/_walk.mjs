/**
 * _walk.mjs —— 统一的文件遍历（测试与检查脚本共用）
 *
 * 为什么会需要它：仓库里除了扩展本体，还躺着一些与发布无关的目录
 * （dist 产物、vendor、以及作者本机的私人文件夹）。检查脚本如果无脑递归，
 * 会把别人的 HTML/JS 也扫进来，报一堆和本项目无关的错。
 *
 * 所以这里维护**一份要跳过的目录名单**，所有检查脚本都用它。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 这些目录不参与"扩展本体"的检查 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '_node',
  '.git',
  '.venv',
  '__pycache__',
  'vendor', // 第三方 wasm/onnx，格式不是我们控制
  'dist', // 打包产物：由 smoke.mjs 专门检查
  // 研究目录里按主题分的私人文件夹（不在本仓库内，防误扫）
  'workbuddy',
  'tts_out',
  '音频数据',
  'LiveTranslate-main',
  'dsh-plugin-conversation-archive',
  '03-workbuddy',
  '02-语音条TTS',
  '04-对话归档插件',
  '90-参考资料',
  '99-依赖与归档'
]);

/** 递归列出文件；dir 默认仓库根 */
export function walkFiles(dir, { ext = null, out = [] } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    // 作者本机的一些私人页面，不属于扩展
    if (/^语音条.*\.html$/i.test(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, { ext, out });
    else if (!ext || ext.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}
