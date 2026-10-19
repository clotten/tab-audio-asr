/**
 * test-vad.mjs —— 静音切分的离线测试
 * 用合成信号（音调 + 静音）验证：切句数量、起止时间、碎句合并、兜底切分。
 *
 * 运行：node tools/test-vad.mjs
 */

import { detectSpeechRegions, VAD_DEFAULTS } from '../lib/vad.js';

const SR = 16000;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

function sec(n) {
  return Math.round(n * SR);
}

/** parts: [[时长秒, 幅度], ...]，幅度 0 = 静音 */
function build(parts) {
  const out = new Float32Array(parts.reduce((n, [d]) => n + sec(d), 0));
  let off = 0;
  for (const [dur, amp] of parts) {
    const len = sec(dur);
    for (let i = 0; i < len; i++) {
      out[off + i] = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * 300 * i) / SR);
    }
    off += len;
  }
  return out;
}

function fmt(regions) {
  return regions.map((r) => `${(r.startMs / 1000).toFixed(2)}–${(r.endMs / 1000).toFixed(2)}s`).join(' | ') || '（空）';
}

console.log('\n1) 三句 1 秒的话，间隙 3 秒（超过合并上限，应保持 3 句）');
{
  const s = build([
    [1.0, 0.3],
    [3.0, 0],
    [1.0, 0.3],
    [3.0, 0],
    [1.0, 0.3]
  ]);
  const r = detectSpeechRegions(s, SR);
  check('切出 3 段', r.length === 3, `实际 ${r.length}：${fmt(r)}`);
  if (r.length === 3) {
    check('第 1 段从 ~0s 开始', Math.abs(r[0].startMs) < 250, String(r[0].startMs));
    check('第 1 段约 1s 长', Math.abs(r[0].durationMs - 1000) < 350, String(r[0].durationMs));
    check('第 2 段起点约 4s', Math.abs(r[1].startMs - 4000) < 350, String(r[1].startMs));
    check('第 3 段起点约 8s', Math.abs(r[2].startMs - 8000) < 350, String(r[2].startMs));
  }
}

console.log('\n1b) 同样的句子，间隙 1.5 秒（应当被合并，避免 1 秒碎片）');
{
  const s = build([
    [1.0, 0.3],
    [1.5, 0],
    [1.0, 0.3],
    [1.5, 0],
    [1.0, 0.3]
  ]);
  const r = detectSpeechRegions(s, SR);
  check('合并后少于 3 段', r.length < 3, `实际 ${r.length}：${fmt(r)}`);
  check('第一段明显变长（>2.5s）', r[0] && r[0].durationMs > 2500, String(r[0]?.durationMs));
  check('末尾那句仍然保留', r[r.length - 1] && r[r.length - 1].endMs > 5800, fmt(r));
}

console.log('\n2) 连续讲话 25 秒（没有停顿）');
{
  const s = build([[25, 0.3]]);
  const r = detectSpeechRegions(s, SR);
  check('至少切成 3 段', r.length >= 3, `实际 ${r.length} 段`);
  const over = r.filter((x) => x.durationMs > VAD_DEFAULTS.maxRegionMs + VAD_DEFAULTS.padMs * 2 + 200);
  check('没有段落超出上限', over.length === 0, fmt(over));
  const covered = r.reduce((n, x) => n + x.durationMs, 0);
  check('基本覆盖整段音频（>90%）', covered > 25000 * 0.9, `${Math.round(covered / 250)}%`);
  const gaps = r.slice(1).map((x, i) => x.startMs - r[i].endMs);
  check('段间不重叠', gaps.every((g) => g >= 0), JSON.stringify(gaps));
}

console.log('\n3) 全程静音');
{
  const r = detectSpeechRegions(new Float32Array(sec(3)), SR);
  check('一句都不返回', r.length === 0, `实际 ${r.length}`);
}

console.log('\n4) 空输入 / 极短输入');
{
  check('空数组返回 []', detectSpeechRegions(new Float32Array(0), SR).length === 0);
  check('10ms 输入返回 []', detectSpeechRegions(new Float32Array(160), SR).length === 0);
}

console.log('\n5) 碎句合并：两个 0.8s 的短句（间隙 1s）应并成一句');
{
  const s = build([
    [0.8, 0.02],
    [1.0, 0],
    [0.8, 0.02]
  ]);
  const r = detectSpeechRegions(s, SR);
  check('合并成 1 段', r.length === 1, `实际 ${r.length}：${fmt(r)}`);
  check('合并后长度 ≈ 2.6s', r[0] && Math.abs(r[0].durationMs - 2600) < 400, String(r[0]?.durationMs));
}

console.log('\n6) 全部有背景噪声（模拟音乐铺底）');
{
  const s = new Float32Array(sec(12));
  for (let i = 0; i < s.length; i++) {
    s[i] = 0.06 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.02 * (Math.random() * 2 - 1);
  }
  const r = detectSpeechRegions(s, SR);
  check('不会返回空', r.length >= 1, `实际 ${r.length}`);
  check('不会切得太碎', r.length <= 6, `实际 ${r.length} 段`);
  const covered = r.reduce((n, x) => n + x.durationMs, 0);
  check('覆盖大部分音频', covered > 12000 * 0.85, `${covered}ms`);
}

console.log('\n7) 短促咔哒声被忽略');
{
  const s = build([
    [2.0, 0],
    [0.1, 0.5],
    [2.0, 0]
  ]);
  const r = detectSpeechRegions(s, SR);
  check('100ms 的脉冲被丢掉', r.length === 0, `实际 ${r.length}：${fmt(r)}`);
}

console.log('\n8) 间隙阈值（关掉碎句合并以单独验证）');
{
  const s = build([
    [1.0, 0.3],
    [0.4, 0],
    [1.0, 0.3]
  ]);
  const merged = detectSpeechRegions(s, SR, { minGapMs: 800, targetMinMs: 0 });
  const split = detectSpeechRegions(s, SR, { minGapMs: 200, targetMinMs: 0 });
  check('minGapMs 大 → 合并成 1 段', merged.length === 1, `实际 ${merged.length}`);
  check('minGapMs 小 → 切成 2 段', split.length === 2, `实际 ${split.length}`);
}

console.log('\n9) 连讲 6 个 0.7 秒短句（模拟课堂逐条念术语）');
{
  const parts = [];
  for (let i = 0; i < 6; i++) {
    if (i) parts.push([0.5, 0]);
    parts.push([0.7, 0.3]);
  }
  const s = build(parts);
  const r = detectSpeechRegions(s, SR);
  check('不会切出 6 个碎片', r.length <= 3, `实际 ${r.length}：${fmt(r)}`);
  check('每段都达到合并目标（≥2s）', r.every((x) => x.durationMs >= 2000), fmt(r));
  const covered = r.reduce((n, x) => n + x.durationMs, 0);
  check('覆盖整段（>85%）', covered > 6700 * 0.85, `${covered}ms`);
}

console.log('\n10) 合并后的段不会超过单句上限');
{
  // 15 个 0.9 秒短句，间隙 0.4 秒，总长约 19 秒
  const parts = [];
  for (let i = 0; i < 15; i++) {
    if (i) parts.push([0.4, 0]);
    parts.push([0.9, 0.3]);
  }
  const s = build(parts);
  const r = detectSpeechRegions(s, SR);
  const limit = VAD_DEFAULTS.maxRegionMs + VAD_DEFAULTS.padMs * 2 + 200;
  check('没有段落超出上限', r.every((x) => x.durationMs <= limit), fmt(r));
  check('段数合理（≥2）', r.length >= 2, `实际 ${r.length}`);
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
