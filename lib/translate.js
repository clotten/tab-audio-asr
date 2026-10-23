/**
 * translate.js —— 字幕翻译（生成双语字幕）的纯逻辑
 *
 * 设计要求：
 *  - 只用一次对话请求翻一批（默认 20 句），省 token、也省调用次数；
 *  - 模型必须**按行号返回 JSON 数组**，长度对不上就判定失败（宁可失败也不要错位，
 *    字幕错位比没翻译糟糕得多）；
 *  - 翻译结果逐句回填到 segments[i].translation，原文一个字都不改。
 *
 * 这里不碰 chrome.* / fetch，方便 tools/test-translate.mjs 覆盖。
 */

/** 一批最多几句 */
export const TRANSLATE_BATCH = 20;

/** 默认目标语言 */
export const DEFAULT_TARGET = '中文';

/** 把长数组切成小批 */
export function chunkTexts(texts, size = TRANSLATE_BATCH) {
  const out = [];
  const n = Math.max(1, Math.floor(size) || TRANSLATE_BATCH);
  for (let i = 0; i < (texts || []).length; i += n) out.push(texts.slice(i, i + n));
  return out;
}

/**
 * 拼提示词。
 * 关键约束都写在 system 里：只翻译、不改写、不加解释、行数必须一致。
 */
export function buildTranslateMessages(texts, { target = DEFAULT_TARGET } = {}) {
  const numbered = (texts || []).map((t, i) => `${i + 1}. ${String(t).trim()}`).join('\n');

  return [
    {
      role: 'system',
      content: [
        `你是字幕翻译。把用户给的每一行字幕翻译成${target}。`,
        '严格规则：',
        '1) 只输出一个 JSON 数组，元素是字符串，数量和输入行数完全一致；',
        '2) 不要合并、拆分、增删行，不要输出解释、编号或代码围栏；',
        '3) 保留原有的语气词、停顿和口语感，不要润色成书面语；',
        '4) 人名/作品名等专有名词保持原样或按常见译法，不要音译造词。'
      ].join('\n')
    },
    { role: 'user', content: numbered }
  ];
}

/**
 * 从模型回复里取出字符串数组。
 * 模型经常包一层 ```json 或加句解释，所以先截取第一个 [ ... ] 再解析；
 * 解析不出来就按行兜底（去掉 "1." 这类编号）。
 * 返回 null 表示"长度对不上"，调用方应当判定这一批失败。
 */
export function parseTranslateReply(reply, expectedCount) {
  const raw = String(reply || '').trim();
  if (!raw) return null;

  const tryJson = (s) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
    } catch {
      /* 继续尝试 */
    }
    return null;
  };

  let arr = tryJson(raw);

  if (!arr) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) arr = tryJson(raw.slice(start, end + 1));
  }

  if (!arr) {
    // 兜底：按行取，去掉 "1. " / "- " 之类前缀
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\s*(?:\d+\s*[.、)]|[-*])\s*/, ''))
      .filter((l) => l && !/^```/.test(l));
    if (lines.length) arr = lines;
  }

  if (!arr || arr.length !== expectedCount) return null;
  return arr.map((s) => String(s).trim());
}

/**
 * 把译文本回填到 segments 的副本里（不修改入参）。
 * 返回新数组；`index` 是 segments 里的位置。
 */
export function applyTranslations(segments, translations, startIndex = 0) {
  const list = (segments || []).map((s) => ({ ...s }));
  (translations || []).forEach((t, i) => {
    const seg = list[startIndex + i];
    if (seg) seg.translation = String(t).trim();
  });
  return list;
}

/** 这条字幕是否已经有译文（用于跳过已译过的） */
export function needsTranslation(seg) {
  return !!seg && !seg.translation && String(seg.text || '').trim().length > 0;
}

/** 统计：已译 / 待译 */
export function translationStats(segments) {
  const list = (segments || []).filter((s) => s && s.status === 'done' && String(s.text || '').trim());
  const done = list.filter((s) => s.translation).length;
  return { total: list.length, done, pending: list.length - done };
}
