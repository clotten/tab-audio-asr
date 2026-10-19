/**
 * test-hallucination.mjs —— 幻觉过滤的通用规则测试
 *
 * 这里**故意没有任何具体句子**：过滤不靠黑名单，只靠三条与内容无关的约束
 *   ① 语速上限  ② 稀疏下限  ③ 复读检测
 * 所以测试也只用"构造出来的、体现约束"的文本，不绑定某一门课或某一个模型。
 *
 * 运行：node tools/test-hallucination.mjs
 */

import { looksLikeHallucination, hasRepetition, contentLength } from '../lib/hallucination.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

console.log('\n1) 正常句子必须保留');
{
  const ok = [
    ['同学们好。', 2340],
    ['学习无线局域网 WLAN。', 2500],
    ['包括以下四个内容：无线局域网的组成、802.11 局域网的物理层。', 6200],
    ['啊！', 3490],
    ['嗯。', 1800],
    ['This is a test of the emergency broadcast system.', 4000],
    ['Yes.', 1200]
  ];
  for (const [text, ms] of ok) {
    check(`保留「${text.slice(0, 18)}」`, !looksLikeHallucination(text, ms), `${ms}ms`);
  }
}

console.log('\n2) 语速上限（物理不可能）');
{
  check('0.5 秒说 12 个字 → 丢', looksLikeHallucination('一二三四五六七八九十甲乙', 500));
  check('5 秒说 12 个字 → 留', !looksLikeHallucination('一二三四五六七八九十甲乙', 5000));
  check('标点不计入字数', !looksLikeHallucination('你，好，啊，这，是，测，试。', 1000));
  check('contentLength 去掉标点和空格', contentLength('你，好 。') === 2, String(contentLength('你，好 。')));
}

console.log('\n3) 稀疏下限（长音频只出几个字）');
{
  check('18 秒 5 个字 → 丢', looksLikeHallucination('Oh, oh', 18440));
  check('12 秒 2 个字 → 丢', looksLikeHallucination('Oh', 12000));
  check('10 秒一句正常话 → 留', !looksLikeHallucination('今天我们学习 802.11 局域网的 MAC 帧。', 10000));
  check('9 秒一句短话 → 留', !looksLikeHallucination('无线局域网的组成。', 9000));
  check('短段不套用稀疏规则', !looksLikeHallucination('嗯。', 1500));
}

console.log('\n4) 复读检测（模型卡死的典型故障）');
{
  check('同短语 3 次 → 丢', hasRepetition('谢谢观看谢谢观看谢谢观看'));
  check('交替复读 → 丢', hasRepetition('好的好的好的好的'));
  check('正常重复不算（2 次）', !hasRepetition('好的好的，我们开始'));
  check('长句不误判', !hasRepetition('今天我们来学习无线局域网的组成，本部分包括以下四个内容'));
  check('复读句整体判为幻觉', looksLikeHallucination('请订阅请订阅请订阅', 3000));
}

console.log('\n5) 空内容 / 纯符号');
{
  check('空字符串', looksLikeHallucination('', 1000));
  check('只有空格', looksLikeHallucination('   ', 1000));
  check('只有标点', looksLikeHallucination('。。。', 1000));
  check('只有表情/符号', looksLikeHallucination('🎼—— ……', 2000));
}

console.log('\n6) 不依赖具体内容（通用性回归）');
{
  // 同一句"看起来像幻觉"的话，只要语速合理、不稀疏、不复读，就必须保留——
  // 因为通用规则不该替用户判断"这句话该不该说"。
  const arbitrary = ['今天天气不错。', 'Let me think about it.', '嗯，这个嘛，我们再看看。'];
  for (const t of arbitrary) {
    check(`任意内容保留「${t.slice(0, 12)}」`, !looksLikeHallucination(t, 3000));
  }
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
