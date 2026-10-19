/**
 * hallucination.js —— 过滤语音模型在"没有真正人声"时编出来的内容
 *
 * 设计原则：**不收句子黑名单**。
 *
 *   上一版我写了一串具体句子（"I'm a man of few words"、"中国共产党中央委员会"…），
 *   那是特例处理：换个模型、换个语言就漏，还容易误伤真的说了这句话的音频。
 *
 *   现在只保留**与内容无关的物理约束**，三条都不依赖任何具体词：
 *
 *   1. 语速上限：人说话有物理极限。单位时间字数超过 11 字/秒 → 不可能是这段音频的内容。
 *   2. 稀疏下限：长音频只出几个字 → 那是音乐/噪声里的杂音，不是句子。
 *   3. 复读：模型卡住时会反复输出同一片段（"谢谢观看谢谢观看谢谢观看"）——
 *      这是自回归模型的典型故障，与语义无关。
 *
 *   而"这段到底有没有人声"这个根本问题，交给 Silero VAD（lib/silero.js）在识别前判断，
 *   那才是通用解法，不靠猜测输出文本。
 */

/** 中文正常语速上限约 8 字/秒，留点余量取 11 字/秒 */
const MAX_CHARS_PER_SEC = 11;

/** 长时间只出几个字，基本是音乐/噪声（正常语速 3–6 字/秒） */
const MIN_CHARS_PER_SEC = 0.8;

/** 复读检测：同一片段重复这么多次就认为是故障 */
const REPEAT_MIN_LEN = 3;
const REPEAT_MIN_COUNT = 3;
const REPEAT_MIN_TOTAL = 9;

/** 去掉空白和标点后的字数 */
export function contentLength(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').length;
}

/**
 * 复读检测（与内容无关）：同一段 4–20 字的片段出现 3 次以上。
 * 只看"有没有反复出现同一串"，不需要知道那串是什么。
 */
export function hasRepetition(text) {
  const s = String(text || '').replace(/[\s\p{P}]/gu, '');
  // 注意：不要用"长度 ≥ 3×词长"这种上限判断——重叠匹配时
  // "好的好的好的好的"（8 字）里同一 3 字段出现 3 次，长度只有 8。
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
 * @param {number} durationMs 这段音频的时长
 */
export function looksLikeHallucination(text, durationMs) {
  const s = String(text || '').trim();
  if (!s) return true;

  // 只有标点/空白
  if (!/[\p{L}\p{N}]/u.test(s)) return true;

  const chars = contentLength(s);
  if (!chars) return true;

  const sec = Math.max(0.2, (Number(durationMs) || 0) / 1000);

  // ① 太快 → 物理上不可能
  if (chars / sec > MAX_CHARS_PER_SEC) return true;

  // ② 太稀 → 长音频只出几个字（正常语速 3–6 字/秒）
  if (sec >= 8 && chars / sec < MIN_CHARS_PER_SEC) return true;

  // ③ 复读 → 模型卡住了
  if (hasRepetition(s)) return true;

  return false;
}
