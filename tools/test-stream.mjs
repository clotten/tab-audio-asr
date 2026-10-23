/**
 * test-stream.mjs —— 流式切句的离线测试（含"延迟"测量）
 *
 * 关键指标不是切得准不准，而是**一句说完到被吐出来隔了多久**。
 * 这里模拟音频按顺序流入，记录每段被 emit 时"已经喂进去的音频时长"，
 * 两者之差就是这段字幕的端到端延迟（不含网络与推理）。
 *
 * 运行：node tools/test-stream.mjs
 */

import { createStreamingSegmenter, STREAM_DEFAULTS } from '../lib/vad.js';

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

/**
 * 这组用例测的是"切句机制"，所以固定用低延迟档参数，
 * 不受出厂默认（高准确：4.5s 合并 / 12s 软切 / 18s 硬切）变化影响。
 * 出厂默认本身在文件末尾单独断言。
 */
const TEST_OPTS = {
  targetMinMs: 2000,
  silenceGapMs: 600,
  graceSilenceMs: 1200,
  softCutMs: 5000,
  hardCutMs: 10000
};

/** 把音频按 blockSize 喂进去，收集切出来的段落与它们的延迟 */
function run(audio, { blockSize = 1000, options = {}, stopAt = null } = {}) {
  const seg = createStreamingSegmenter(SR, { ...TEST_OPTS, ...options });
  const emitted = [];
  const limit = stopAt == null ? audio.length : Math.min(audio.length, sec(stopAt));

  for (let off = 0; off < limit; off += blockSize) {
    const block = audio.subarray(off, Math.min(off + blockSize, limit));
    const out = seg.push(block);
    const fedMs = (Math.min(off + blockSize, limit) / SR) * 1000;
    for (const s of out) {
      emitted.push({
        ...s,
        emittedAtMs: Math.round(fedMs),
        latencyMs: Math.round(fedMs - (s.startMs + s.durationMs))
      });
    }
  }

  const flushed = seg.flush().map((s) => ({
    ...s,
    emittedAtMs: Math.round((limit / SR) * 1000),
    latencyMs: null
  }));
  return { emitted, flushed, all: [...emitted, ...flushed] };
}

const fmt = (segs) =>
  segs
    .map((s) => `${(s.startMs / 1000).toFixed(2)}–${((s.startMs + s.durationMs) / 1000).toFixed(2)}s`)
    .join(' | ') || '（空）';

console.log('\n1) 停顿处分句：说 2.5s、停 0.8s、说 2.5s、停 0.8s');
{
  const audio = build([
    [2.5, 0.3],
    [0.8, 0],
    [2.5, 0.3],
    [0.8, 0],
    [0.4, 0]
  ]);
  const { emitted } = run(audio);
  check('切出 2 段', emitted.length === 2, `实际 ${emitted.length}：${fmt(emitted)}`);
  check(
    '第 1 段覆盖 ~0–2.5s',
    emitted[0] && emitted[0].startMs < 250 && emitted[0].durationMs > 2300,
    fmt(emitted.slice(0, 1))
  );
  check(
    '第 1 段延迟 < 900ms（说完到发出）',
    emitted[0] && emitted[0].latencyMs >= 0 && emitted[0].latencyMs < 900,
    `${emitted[0]?.latencyMs}ms`
  );
  check(
    '第 2 段延迟也 < 900ms',
    emitted[1] && emitted[1].latencyMs >= 0 && emitted[1].latencyMs < 900,
    `${emitted[1]?.latencyMs}ms`
  );
  check('两段不重叠', emitted.length === 2 && emitted[1].startMs >= emitted[0].startMs + emitted[0].durationMs);
  check('切割原因是停顿', emitted.every((s) => s.reason === 'silence'), emitted.map((s) => s.reason).join(','));
}

console.log('\n2) 连续讲话 8 秒（没有停顿）：应在软上限处切开，别一直等');
{
  const audio = build([[8, 0.3], [0.5, 0]]);
  const { all } = run(audio);
  check('至少切出 2 段', all.length >= 2, `实际 ${all.length}：${fmt(all)}`);
  const first = all[0];
  check('第 1 段不超过软上限太多', first && first.durationMs <= 6000, `${first?.durationMs}ms`);
  check('第 1 段延迟 < 6s', first && first.latencyMs != null && first.latencyMs < 6000, `${first?.latencyMs}ms`);
  const covered = all.reduce((n, s) => n + s.durationMs, 0);
  check('覆盖大部分音频（>80%）', covered > 8000 * 0.8, `${covered}ms`);
}

console.log('\n3) 纯静音不产出');
{
  const audio = build([[3, 0]]);
  const { all } = run(audio);
  check('一段都不切', all.length === 0, `实际 ${all.length}：${fmt(all)}`);
}

