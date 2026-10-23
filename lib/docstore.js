/**
 * docstore.js —— 按视频保存/读取字幕稿（"字幕库"）
 *
 * 存在哪、为什么：
 *   放 `chrome.storage.local` 的 `asrDocs` 字段下，而不是 IndexedDB。
 *   原因：内容脚本（面板）跑在**页面**的源上，它的 IndexedDB 属于那个网站，
 *   不是扩展的；只有 Service Worker / offscreen / popup 共享扩展源。字幕库要
 *   "任意页面都能读到"，所以走 chrome.storage 最省事，而且三个地方都能访问。
 *   体积上也够：一份稿子约 6–12KB，本地配额 10MB，存几百份没问题。
 *
 * 这个文件是**纯函数**：输入输出都是普通对象，不碰 chrome.*，
 * 方便 tools/test-docstore.mjs 覆盖容量清理、排序、去重等逻辑。
 */

/** 最多保留多少份稿子，超了淘汰最旧的 */
export const MAX_DOCS = 80;

/** 一份稿子最短也要有点内容才值得存 */
const MIN_SEGMENTS = 1;

/**
 * 把一次会话整理成可存储的文档。
 * @param {{key:string, segments:Array, model?:string, title?:string, durationMs?:number, createdAt?:number}} input
 */
export function buildDoc({ key, segments, model = '', title = '', durationMs = 0, createdAt = 0 }) {
  if (!key) return null;

  const kept = (segments || [])
    .filter((s) => s && s.status === 'done' && s.text)
    .map((s) => {
      const item = {
        startMs: Math.max(0, Math.round(s.startMs || 0)),
        durationMs: Math.max(0, Math.round(s.durationMs || 0)),
        text: String(s.text)
      };
      // 译文也要存：否则从字幕库恢复后双语就没了（真机踩过）
      if (s.translation) item.translation = String(s.translation);
      return item;
    })
    .sort((a, b) => a.startMs - b.startMs);

  if (kept.length < MIN_SEGMENTS) return null;

  const text = kept.map((s) => s.text).join('\n');
  return {
    key,
    title: String(title || '').slice(0, 200),
    model: String(model || '').slice(0, 80),
    durationMs: Math.max(0, Math.round(durationMs || 0)),
    createdAt: createdAt || Date.now(),
    count: kept.length,
    chars: text.length,
    segments: kept
  };
}

/** 取一份稿子（找不到返回 null） */
export function getDoc(docs, key) {
  if (!docs || !key) return null;
  return Object.prototype.hasOwnProperty.call(docs, key) ? docs[key] : null;
}

/**
 * 写入一份稿子，返回新的 docs 对象（不改原对象）。
 * 超过 MAX_DOCS 时按 createdAt 淘汰最旧的。
 */
export function upsertDoc(docs, doc, { max = MAX_DOCS } = {}) {
  if (!doc || !doc.key) return docs || {};
  const next = { ...(docs || {}), [doc.key]: doc };
  return pruneDocs(next, { max });
}

/** 淘汰到不超过 max 份 */
export function pruneDocs(docs, { max = MAX_DOCS } = {}) {
  const keys = Object.keys(docs || {});
  if (keys.length <= max) return docs || {};

  const sorted = keys
    .map((k) => ({ k, at: docs[k]?.createdAt || 0 }))
    .sort((a, b) => b.at - a.at); // 新的在前

  const next = {};
  for (const { k } of sorted.slice(0, Math.max(0, max))) next[k] = docs[k];
  return next;
}

/** 列表（不含正文，用于展示；按时间新→旧） */
export function listDocs(docs) {
  return Object.keys(docs || {})
    .map((k) => {
      const d = docs[k] || {};
      return {
        key: k,
        title: d.title || '',
        count: d.count || 0,
        chars: d.chars || 0,
        model: d.model || '',
        createdAt: d.createdAt || 0
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 删除一份，返回新的 docs 对象 */
export function removeDoc(docs, key) {
  if (!docs || !key || !(key in docs)) return docs || {};
  const next = { ...docs };
  delete next[key];
  return next;
}

/** 存进来的结构坏了也能兜住：统一洗成对象 */
export function sanitizeDocs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    if (!Array.isArray(v.segments) || !v.segments.length) continue;
    out[k] = v;
  }
  return out;
}

