/**
 * test-silero.mjs —— Silero 门控逻辑的离线测试
 *
 * 真实模型的行为已经在真音频上验证过（片头音乐段均值 0.003，讲话段 0.53–0.63），
 * 这里只测"把连续 PCM 拆帧、记录概率、按时间段求均值、判定丢弃"这段胶水代码。
 *
 * 运行：node tools/test-silero.mjs
 */

import { createSileroGate, SILERO_FRAME_SIZE } from '../lib/silero.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SR = 16000;
const FRAME_MS = (SILERO_FRAME_SIZE / SR) * 1000; // 32ms

function fakeVad(probFn) {
  let calls = 0;
  return {
    frameSize: SILERO_FRAME_SIZE,
    sampleRate: SR,
    get calls() {
      return calls;
    },
    async push(frame) {
      const p = probFn(calls++, frame);
      return p;
    }
  };
}

const tone = (n, amp = 0.3) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 300 * i) / SR);
  return out;
};

console.log('\n1) 帧拆分');
{
  const vad = fakeVad(() => 0.9);
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(2048)); // 正好 4 帧
  await sleep(50);
  check('2048 采样 → 4 帧', gate.stats().frames === 4, JSON.stringify(gate.stats()));
  check('每次 push 都调用了模型', vad.calls === 4, String(vad.calls));

  const vad2 = fakeVad(() => 0.9);
  const gate2 = createSileroGate({ vad: vad2, sampleRate: SR });
  gate2.push(tone(1000));
  gate2.push(tone(1000)); // 合计 2000 → 3 帧，剩 464
  await sleep(50);
  check('1000+1000 → 3 帧（余数保留）', gate2.stats().frames === 3, JSON.stringify(gate2.stats()));
}

console.log('\n2) 按时间段求平均');
{
  const vad = fakeVad(() => 0.8);
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(SILERO_FRAME_SIZE * 10)); // 10 帧 ≈ 320ms
  const p = await gate.meanProb(0, 320);
  check('恒定 0.8 → 均值 0.8', Math.abs(p - 0.8) < 0.01, String(p));

  const p2 = await gate.meanProb(1000, 2000);
  check('区间外没有数据 → null', p2 === null, String(p2));
}

console.log('\n3) 混合区段（模拟 0.9 / 0.1 交替）');
{
  const vad = fakeVad((i) => (i % 2 === 0 ? 0.9 : 0.1));
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(SILERO_FRAME_SIZE * 20));
  const p = await gate.meanProb(0, 20 * FRAME_MS);
  check('交替 0.9/0.1 → 均值约 0.5', Math.abs(p - 0.5) < 0.06, String(p));
}

console.log('\n4) 真实场景：音乐段 vs 讲话段');
{
  // 前 24 秒音乐（0.003），之后讲话（0.55）
  const musicMs = 24000;
  const vad = fakeVad((i) => {
    const t = i * FRAME_MS;
    return t < musicMs ? 0.003 : 0.55;
  });
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(Math.round((SR * 40000) / 1000))); // 40 秒

  const music = await gate.meanProb(4000, 24000);
  const speech = await gate.meanProb(26000, 40000);
  check('音乐段均值 < 0.05（会被丢）', music < 0.05, String(music));
  check('讲话段均值 > 0.25（会保留）', speech > 0.25, String(speech));
  check('阈值 0.25 能分开两者', music < 0.25 && speech > 0.25, `${music.toFixed(3)} / ${speech.toFixed(3)}`);
}

console.log('\n5) 推理比实时慢时，meanProb 会等待');
{
  let done = 0;
  const vad = {
    frameSize: SILERO_FRAME_SIZE,
    async push() {
      await sleep(5);
      done += 1;
      return 0.7;
    }
  };
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(SILERO_FRAME_SIZE * 8));
  const p = await gate.meanProb(0, 8 * FRAME_MS);
  check('等待后拿到完整均值', p !== null && Math.abs(p - 0.7) < 0.01, String(p));
  check('8 帧都跑完了', done === 8, String(done));
}

console.log('\n6) 模型报错不会拖垮管线');
{
  const vad = {
    frameSize: SILERO_FRAME_SIZE,
    async push() {
      throw new Error('模拟 wasm 崩了');
    }
  };
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(tone(SILERO_FRAME_SIZE * 5));
  const p = await gate.meanProb(0, 5 * FRAME_MS);
  check('返回 null 而不是抛错', p === null, String(p));
  check('失败被记账', gate.stats().failures === 5, JSON.stringify(gate.stats()));
}

console.log('\n7) 空输入安全');
{
  const vad = fakeVad(() => 0.5);
  const gate = createSileroGate({ vad, sampleRate: SR });
  gate.push(new Float32Array(0));
  gate.push(null);
  await sleep(20);
  check('不会崩，帧数仍为 0', gate.stats().frames === 0, JSON.stringify(gate.stats()));
  check('空区间返回 null', (await gate.meanProb(0, 100)) === null);
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
