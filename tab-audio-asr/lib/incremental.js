/**
 * incremental.js —— 增量识别的纯逻辑（不碰网络、不碰 DOM，可离线测试）
 *
 * 思路借鉴 LiveTranslate 的增量 ASR：
 *
 *   语音还在说的时候，对"正在增长的缓冲"反复跑识别。每次识别的结果里，
 *   **除了最后一句**（还在说）之外都已经完整了 → 提交出去，并把对应的音频
 *   从缓冲头部裁掉。这样：
 *     · 长段独白也能一句话一句话地出字，不用等到停顿；
 *     · 切点由**文本标点**决定，不会把句子从中间切断（这正是"定稿比预览还差"的根因）；
 *     · 裁掉已提交的音频 + 记住已提交文本尾巴 → 下一轮不会重复输出。
 *
 * 四个关键子步骤都放在这里，方便单独测试：
 *   splitSentences()        按标点切句（含逗号兜底）
 *   isShortUtterance()      ≤8 个字母数字的碎片，攒着不单独输出
 *   stripCommittedOverlap() 去掉与已提交内容重叠的前缀（回声）
 *   planInterim()           把这些组合成"提交哪些句子 + 裁掉多少音频"
 */

/**
 * 句子结束标点。
 *
 * 英文句点要特别小心：`802.11`、`3.5 秒` 里的点不是句末。所以只认
 * "后面跟空白或结尾"的点（`\.(?=\s|$)`）。这条规则与领域无关，纯语法。
 */
const SENTENCE_END = /(?:[。！？!?；;…]+|\.(?=\s|$))["'”’）)】\]]?/g;

/** 逗号兜底阈值：中文 25 字，其它 60 字（长句降延迟） */
const COMMA_FALLBACK_CJK = 25;
const COMMA_FALLBACK_DEFAULT = 60;

/** 短句阈值：拉丁文按字母数字算 8 个；中日韩文字信息密度高，3 个字就算一句了 */
const SHORT_MAX_LATIN = 8;
const SHORT_MAX_CJK = 3;

/** 裁音频的安全余量（防回声）与最少保留量 */
const TRIM_MARGIN_MS = 300;
const TRIM_KEEP_MS = 500;

/** 统计"字母数字"个数（中文按字算，标点不算） */
export function alnumCount(text) {
  let n = 0;
  for (const ch of String(text || '')) if (/\p{L}|\p{N}/u.test(ch)) n += 1;
  return n;
}

/**
 * 按标点切句，保留标点。
 * 若切不开（长句没有句末标点），退回"最后一个逗号处切"。
 */
export function splitSentences(text) {
  const s = String(text || '').trim();
  if (!s) return [];

  const parts = [];
  let last = 0;
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(s)) !== null) {
    const end = m.index + m[0].length;
    const piece = s.slice(last, end).trim();
    if (piece) parts.push(piece);
    last = end;
  }
  const rest = s.slice(last).trim();
  if (rest) parts.push(rest);

  if (parts.length > 1) return parts;

  // 逗号兜底：只有一句且很长，就在最后一个逗号处切开，降低等待。
  // 中文的逗号本身就是分句手段，所以阈值比英文低。
  const cjkChars = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const isCJK = cjkChars / s.length > 0.3;
  const threshold = isCJK ? COMMA_FALLBACK_CJK : COMMA_FALLBACK_DEFAULT;
  if (s.length > threshold) {
    for (let i = s.length - 8; i > 5; i--) {
      if (',，;；、'.includes(s[i])) {
        const before = s.slice(0, i + 1).trim();
        const after = s.slice(i + 1).trim();
        // 太短的半边不切，否则又制造碎片
        if (before && after && before.length > 15 && after.length > 3) return [before, after];
      }
    }
  }

  return parts;
}

/**
 * 是不是"碎片"：这种不单独输出，攒到下一句前面。
 * 阈值分语言：拉丁文 8 个字符，中日韩 3 个字——因为同样字数承载的信息量差别很大。
 */
