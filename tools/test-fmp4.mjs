/**
 * test-fmp4.mjs —— 分片 MP4 解析
 *
 * 这套解析决定了「83 分钟的视频能不能边解边转」。算错的后果很直接：
 * 切片边界错一个字节，decodeAudioData 就整片失败，等于这一段的字幕丢了。
 *
 * 用合成 box 逐条钉住，不依赖真实文件。
 *
 * 运行：node tools/test-fmp4.mjs
 */

import { isFragmented, initSegmentEnd, fragmentSpans, planFragments, scanTopLevel } from '../lib/fmp4.js';

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

/** 造一个 box：4 字节长度 + 4 字节类型 + 内容 */
function box(type, size) {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  return out;
}

/** 把若干 box 拼起来 */
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

console.log('\n1) 结构识别');
{
  const ftyp = box('ftyp', 32);
  const moov = box('moov', 800);
  const moof = box('moof', 600);
  const mdat = box('mdat', 2000);
  const fmp4 = concat(ftyp, moov, moof, mdat);

  check('ftyp+moov+moof → 是分片 MP4', isFragmented(fmp4));
  check('初始化段到 moov 结束 = 832', initSegmentEnd(fmp4) === 832, String(initSegmentEnd(fmp4)));
  const scanned = scanTopLevel(fmp4).map((b) => b.type).join(',');
  check('扫到 mdat 就停（mdat 在最后）', scanned === 'ftyp,moov,moof,mdat', scanned);

  // 普通 MP4（没有 moof）：不能边解边转，必须走整段解码
  const progressive = concat(ftyp, box('moov', 700), box('mdat', 5000));
  check('没有 moof → 不是分片', !isFragmented(progressive));
  check('没有 moof → 切不出片段', fragmentSpans(progressive).length === 0);
  check('plan 给出原因', planFragments(progressive).ok === false && planFragments(progressive).reason === 'no-fragments', JSON.stringify(planFragments(progressive).reason));
}

console.log('\n2) 切片边界');
{
  const ftyp = box('ftyp', 32);
  const moov = box('moov', 100);
  // 三片，每片 moof + mdat，中间夹一个 free
  const f1 = concat(box('moof', 100), box('mdat', 1000));
  const free = box('free', 16);
  const f2 = concat(box('moof', 120), box('mdat', 1200));
  const f3 = concat(box('moof', 80), box('mdat', 800));
  const file = concat(ftyp, moov, f1, free, f2, f3);

  const spans = fragmentSpans(file);
  check('切出 3 片', spans.length === 3, String(spans.length));

  const initEnd = 32 + 100;
  check('第一片从 moov 之后开始', spans[0].start === initEnd, String(spans[0].start));
  check('第一片包含 moof+mdat', spans[0].end - spans[0].start === 1100, String(spans[0].end - spans[0].start));
  check('第二片跳过中间的 free', spans[1].start === spans[0].end + 16, `${spans[1].start} vs ${spans[0].end + 16}`);
  check('第二片长度正确', spans[1].end - spans[1].start === 1320, String(spans[1].end - spans[1].start));
  check('第三片到文件尾', spans[2].end === file.length, `${spans[2].end} vs ${file.length}`);
  check('切片之间不重叠', spans.every((s, k) => k === 0 || s.start >= spans[k - 1].end));

  const plan = planFragments(file);
  check('plan.ok 为真', plan.ok === true);
  check('plan 给出总片数', plan.spans.length === 3, String(plan.spans.length));
  check('plan 统计分片字节', plan.fragBytes === 1100 + 1320 + 880, String(plan.fragBytes));
}

console.log('\n3) 边角情况');
{
  // moof 后面没有 mdat（畸形/截断文件）：这一片仍然交出去，让解码器去判断
  const weird = concat(box('ftyp', 16), box('moov', 50), box('moof', 60));
  const spans = fragmentSpans(weird);
  check('没有 mdat 的 moof 也能成片', spans.length === 1 && spans[0].end === weird.length, JSON.stringify(spans));

  // 64 位长度的 box（大文件会用到）
  const big = new Uint8Array(24);
  const dv = new DataView(big.buffer);
  dv.setUint32(0, 1, false); // size = 1 → 用 largesize
  'mdat'.split('').forEach((c, k) => (big[4 + k] = c.charCodeAt(0)));
  dv.setUint32(8, 0, false);
  dv.setUint32(12, 24, false);
  const scanned = scanTopLevel(concat(box('ftyp', 16), box('moov', 32), big), { maxBytes: 4096 });
  check('64 位长度的 box 能读出来', scanned.some((b) => b.type === 'mdat' && b.size === 24), JSON.stringify(scanned.map((b) => b.type + ':' + b.size)));

  // 空数据 / 垃圾数据不能抛异常
  let threw = false;
  try {
    isFragmented(new Uint8Array(0));
    fragmentSpans(new Uint8Array(0));
    planFragments(new Uint8Array([1, 2, 3, 4, 5]));
  } catch {
    threw = true;
  }
  check('空/垃圾数据不抛异常', !threw);
  check('垃圾数据 plan 返回 ok:false', planFragments(new Uint8Array([1, 2, 3, 4, 5])).ok === false);
}

console.log('\n4) 真实 m4s 头部（B 站实测的那 64KB 前 7 个 box）');
{
  // 用真机测到的骨架复现：ftyp:36, free:8, free:74, moov:816, sidx:12008, moof:1984, mdat:194268
  const real = concat(
    box('ftyp', 36),
    box('free', 8),
    box('free', 74),
    box('moov', 816),
    box('sidx', 12008),
    box('moof', 1984),
    box('mdat', 194268)
  );
  check('识别为分片 MP4', isFragmented(real));
  check('初始化段 = 36+8+74+816 = 934', initSegmentEnd(real) === 934, String(initSegmentEnd(real)));
  const spans = fragmentSpans(real);
  check('切出 1 片', spans.length === 1, String(spans.length));
  check('这一片是 moof(1984)+mdat(194268)', spans[0].end - spans[0].start === 1984 + 194268, String(spans[0].end - spans[0].start));
  check('起点正好跳过 sidx', spans[0].start === 934 + 12008, String(spans[0].start));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
