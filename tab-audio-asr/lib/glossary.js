/**
 * glossary.js —— 术语表与识别稿纠正
 *
 * 设计原则（重要）：**不内置任何具体课程的术语**。
 *
 *   术语是领域数据，不是代码。把"县局网→无线局域网""二么么→802.11"这种
 *   写进默认值，换个科目就全废，还会误伤正常文本。所以：
 *     · 默认术语表为空，用户在设置里填自己的领域词；
 *     · examples/ 里放几个领域示例，复制粘贴即可用；
 *     · 真正通用的能力是"把术语表交给对话模型做上下文纠错"（不需要预先知道错法）。
 *
 * 术语表格式（一行一条）：
 *   无线局域网               ← 只作为纠错提示交给 LLM
 *   县局网 => 无线局域网      ← 同时作为本地即时替换规则（错法已知时用）
 *
 * 注意：本地替换是"字符串替换"，只适合**错法固定**的情况；错法不确定时
 * 只用裸术语（交给 LLM），别写猜测性规则——那属于特例处理。
 */

/** 默认术语表：空。用户自己填，或从 examples/ 里复制。 */
export const DEFAULT_GLOSSARY_TEXT = '';

export const GLOSSARY_FORMAT_HINT = `一行一条：
  无线局域网        （只作为纠错提示）
  县局网 => 无线局域网（错法确定时，本地立刻替换）`;

/** 解析用户编辑的术语表文本 */
export function parseGlossary(text) {
  const pairs = [];
  const terms = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf('=>');
    if (idx > 0) {
      const wrong = line.slice(0, idx).trim();
      const right = line.slice(idx + 2).trim();
      if (wrong && right) {
        pairs.push([wrong, right]);
        terms.push(right);
      }
    } else {
      terms.push(line);
    }
  }

  // 长的错法优先替换，避免短规则先吃掉长规则的一部分
  pairs.sort((a, b) => b[0].length - a[0].length);

  return { pairs, terms: [...new Set(terms)] };
}

/**
 * 本地即时替换 + 中英文之间补空格。
 * pairs 为空时是纯格式化，保证没填术语表也不会改坏文本。
 */
export function applyGlossary(text, parsed) {
  let out = String(text || '');
  if (!out) return out;

  if (parsed?.pairs?.length) {
    for (const [wrong, right] of parsed.pairs) {
      const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = /[a-zA-Z]/.test(wrong) ? 'gi' : 'g';
      try {
        out = out.replace(new RegExp(escaped, flags), right);
      } catch {
        /* 正则异常就跳过这一条 */
      }
    }
  }

  // 中文与英文/数字之间补一个空格，读起来更像正常稿子
  out = out.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2');
  out = out.replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

/** 截断到模型能接受的提示长度 */
function clip(text, max = 6000) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * 构造"整段纠错"的对话消息。
 * 有术语表就带上；没有也照样能纠（靠上下文），不依赖预置术语。
 */
export function buildCorrectionMessages(lines, parsed) {
  const terms = parsed?.terms || [];
  const glossaryPart = terms.length
    ? `术语表（这些词必须按此写法出现）：${clip(terms.join('、'), 1500)}\n\n`
    : '';

  const body = lines.map((l) => `${l.time} ${l.text}`).join('\n');

  const system =
    '你是中文语音识别稿的校对员。任务：只修正同音错字和专业术语，' +
    '不改写、不增删句子、不合并或拆分行、不添加标点以外的内容，不输出任何解释。' +
    '每行输入必须以"时间戳 + 空格 + 文本"的完全相同格式输出，行数必须与输入一致。';

  const user = `${glossaryPart}请逐行校对下面的识别结果。只改文本部分的错字，时间戳原样保留。

${body}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * 解析模型返回的 "时间戳 文本" 行。
 * 模型偶尔会插入空行、加代码块、或把时间戳写成 [00:12]，这里都容错。
 */
export function parseCorrectionResponse(text) {
  const out = [];
  const cleaned = String(text || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\r/g, '');

  for (const raw of cleaned.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[:：]?\s*(.+)$/);
    if (!m) continue;
    const content = m[2].trim();
    if (!content) continue;
    out.push({ time: m[1], text: content });
  }
  return out;
}