console.log('\n4) 极短句子会等下一句合并（不立刻切）');
{
  const audio = build([
    [0.5, 0.3],
    [0.9, 0],
    [0.8, 0.3],
    [0.9, 0]
  ]);
  const { emitted, all } = run(audio);
  const firstEmit = emitted[0];
  check(
    '第一段包含两句（起点在前，长度 > 1.5s）',
    !!firstEmit && firstEmit.startMs < 300 && firstEmit.durationMs > 1500,
    fmt(emitted)
  );
  check('总共不超过 2 段', all.length <= 2, `实际 ${all.length}`);
}

console.log('\n5) 停止时 flush 收尾');
{
  const audio = build([
    [2.0, 0.3],
    [0.35, 0.3]
  ]);
  const { emitted, flushed } = run(audio);
  check('最后一句靠 flush 出来', flushed.length === 1, `emitted=${emitted.length} flushed=${flushed.length}`);
  check('flush 的段不为空', flushed[0] && flushed[0].durationMs > 1500, `${flushed[0]?.durationMs}ms`);
}

console.log('\n6) 分块大小不影响结果（跨帧边界的兼容性）');
{
  const audio = build([
    [1.2, 0.3],
    [0.8, 0],
    [1.2, 0.3],
    [0.8, 0]
  ]);
  const a = run(audio, { blockSize: 1000 }).all;
  const b = run(audio, { blockSize: 160 }).all;
  const c = run(audio, { blockSize: 2048 }).all;
  check('三种块大小切出的段数一致', a.length === b.length && b.length === c.length, `${a.length}/${b.length}/${c.length}`);
  judgeClose(a, b, '1000 vs 160');
  judgeClose(a, c, '1000 vs 2048');
}

function judgeClose(x, y, label) {
  const same = x.every((s, i) => {
    const t = y[i];
    return t && Math.abs(s.startMs - t.startMs) < 300 && Math.abs(s.durationMs - t.durationMs) < 400;
  });
  check(`${label} 的时间点接近`, same, `${fmt(x)} VS ${fmt(y)}`);
}

console.log('\n7) 音量很小的音频也能切');
{
  const audio = build([
    [2.5, 0.02],
    [0.8, 0],
    [2.5, 0.02],
    [0.8, 0]
  ]);
  const { emitted } = run(audio);
  check('切出 2 段', emitted.length === 2, `实际 ${emitted.length}：${fmt(emitted)}`);
}

console.log('\n8) peek()：给增量预览用，且不影响切句状态');
{
  const audio = build([
    [3.0, 0.3],
    [0.6, 0]
  ]);
  const seg = createStreamingSegmenter(SR, { targetMinMs: 2000 });

  check('还没说话时 peek 为 null', seg.peek() === null);
  seg.push(audio.subarray(0, sec(1.2)));

  const p = seg.peek();
  check('说到一半能 peek 到内容', !!p && p.durationMs > 900, String(p?.durationMs));
  check('peek 起点接近 0', p && p.startMs < 250, String(p?.startMs));

  const out = [];
  for (let off = sec(1.2); off < audio.length; off += 2048) {
    out.push(...seg.push(audio.subarray(off, Math.min(off + 2048, audio.length))));
  }
  out.push(...seg.flush());
  check('peek 之后仍能正常切句', out.length >= 1, `${out.length} 段`);
  check('切出的段覆盖整句', out[0] && out[0].durationMs > 2500, String(out[0]?.durationMs));
}

console.log('\n9) 渐进式静音：缓冲长时接受更短的停顿');
{
  // 2 秒说话 + 0.5 秒停顿交替：0.5s 低于默认阈值 600ms，默认不切
  const audio = build([
    [2, 0.3],
    [0.5, 0],
    [2, 0.3],
    [0.5, 0],
    [2, 0.3],
    [0.5, 0],
    [2, 0.3],
    [0.5, 0]
  ]);

  const off = run(audio, { options: { progressiveTiers: [] } });
  const on = run(audio, { options: { progressiveTiers: [[0, 0.5]] } });

  check('关掉渐进时靠软上限切（段更长）', off.all.length >= 1, fmt(off.all));
  check('开启渐进后切得更早/更多段', on.all.length > off.all.length, `${off.all.length} → ${on.all.length}`);
  check('渐进切出来的原因是 silence', on.all.some((s) => s.reason === 'silence'), on.all.map((s) => s.reason).join(','));
  check('默认阈值下 500ms 停顿不触发切分', off.all.every((s) => s.reason !== 'silence'), off.all.map((s) => s.reason).join(','));
}

console.log('\n9) 出厂默认是高准确档（漏句比慢几秒更难受）');
{
  const seg = createStreamingSegmenter(SR, {});
  const cfg = seg.config || seg.options || {};
  const d = cfg.softCutMs != null ? cfg : STREAM_DEFAULTS;
  check('软切 12s', d.softCutMs === 12000, String(d.softCutMs));
  check('硬切 18s', d.hardCutMs === 18000, String(d.hardCutMs));
  check('最短 4.5s', d.targetMinMs === 4500, String(d.targetMinMs));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
