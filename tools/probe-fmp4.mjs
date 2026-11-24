import { readFileSync } from 'node:fs';
import { planFragments, scanTopLevel, isFragmented } from '../lib/fmp4.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法: node tools/probe-fmp4.mjs <文件> [文件2…]');
  process.exit(1);
}

for (const f of files) {
  const bytes = new Uint8Array(readFileSync(f));
  console.log(`\n=== ${f} ===`);
  console.log(`  总大小 ${(bytes.length / 1048576).toFixed(1)} MB`);

  const head = scanTopLevel(bytes, { maxBytes: 512 * 1024, maxBoxes: 32 });
  console.log('  头部 box: ' + head.map((b) => `${b.type}(${b.size})`).join(' '));
  console.log('  是分片 MP4: ' + isFragmented(bytes));

  const plan = planFragments(bytes);
  console.log(`  plan.ok=${plan.ok} initEnd=${plan.initEnd} 分片数=${plan.spans.length}`);
  if (plan.spans.length) {
    const sizes = plan.spans.map((s) => s.end - s.start);
    const sum = sizes.reduce((a, b) => a + b, 0);
    console.log(`  分片字节合计 ${(sum / 1048576).toFixed(2)} MB，单片 ${sizes[0]} ~ ${sizes[sizes.length - 1]}`);
    // 检查覆盖是否有缝隙（缝隙 = 解析漏了 box，会导致某些片段解不开）
    let gaps = 0;
    let prevEnd = plan.initEnd;
    for (const s of plan.spans) {
      if (s.start > prevEnd) gaps += s.start - prevEnd;
      prevEnd = s.end;
    }
    const tail = bytes.length - prevEnd;
    console.log(`  片与片之间的缝隙合计 ${gaps} 字节；最后一片之后剩余 ${tail} 字节`);
  }
}