export function isShortUtterance(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3040-\u30ff\u4e00-\u9fa5]/g) || []).length;
  const total = alnumCount(s);
  const isCJK = total > 0 && cjk / total > 0.3;
  return total <= (isCJK ? SHORT_MAX_CJK : SHORT_MAX_LATIN);
}

/**
 * 去掉与已提交尾巴重叠的前缀。
 * 例：已提交尾巴 "...局域网的 MAC 帧"，新结果开头又是 "局域网的 MAC 帧，" → 掐掉。
 */
export function stripCommittedOverlap(text, committedTail) {
  const s = String(text || '');
  const tail = String(committedTail || '').toLowerCase().replace(/\s+$/, '');
  if (!tail || !s) return s;

  const low = s.toLowerCase();
  const max = Math.min(tail.length, low.length);

  // 从长到短试，找到最长的"尾巴后缀 == 文本前缀"
  for (let len = max; len > 2; len--) {
    if (low.slice(0, len) === tail.slice(tail.length - len)) {
      const stripped = s.slice(len).replace(/^[\s,，、]+/, '');
      return stripped;
    }
  }
  return s;
}

/**
 * 决定这一轮要提交什么。
 *
 * @param {object} p
 * @param {string} p.text            本轮整段识别结果
 * @param {string} p.committedTail   上次提交的文本尾巴（用于去重）
 * @param {number} p.bufferStartMs   缓冲起点（相对会话时间）
 * @param {number} p.bufferDurationMs 缓冲时长
 * @param {string} p.pending         之前攒下的碎片文本
 * @returns {{commits: Array<{text:string,startMs:number,durationMs:number}>, pending:string, trimMs:number, tail:string, remainder:string}}
 */
export function planInterim({ text, committedTail = '', bufferStartMs = 0, bufferDurationMs = 0, pending = '' }) {
  const empty = { commits: [], pending, trimMs: 0, tail: committedTail, remainder: '' };

  const deduped = stripCommittedOverlap(text, committedTail);
  if (!deduped) return empty;

  const sentences = splitSentences(deduped);
  // 只有一句 → 这句还在说，先不提交（调用方可以把它当"正在说"显示）
  if (sentences.length <= 1) {
    return { ...empty, remainder: deduped.trim() };
  }

  const complete = sentences.slice(0, -1);
  const remainder = sentences[sentences.length - 1].trim();

  const totalChars = alnumCount(deduped) || 1;
  let usedChars = 0;
  const commits = [];
  let carry = pending;

  for (const raw of complete) {
    const sentence = raw.trim();
    if (!sentence) continue;

    const chars = alnumCount(sentence);
    const startMs = bufferStartMs + Math.round((usedChars / totalChars) * bufferDurationMs);
    usedChars += chars;
    const endMs = bufferStartMs + Math.round((usedChars / totalChars) * bufferDurationMs);

    // 碎片不单独输出，攒到下一句前面（避免"啊。""嗯。"这种一行）
    if (isShortUtterance(sentence)) {
      carry += sentence;
      continue;
    }

    const text = carry ? carry + sentence : sentence;
    carry = '';
    commits.push({ text, startMs, durationMs: Math.max(400, endMs - startMs) });
  }

  if (!commits.length) return { ...empty, pending: carry, remainder };

  // 裁音频：按"已提交字数占比"估，加余量防回声，且至少给剩下的留 0.5 秒
  const committedChars = commits.reduce((n, c) => n + alnumCount(c.text), 0);
  const ratio = Math.min(1, committedChars / totalChars);
  let trimMs = Math.round(ratio * bufferDurationMs) + TRIM_MARGIN_MS;
  trimMs = Math.min(trimMs, Math.max(0, bufferDurationMs - TRIM_KEEP_MS));
  if (trimMs > 0 && trimMs < TRIM_MARGIN_MS) trimMs = Math.min(TRIM_MARGIN_MS, Math.floor(bufferDurationMs / 2));

  const committedText = commits.map((c) => c.text).join('');
  const tail = (committedTail + committedText).slice(-50);

  return { commits, pending: carry, trimMs, tail, remainder };
}
