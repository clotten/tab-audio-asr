/**
 * test-videokey.mjs —— 视频标识（字幕按视频隔离）的测试
 *
 * 核心保证：同一个视频在刷新/换签名后键不变；不同视频必须不同。
 *
 * 运行：node tools/test-videokey.mjs
 */

import { normalizeVideoUrl, videoKeyOf, sameVideo } from '../lib/videokey.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

console.log('\n1) 签名参数会被丢掉（换签名后仍是同一个视频）');
{
  const a = normalizeVideoUrl('https://ali-cdn.xuetangx.com/1/1031-10.mp4?auth_key=aaa-111&sign=xx');
  const b = normalizeVideoUrl('https://ali-cdn.xuetangx.com/1/1031-10.mp4?auth_key=bbb-222&sign=yy');
  check('两个签名不同的地址归一后相同', a === b, `${a} vs ${b}`);
  check('路径保留了', a.includes('1031-10.mp4'), a);
}

console.log('\n2) 视频 id 类参数会保留');
{
  const k1 = normalizeVideoUrl('https://www.bilibili.com/video/BV1xx?bvid=BV1xx&auth_key=1');
  const k2 = normalizeVideoUrl('https://www.bilibili.com/video/BV1xx?bvid=BV1yy&auth_key=1');
  check('bvid 不同 → 键不同', k1 !== k2, `${k1} vs ${k2}`);
  check('bvid 保留在键里', k1.includes('bvid=BV1xx'), k1);

  const p1 = normalizeVideoUrl('https://v.qq.com/x/page/x.html?vid=abc&token=1');
  const p2 = normalizeVideoUrl('https://v.qq.com/x/page/x.html?vid=def&token=1');
  check('vid 不同 → 键不同', p1 !== p2, `${p1} vs ${p2}`);
}

console.log('\n3) 时长参与标识（同一路径不同集）');
{
  const a = videoKeyOf({ href: 'https://x.com/course/1', duration: 528.7 });
  const b = videoKeyOf({ href: 'https://x.com/course/1', duration: 300.2 });
  check('时长不同 → 键不同', a !== b, `${a} vs ${b}`);
  check('时长取整到秒', a.endsWith('#529s'), a);
  check('同 URL 同时长 → 相同', videoKeyOf({ href: 'https://x.com/course/1', duration: 528.9 }) === a);
}

console.log('\n4) 没有时长时只用 URL');
{
  const k = videoKeyOf({ href: 'https://x.com/a?utm_source=wx', duration: null });
  check('不含 #', !k.includes('#'), k);
  check('utm 被丢弃', !k.includes('utm'), k);
}

console.log('\n5) 异常输入不抛错');
{
  for (const bad of ['', null, undefined, 'not a url', 'file:///x']) {
    let ok = true;
    try {
      videoKeyOf({ href: bad, duration: NaN });
    } catch {
      ok = false;
    }
    check(`不抛错：${JSON.stringify(bad)}`, ok);
  }
}

console.log('\n6) sameVideo 的容错');
{
  check('两边都有且相同', sameVideo('a', 'a'));
  check('两边都有但不同', !sameVideo('a', 'b'));
  check('任一方为空时视为无法判断（不误伤）', sameVideo('a', '') && sameVideo(null, 'b'));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
