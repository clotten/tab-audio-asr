/**
 * probe.js —— 探测当前页面能不能"整段提取"，而不是只能实时录
 *
 * 为什么需要它：实时录制受物理限制——声音必须先播出来才能录到。
 * 但如果页面里能拿到媒体数据本身（直链文件、HLS/DASH 分片、甚至现成字幕），
 * 就可以整段下载 + 转写，**播之前就有全稿**。
 *
 * 探测方式：`performance.getEntriesByType('resource')` 能回看页面**已经发出过**
 * 的所有请求，不需要 hook fetch、也不需要重放。这一个 API 就回答大部分问题。
 *
 * 注入方式：chrome.scripting.executeScript({ files: ['content/probe.js'] })
 *   → 脚本最后一条**表达式语句**的值会作为结果返回，所以整体包成 IIFE。
 *   （默认注入到隔离世界，DOM 和 performance 都读得到，够用且更安全。）
 */

(() => {
  const MEDIA_EXT = {
    '.m3u8': 'hls',
    '.mpd': 'dash',
    '.mp4': 'video',
    '.m4v': 'video',
    '.webm': 'video',
    '.mov': 'video',
    '.mp3': 'audio',
    '.m4a': 'audio',
    '.aac': 'audio',
    '.ogg': 'audio',
    '.opus': 'audio',
    '.flac': 'audio',
    '.wav': 'audio',
    '.ts': 'segment',
    '.m4s': 'segment',
    '.m4f': 'segment',
    '.cmfv': 'segment',
    '.cmfa': 'segment'
  };
  const SUBTITLE_EXT = ['.vtt', '.srt', '.ass', '.ssa'];

  const out = {
    title: document.title,
    url: location.href,
    platform: '',
    videos: [],
    tracks: [],
    media: { hls: [], dash: [], video: [], audio: [], segment: [] },
    subtitles: [],
    mode: 'none',
    reasons: []
  };

  const host = location.hostname;
  out.platform =
    host.includes('bilibili') ? 'bilibili'
    : host.includes('youtube') ? 'youtube'
    : host.includes('v.qq.com') ? 'tencent'
    : host.includes('youku') ? 'youku'
    : host.includes('iqiyi') ? 'iqiyi'
    : host.includes('chaoxing') || host.includes('xuexi') ? 'chaoxing'
    : host.includes('zhihuishu') ? 'zhihuishu'
    : host.includes('icourse163') ? 'mooc'
    : host || 'unknown';

  const lower = (s) => String(s || '').toLowerCase();
  const extOf = (u) => {
    const clean = lower(u).split('?')[0].split('#')[0];
    const i = clean.lastIndexOf('.');
    return i >= 0 ? clean.slice(i) : '';
  };

  // ① 回看页面已发出的所有资源请求（关键：不需要 hook，也不用重放）
  let entries = [];
  try {
    entries = performance.getEntriesByType('resource') || [];
  } catch {
    entries = [];
  }

  const seen = new Set();
  for (const e of entries) {
    const name = String(e.name || '');
    if (!name || seen.has(name)) continue;

    const ext = extOf(name);
    // 只认真正的字幕后缀：URL 里带 subtitle 字样的接口不算（之前误判过）
    if (SUBTITLE_EXT.includes(ext)) {
      if (out.subtitles.length < 20) out.subtitles.push({ url: name, ext });
      continue;
    }

    const type = MEDIA_EXT[ext];
    if (!type) continue;

    seen.add(name);
    const item = { url: name, size: e.transferSize || e.encodedBodySize || 0, initiator: e.initiatorType || '' };
    const bucket = out.media[type];
    if (bucket && bucket.length < 40) bucket.push(item);
  }

  // ② <video> / <audio> 元素
  for (const el of document.querySelectorAll('video,audio')) {
    const src = el.currentSrc || el.src || '';
    out.videos.push({
      tag: el.tagName.toLowerCase(),
      src,
      sources: [...el.querySelectorAll('source')].map((s) => s.src).filter(Boolean),
      duration: Number.isFinite(el.duration) ? Math.round(el.duration) : null,
      readyState: el.readyState,
      hasMSE: !!el.srcObject || lower(src).startsWith('blob:')
    });
  }

  // ③ 字幕轨
  for (const t of document.querySelectorAll('track')) {
    if (!t.src) continue;
    out.tracks.push({ kind: t.kind, label: t.label, srclang: t.srclang, src: t.src });
  }

  // ④ 判定：哪条路走得通
  const video = out.videos.find((v) => v.hasMSE) || out.videos[0] || null;
  const directSrc =
    (video && /^https?:/i.test(video.src || '') ? video.src : '') ||
    (video && (video.sources || []).find((s) => /^https?:/i.test(s))) ||
    '';

  if (out.tracks.length) {
    out.mode = 'subtitle';
    out.reasons.push(`页面有 ${out.tracks.length} 条 <track> 字幕轨，可以直接用`);
  } else if (out.subtitles.length) {
    out.mode = 'subtitle';
    out.reasons.push(`抓到 ${out.subtitles.length} 个字幕资源（.vtt/.srt），可能可直接用`);
  } else if (out.media.hls.length) {
    out.mode = 'hls';
    out.reasons.push(`有 ${out.media.hls.length} 个 m3u8 播放列表，可下载分片拼成整段音频`);
  } else if (out.media.dash.length) {
    out.mode = 'dash';
    out.reasons.push(`有 ${out.media.dash.length} 个 mpd 清单，可只下音频分片`);
  } else if (directSrc) {
    out.mode = 'direct';
    out.reasons.push(`<video> 用的是直链，可整段下载：${directSrc.slice(0, 90)}`);
  } else if (out.media.video.length || out.media.audio.length) {
    out.mode = 'direct';
    out.reasons.push('抓到整段媒体文件请求，可能可整段下载');
  } else if (video && video.hasMSE) {
    out.mode = 'mse';
    out.reasons.push('播放器用 MSE + blob:，没有稳定直链；只能实时录，或从 DASH 分片里拼');
  } else {
    out.mode = 'unknown';
    out.reasons.push('没抓到媒体请求。先点播放几秒，再探测一次');
  }

  if (out.media.segment.length) {
    out.reasons.push(`已抓到 ${out.media.segment.length} 个分片请求（.ts/.m4s），说明播放器按分片取流`);
  }
  if (video && video.duration) out.reasons.push(`当前媒体时长 ${video.duration} 秒`);
  if (out.media.hls.length > 0 && out.media.hls[0].url.includes('m3u8')) {
    out.reasons.push(`播放列表示例：${out.media.hls[0].url.slice(0, 110)}`);
  }

  return out;
})();

