/**
 * lib/platforms/registry.js —— 平台适配器注册表（解耦点）
 *
 * 目标：主流程（后台 / 钩子 / 探测器）**不知道任何具体平台**，
 * 只问注册表三件事：
 *   1. 这个页面属于哪个平台？（pagePattern）
 *   2. 这个下载链接属于哪个平台？它的 CDN 要不要特殊请求头？（mediaHosts + cdn）
 *   3. 这些候选 URL 里哪条是音轨？（pickAudio）
 *
 * 新增平台只要两步：
 *   ① 新建 lib/platforms/<名字>.js（照 bilibili.js / douyin.js 抄结构）
 *   ② 在下面 PLATFORMS 里加一行 + 在 tools/test-platforms.mjs 里加一条真实样本
 * 主流程一行都不用改。
 */

import bilibili from './bilibili.js';
import douyin from './douyin.js';

export const PLATFORMS = [bilibili, douyin];

/**
 * 适配器必须提供的字段（测试会逐条核对，漏了就报错）。
 *
 * pageResolver 是**可选**的：只有「能用页面登录态现查音轨」的平台才声明它（如 B 站）。
 */
export const REQUIRED_FIELDS = ['id', 'name', 'pagePattern', 'mediaHosts', 'cdn', 'hookPattern', 'markers', 'pickAudio'];

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 当前页面属于哪个平台（按 hostname 匹配 pagePattern） */
export function platformForPage(pageUrl) {
  const host = hostOf(pageUrl);
  if (!host) return null;
  return PLATFORMS.find((p) => p.pagePattern.test(host)) || null;
}

/** 某个下载链接属于哪个平台（按 mediaHosts 后缀匹配） */
export function platformForMedia(mediaUrl) {
  const host = hostOf(mediaUrl);
  if (!host) return null;
  return (
    PLATFORMS.find((p) => (p.mediaHosts || []).some((h) => host === h || host.endsWith('.' + h))) || null
  );
}

/** 平台显示名（找不到就返回空串，调用方自己兜底成"本页"） */
export function platformLabel(url) {
  const p = platformForPage(url) || platformForMedia(url);
  return p ? p.name : '';
}

/**
 * 注入主世界的钩子要用的配置。
 * 钩子不能 import，只能吃序列化参数，所以这里把"所有平台的监听规则"合并成一个正则源码。
 */
export function hookSpec() {
  const patterns = PLATFORMS.map((p) => `(?:${p.hookPattern})`);
  return {
    /** 合并后的正则源码（钩子那边 new RegExp(pattern, 'i')） */
    pattern: patterns.join('|'),
    /** 判断"这条 URL 是音轨还是视频轨"用的关键词 */
    audioMarkers: PLATFORMS.flatMap((p) => p.markers.audio),
    videoMarkers: PLATFORMS.flatMap((p) => p.markers.video)
  };
}

/**
 * 为某个媒体 URL 生成 DNR 会话规则。
 * 返回 { rules, host } —— rules 为空表示这个平台不需要特殊请求头。
 */
export function cdnRulesFor(mediaUrl) {
  const platform = platformForMedia(mediaUrl);
  if (!platform || !platform.cdn) return { rules: [], platform: null };

  const host = hostOf(mediaUrl);
  // 只给命中的那个域名装规则，别的域名不碰
  const matched = (platform.mediaHosts || []).find((h) => host === h || host.endsWith('.' + h));
  if (!matched) return { rules: [], platform };

  const id = platform.cdn.ruleBase + Math.max(0, platform.mediaHosts.indexOf(matched));
  return {
    platform,
    host: matched,
    rules: [
      {
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: platform.cdn.referer },
            { header: 'origin', operation: 'set', value: platform.cdn.origin }
          ]
        },
        condition: {
          urlFilter: `||${matched}`,
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }
    ]
  };
}

/** 所有平台可能需要的规则 id（卸载时一次性清掉） */
export function allRuleIds() {
  const ids = [];
  for (const p of PLATFORMS) {
    const base = p.cdn?.ruleBase;
    if (!Number.isFinite(base)) continue;
    for (let i = 0; i < (p.mediaHosts || []).length; i++) ids.push(base + i);
  }
  return ids;
}

/** 从候选 URL 里挑音轨：先按平台适配器，再退化成"随便一条看起来像媒体的" */
export function pickAudioUrl(urls, { pageUrl = '' } = {}) {
  const list = (urls || []).filter((u) => typeof u === 'string' && /^https?:/i.test(u));
  if (!list.length) return '';

  const platform =
    (pageUrl && platformForPage(pageUrl)) || platformForMedia(list[0]) || null;

  if (platform && typeof platform.pickAudio === 'function') {
    const picked = platform.pickAudio(list);
    if (picked) return picked;
  }

  // 没有适配器认识它：优先 m4s / media-audio，其次 mp4
  return (
    list.find((u) => /media-audio|-30280/i.test(u)) ||
    list.find((u) => /\.m4s|\.m4a/i.test(u)) ||
    list.find((u) => /\.mp4|mime_type=video_mp4/i.test(u)) ||
    ''
  );
}

/**
 * 判断一条实际发出的媒体请求属于哪个平台、是音轨还是视频轨。
 *
 * 为什么需要：抖音这类播放器走 MSE，页面上的 <video> 是 blob:，
 * 播放器也不把音轨地址写进任何 JSON。唯一可靠的信号是它真的发了这条请求，
 * 所以由后台用 webRequest 观察请求，再用这个函数分类。
 */
export function classifyMediaUrl(url) {
  const platform = platformForMedia(url);
  if (!platform) return { platform: null, kind: 'unknown' };
  const u = String(url);
  const has = (markers) => (markers || []).some((m) => m && u.includes(m));
  if (has(platform.markers && platform.markers.audio)) return { platform, kind: 'audio' };
  if (has(platform.markers && platform.markers.video)) return { platform, kind: 'video' };
  return { platform, kind: 'unknown' };
}

/** 这些平台可能产生媒体请求的域名模式（给 webRequest 的 urls 过滤用） */
export function mediaUrlFilters() {
  const out = new Set();
  for (const p of PLATFORMS) {
    for (const h of p.mediaHosts || []) out.add(`*://*.${h}/*`);
  }
  return [...out];
}
