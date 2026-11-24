/**
 * fmp4.js —— 极简分片 MP4（fMP4）结构解析
 *
 * 为什么需要：B 站的音频轨是分片 MP4（m4s）。整段 `decodeAudioData` 要把
 * 整条音轨解成 PCM —— 83 分钟的视频就是 638MB，浏览器直接回收 offscreen 文档，
 * 还**不给任何报错**。但分片 MP4 天生可以一片一片解：
 *
 *   实测（BV1Qv4y197V6，4988 秒）：
 *   头部 934 字节（ftyp + moov）+ 一个 moof+mdat（196KB）→ decodeAudioData
 *   → 4.99 秒、16kHz、双声道、79872 个采样。完全可用。
 *
 * 所以只要把「初始化段 + 每一片」拼起来单独解码，内存就只跟**一片**有关（几百 KB），
 * 与视频多长无关。
 *
 * 这里只做结构解析，不碰解码，方便单测。
 */

const HEADER_LIMIT = 512 * 1024; // 只为了找 moov，正常几百字节到几 KB

/** 一个 box：[类型, 起始偏移, 大小] */
function readBox(bytes, off) {
  if (off + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(off, false);
  const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
  let header = 8;

  if (size === 1) {
    // 64 位长度（大文件 / 超大 mdat 会用）
    if (off + 16 > bytes.length) return null;
    const hi = view.getUint32(off + 8, false);
    const lo = view.getUint32(off + 12, false);
    size = hi * 4294967296 + lo;
    header = 16;
  } else if (size === 0) {
    // 一直延伸到文件结尾
    size = bytes.length - off;
  }

  if (size < header) return null;
  return { type, off, size, header };
}

/**
 * 从头开始扫连续 box，最多扫到 maxBytes（防止在 mdat 里乱跑）。
 * 遇到 mdat 就停 —— mdat 里是压缩数据，不是 box。
 */
export function scanTopLevel(bytes, { maxBytes = HEADER_LIMIT, maxBoxes = 64 } = {}) {
  const boxes = [];
  let off = 0;
  const limit = Math.min(bytes.length, maxBytes);
  while (off + 8 <= limit && boxes.length < maxBoxes) {
    const box = readBox(bytes, off);
    if (!box) break;
    boxes.push(box);
    if (box.type === 'mdat') break;
    off += box.size;
  }
  return boxes;
}

/** 是不是分片 MP4：有 ftyp + moov，而且 moov 之后紧跟着 moof */
export function isFragmented(bytes) {
  const boxes = scanTopLevel(bytes, { maxBytes: HEADER_LIMIT });
  const hasMoov = boxes.some((b) => b.type === 'moov');
  const hasMoof = boxes.some((b) => b.type === 'moof');
  const hasFtyp = boxes.some((b) => b.type === 'ftyp');
  return hasFtyp && hasMoov && hasMoof;
}

/** 初始化段的字节长度（到 moov 结束为止，含 ftyp/free/sidx 之类） */
export function initSegmentEnd(bytes) {
  const boxes = scanTopLevel(bytes, { maxBytes: HEADER_LIMIT });
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return 0;
  return moov.off + moov.size;
}

/**
 * 把所有分片切成 [start, end) 区间。
 *
 * 规则：一个 moof 和它后面紧跟的 mdat 算一片；中间的 free/skip 顺手带上。
 * 传入的必须是「完整文件」（至少是包含全部 moof 的字节数组）。
 */
export function fragmentSpans(bytes, { initEnd = initSegmentEnd(bytes), maxFragments = 100000 } = {}) {
  const spans = [];
  let off = initEnd;
  const len = bytes.length;
  while (off + 8 <= len && spans.length < maxFragments) {
    const box = readBox(bytes, off);
    if (!box) break;
    if (box.type === 'moof') {
      const start = off;
      let end = off + box.size;
      // 后面紧跟的 mdat（可能还有 free）
      let probe = end;
      while (probe + 8 <= len) {
        const next = readBox(bytes, probe);
        if (!next) break;
        if (next.type === 'mdat') {
          end = probe + next.size;
          break;
        }
        if (next.type === 'moof') break; // 没有 mdat 的怪片，单独成片
        probe += next.size;
      }
      spans.push({ start, end });
      off = end;
      continue;
    }
    // mdat 之外的 box（sidx/free 等）跳过；如果直接撞到 mdat（非分片结构），停
    if (box.type === 'mdat') break;
    off += box.size;
  }
  return spans;
}

/** 一次性给出续跑需要的全部信息 */
export function planFragments(bytes) {
  const initEnd = initSegmentEnd(bytes);
  if (!initEnd) return { ok: false, reason: 'no-moov', initEnd: 0, spans: [], total: 0 };
  const spans = fragmentSpans(bytes, { initEnd });
  if (!spans.length) return { ok: false, reason: 'no-fragments', initEnd, spans: [], total: 0 };
  return {
    ok: true,
    initEnd,
    spans,
    total: bytes.length,
    fragBytes: spans.reduce((n, s) => n + (s.end - s.start), 0)
  };
}

/**
 * 初始化段里到底有没有音轨。
 *
 * 为什么必须有这个检查：抖音的播放器把音轨和视频轨**分成两个 URL**，
 * 抓包时很容易只抓到 media-video 那条。把视频轨喂给 decodeAudioData，
 * 得到的报错是 Unable to decode audio data，用户看到的却是
 * 「没有识别出任何内容（可能整段都是音乐）」——完全误导。
 *
 * 做法：在 moov 里找 handler 类型 soun，或采样描述里的 mp4a/opus/ac-3。
 * 音轨一定有这些标记，视频轨是 vide/avc1/hvc1。
 */
export function hasAudioTrack(bytes) {
  if (!bytes || !bytes.length) return false;
  const end = initSegmentEnd(bytes);
  // moov 在前（分片 MP4）只扫初始化段；moov 在尾（渐进式）就扫整份——
  // 抖音的音轨文件就是 ftyp+free+mdat+moov，只看头部永远找不到 soun。
  const limit = end > 0 ? end : bytes.length;
  const need = ['soun', 'mp4a', 'opus', 'ac-3', 'ec-3'];
  for (let i = 0; i + 4 <= limit; i++) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const d = bytes[i + 3];
    // 只扫可打印字符，避免把二进制塞进字符串
    if (a < 32 || b < 32 || c < 32 || d < 32) continue;
    const s = String.fromCharCode(a, b, c, d);
    if (need.includes(s)) return true;
  }
  return false;
}
