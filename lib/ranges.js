/**
 * ranges.js —— 时间轴区间工具（断点续跑用）
 *
 * 场景：45 分钟的视频整段提取到一半，offscreen 被浏览器挂起（内存超了）。
 * 重新点「整段提取」时，不该从头再花一遍钱，而是**跳过已经转好的时间段**。
 *
 * 这里只做一件事：把「已完成的句子」折算成一组时间区间，并判断
 * 「某个待转写的区间是不是已经被覆盖」。纯函数，方便单测。
 */

/** 把 [{startMs, durationMs}] 折算成 [[start, end], …] 并合并相邻/重叠区间 */
export function coveredRanges(items, { gapToleranceMs = 0 } = {}) {
  const list = [];
  for (const it of items || []) {
    const start = Number(it?.startMs);
    const dur = Number(it?.durationMs);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
    list.push([start, start + dur]);
  }
  if (!list.length) return [];

  list.sort((a, b) => a[0] - b[0]);
  const out = [list[0].slice()];
  for (let i = 1; i < list.length; i++) {
    const last = out[out.length - 1];
    const cur = list[i];
    // 留一点容差：识别出来的句边界和原始切点会差几十毫秒
    if (cur[0] <= last[1] + gapToleranceMs) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      out.push(cur.slice());
    }
  }
  return out;
}

/** 某个区间是否**完全**落在已覆盖范围内 */
export function isCovered(ranges, startMs, durationMs, { slackMs = 250 } = {}) {
  const start = Number(startMs);
  const dur = Number(durationMs);
  if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) return false;
  const end = start + dur;
  for (const [a, b] of ranges || []) {
    if (a - slackMs <= start && end <= b + slackMs) return true;
  }
  return false;
}

/** 已覆盖时长（秒），用来在界面上说"已完成 xx%" */
export function coveredSeconds(ranges) {
  const total = (ranges || []).reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  return Math.round(total / 100) / 10;
}

/**
 * 把「之前的句子」和「这次新转的句子」合并成一条按时间排序的完整稿。
 * 同一时间段以后来的为准（后来者通常是更完整的那一份）。
 */
export function mergeTimeline(prior, fresh, { overlapMs = 400 } = {}) {
  const a = (prior || []).filter((s) => s && s.text);
  const b = (fresh || []).filter((s) => s && s.text);
  if (!a.length) return reindex(b);
  if (!b.length) return reindex(a);

  const kept = a.filter((old) => {
    const os = Number(old.startMs);
    const oe = os + Number(old.durationMs || 0);
    return !b.some((neu) => {
      const ns = Number(neu.startMs);
      const ne = ns + Number(neu.durationMs || 0);
      return ns < oe - overlapMs && ne > os + overlapMs; // 真有重叠才替换
    });
  });

  return reindex([...kept, ...b].sort((x, y) => Number(x.startMs) - Number(y.startMs)));
}

function reindex(items) {
  return items.map((s, i) => ({ ...s, index: i }));
}
