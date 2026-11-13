/**
 * test-ranges.mjs —— 断点续跑的时间轴工具
 *
 * 这些函数决定了「重跑整段提取时，哪些时间段可以跳过」。
 * 算错的后果有两种：漏转（跳过没做过的段）或重复花钱（该跳过的没跳过），
 * 所以边界情况必须逐条钉住。
 *
 * 运行：node tools/test-ranges.mjs
 */

import { coveredRanges, isCovered, coveredSeconds, mergeTimeline } from '../lib/ranges.js';

let failed = 0;
let passed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('\n1) coveredRanges：把句子折算成区间');
{
  const r = coveredRanges([
    { startMs: 0, durationMs: 4000 },
    { startMs: 4000, durationMs: 3000 },
    { startMs: 20000, durationMs: 2000 }
  ]);
  check('相邻的合并成一段', r.length === 2, JSON.stringify(r));
  check('第一段 0–7000', r[0][0] === 0 && r[0][1] === 7000, JSON.stringify(r[0]));
  check('第二段 20000–22000', r[1][0] === 20000 && r[1][1] === 22000, JSON.stringify(r[1]));

  check('空输入 → 空区间', coveredRanges([]).length === 0);
  check('坏数据被忽略', coveredRanges([{ startMs: 'x' }, null, { startMs: 1, durationMs: 0 }]).length === 0);

  const overlap = coveredRanges([
    { startMs: 0, durationMs: 5000 },
    { startMs: 3000, durationMs: 5000 }
  ]);
  check('重叠的也合并', overlap.length === 1 && overlap[0][1] === 8000, JSON.stringify(overlap));

  const tolerate = coveredRanges(
    [
      { startMs: 0, durationMs: 5000 },
      { startMs: 5100, durationMs: 1000 }
    ],
    { gapToleranceMs: 200 }
  );
  check('小缝隙按容差合并', tolerate.length === 1, JSON.stringify(tolerate));
}

console.log('\n2) isCovered：某段能不能跳过');
{
  const r = [[0, 7000], [20000, 22000]];
  check('完全落在里面 → 跳过', isCovered(r, 1000, 3000));
  check('正好贴着边界 → 跳过', isCovered(r, 4000, 3000));
  check('跨过两段之间 → 不跳过', !isCovered(r, 6000, 6000));
  check('在区间外 → 不跳过', !isCovered(r, 30000, 3000));
  check('零时长 → 不跳过', !isCovered(r, 1000, 0));
  check('空区间 → 全不跳过', !isCovered([], 0, 1000));

  // 识别出的句子边界比原始切点差几十毫秒是常态，留了 250ms 容差
  check('边界差 200ms 仍算覆盖', isCovered([[1000, 5000]], 1250, 3550));
  check('尾部超出容差 → 不算覆盖', !isCovered([[1000, 5000]], 1400, 3900));
}

console.log('\n3) coveredSeconds：进度百分比');
{
  check('两段共 9 秒', coveredSeconds([[0, 7000], [20000, 22000]]) === 9, String(coveredSeconds([[0, 7000], [20000, 22000]])));
  check('空 → 0', coveredSeconds([]) === 0);
}

console.log('\n4) mergeTimeline：旧稿 + 新稿拼起来');
{
  const prior = [
    { index: 0, startMs: 0, durationMs: 4000, text: 'A' },
    { index: 1, startMs: 4000, durationMs: 4000, text: 'B' }
  ];
  const fresh = [
    { index: 0, startMs: 8000, durationMs: 4000, text: 'C' }
  ];
  const merged = mergeTimeline(prior, fresh);
  check('合并后 3 句', merged.length === 3, JSON.stringify(merged.map((s) => s.text)));
  check('按时间排序', merged.map((s) => s.text).join('') === 'ABC', merged.map((s) => s.text).join(''));
  check('index 重新编号', merged.every((s, i) => s.index === i));

  // 同一时间段重转了一次：以新的为准，不留重复
  const redo = mergeTimeline(prior, [{ index: 0, startMs: 0, durationMs: 4000, text: 'A2' }]);
  check('重叠区间被新的替换', redo.length === 2, JSON.stringify(redo.map((s) => s.text)));
  check('替换后的文本是新稿', redo[0].text === 'A2', redo[0].text);

  check('只有旧稿 → 原样返回', mergeTimeline(prior, []).length === 2);
  check('只有新稿 → 原样返回', mergeTimeline([], fresh).length === 1);
  check('空对空 → 空', mergeTimeline([], []).length === 0);
  check('没有文本的句子被丢掉', mergeTimeline([{ startMs: 0, durationMs: 1000, text: '' }], []).length === 0);
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
