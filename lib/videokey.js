/**
 * videokey.js —— 给"这个页面上的这个视频"算一个稳定标识
 *
 * 为什么需要：字幕必须按视频隔离。之前所有稿件共用一个 session，
 * 换一个视频会照样显示上一个视频的字幕（不同课程内容混在一起，很危险）。
 *
 * 键的构成：来源 + 路径 + 视频标识（尽量去掉会变的签名参数）
 *   1. 去掉 query/hash 里的签名类参数（auth_key、sign、expires、token…）
 *   2. 保留能真正区分视频的参数（aid/bvid/vid/cid/videoId/chapter）
 *   3. 拼上视频时长——同一页面换集（时长不同）也能分清
 *
 * 纯函数，可离线测试。
 */

/** 会变化、但不代表"另一个视频"的参数 */
const VOLATILE_PARAMS = /^(auth_?key|sign|signature|expires?|e|token|ts|timestamp|t|nonce|rand|from_source|spm|share_\w+|vd_source|utm_\w+|referer|referrer)$/i;

/** 能真正区分视频的参数（保留） */
const ID_PARAMS = /^(aid|bvid|vid|video_?id|cid|chapter|chapter_?id|node_?id|course_?id|lesson_?id|id|p)$/i;

/**
 * 把 URL 归一化成"同一个视频在刷新/换签名后仍相同"的形式。
 * @param {string} href 完整 URL
 */
export function normalizeVideoUrl(href) {
  let u;
  try {
    u = new URL(String(href || ''));
  } catch {
    return String(href || '');
  }

  const keep = [];
  for (const [k, v] of u.searchParams) {
    if (VOLATILE_PARAMS.test(k)) continue;
    if (ID_PARAMS.test(k)) keep.push(`${k}=${v}`);
  }

  // 路径可能带临时 id（/video/1234567），一并保留；去掉末尾斜杠
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}${keep.length ? '?' + keep.sort().join('&') : ''}`;
}

/**
 * 视频标识：归一化 URL + 时长（秒）。
 * 时长取整到秒，避免浮点抖动；拿不到时长就只用 URL。
 */
export function videoKeyOf({ href, duration } = {}) {
  const base = normalizeVideoUrl(href);
  const d = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
  return d == null ? base : `${base}#${d}s`;
}

/** 两个键是否指向同一个视频（任一方为空时视为"无法判断"） */
export function sameVideo(a, b) {
  if (!a || !b) return true; // 信息不足时不要误伤，交由调用方展示提示
  return a === b;
}
