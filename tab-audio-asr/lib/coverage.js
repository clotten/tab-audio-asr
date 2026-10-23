/**
 * coverage.js —— "这段音频的识别结果是不是明显太少了"
 *
 * 背景：语速快的视频里，一段 15~20 秒可能包含七八句。
 * 云端 ASR 对**过长且密集**的输入会偷工减料（只返回前半段或摘要式结果），
 * 表现就是"缺好多句子"，而且它不报错——所以只能靠"字数 ÷ 时长"的密度来发现。
 *
 * 判据完全基于数据，不针对任何站点：
 *   正常语速的语音大约每秒 3~6 个字（中文）或 2~4 个词（英文）。
 *   一段 >= 8 秒的语音如果每秒不到 1.2 个字，几乎肯定是被截断了。
 *
 * 这里不碰网络，方便单测。
 */

/** 少于这个时长不做判断（太短的段本来就几个字） */
const MIN_MS_TO_JUDGE = 8000;

/** 语速下限：每秒至少要这么多个"字"（CJK 按字算，拉丁按词算） */
const MIN_CHARS_PER_SEC = 1.2;

/** 统计"信息量"：CJK 每个字算 1，连续的拉丁字母/数字算 1 个词 */
export function informationUnits(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const words = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + words;
}

/**
 * 这段结果是不是"明显偏少"（值得切小重试）。
 * @param {string} text 识别文本
 * @param {number} durationMs 这段音频的时长
 */
export function looksTruncated(text, durationMs) {
  const ms = Number(durationMs) || 0;
  if (ms < MIN_MS_TO_JUDGE) return false;
  const units = informationUnits(text);
  const perSec = units / (ms / 1000);
  return perSec < MIN_CHARS_PER_SEC;
}

/**
 * 把一段音频切成两半（返回采样区间，用于重试）。
 * 只在 needsRetry 为真时调用；切入点是中点。
 */
export function splitInHalf(startSample, endSample) {
  const mid = startSample + Math.floor((endSample - startSample) / 2);
  if (mid <= startSample || mid >= endSample) return null;
  return [
    { startSample, endSample: mid },
    { startSample: mid, endSample }
  ];
}

/**
 * 合并两次重试的结果，保留"信息量更大"的那个组合。
 * 用信息量而不是字数比较，避免英文被低估。
 */
export function betterOf(original, halves) {
  const a = informationUnits(original);
  const b = halves.reduce((n, t) => n + informationUnits(t), 0);
  return b > a ? { use: 'halves', units: b } : { use: 'original', units: a };
}

