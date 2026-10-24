/**
 * hallucination.js —— 过滤语音模型在"没有真正人声"时编出来的内容
 *
 * 设计原则：**不做内容判断，只做物理约束**，而且阈值必须**按语种分开**。
 *
 * 踩过的坑：上一版用一个 `MAX_CHARS_PER_SEC = 11`（按"中文 字/秒"定的）去卡所有语言。
 * 英文的字符密度天生比中文高——
 *   "all you had to do was strike up a conversation with them"
 * 约 3 秒说完 = 17 字符/秒，被当成"人不可能说这么快"整句丢掉。
 * 这正是语速快的英文视频"缺好多句子"的主因之一（实测约 30% 丢句）。
 *
 * 现在：
 *   1. 只有标点/空白 → 丢（这不是人话）
 *   2. 语速超过物理上限 → 丢（中文 11 字/秒、英文 6 词/秒）
 *   3. 稀疏下限（长音频只出几个字）→ 丢（音乐/噪声里的杂音）
 *   4. 复读：同一 4–20 字符片段出现 ≥4 次且总长 ≥16 → 丢（模型卡住）
 *      阈值比原来宽，避免把"我受够了我受够了"这种**故意重复**误删
 *
 * 而"这段到底有没有人声"交给 Silero VAD 判断，那才是通用解法，不靠猜文本。
 */

/** 中文正常语速上限约 8 字/秒，留余量取 11 */
const MAX_CJK_PER_SEC = 11;

/** 英文正常语速约 3–4 词/秒，快嘴可到 6，取 6 词/秒 */
const MAX_LATIN_WORDS_PER_SEC = 6;

/** 稀疏下限 */
const MIN_CJK_PER_SEC = 0.8;
const MIN_LATIN_WORDS_PER_SEC = 0.5;

/** 复读检测阈值（放宽，避免误删强调式重复） */
const REPEAT_MIN_LEN = 4;
const REPEAT_MIN_COUNT = 4;
const REPEAT_MIN_TOTAL = 16;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/** 去掉空白和标点后的字符数 */
export function contentLength(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').length;
}

/** 这段文本主要是中文还是拉丁字母 */
export function scriptOf(text) {
  const s = String(text || '');
  const cjk = (s.match(CJK_RE) || []).length;
  const latin = (s.match(LATIN_RE) || []).length;
  return cjk >= latin ? 'cjk' : 'latin';
}

/**
 * 复读检测（与内容无关）：同一 4–20 字符片段出现 4 次以上。
 */
export function hasRepetition(text) {
  const s = String(text || '').replace(/[\s\p{P}]/gu, '');
  const maxLen = Math.min(20, Math.floor(s.length / 2));
  for (let len = REPEAT_MIN_LEN; len <= maxLen; len++) {
    const counts = new Map();
    for (let i = 0; i + len <= s.length; i++) {
      const piece = s.slice(i, i + len);
      const n = (counts.get(piece) || 0) + 1;
      counts.set(piece, n);
      if (n >= REPEAT_MIN_COUNT && len * n >= REPEAT_MIN_TOTAL) return true;
    }
  }
  return false;
}

/**
 * 判断一段识别结果是不是"不该收的内容"。
 * @param {string} text 识别文本
 * @param {number} durationMs 这段音频的时长（0/未知时跳过时序判断）
 */
export function looksLikeHallucination(text, durationMs) {
  const s = String(text || '').trim();
  if (!s) return true;

  // ① 只有标点/空白 → 不是人话
  if (!/[\p{L}\p{N}]/u.test(s)) return true;

  const sec = (Number(durationMs) || 0) / 1000;
  const kind = scriptOf(s);
  const words = (s.match(LATIN_RE) || []).length;
  const chars = contentLength(s);

  // ② 语速超过物理上限 → 不可能是这段音频的内容（按语种分别定阈值）
  if (sec > 0.2) {
    if (kind === 'cjk' ? chars / sec > MAX_CJK_PER_SEC : words / sec > MAX_LATIN_WORDS_PER_SEC) return true;
  }

  // ③ 稀疏下限：长音频只出几个字（音乐/噪声）
  if (sec >= 8) {
    if (kind === 'cjk' ? chars / sec < MIN_CJK_PER_SEC : words / sec < MIN_LATIN_WORDS_PER_SEC) return true;
  }

  // ④ 复读
  if (hasRepetition(s)) return true;

  return false;
}
