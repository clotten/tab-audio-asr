/**
 * test-translate.mjs —— 字幕翻译纯逻辑测试
 *
 * 重点测：分批、提示词形状、模型回复的各种脏格式、长度不匹配必须判失败、回填不改原文。
 *
 * 运行：node tools/test-translate.mjs
 */

import {
  TRANSLATE_BATCH,
  DEFAULT_TARGET,
  chunkTexts,
  buildTranslateMessages,
  parseTranslateReply,
  applyTranslations,
  needsTranslation,
  translationStats
} from '../lib/translate.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

console.log('\n1) 分批');
{
  const texts = Array.from({ length: 45 }, (_, i) => `第${i + 1}句`);
  const batches = chunkTexts(texts, 20);
  check('切成 3 批', batches.length === 3, String(batches.length));
  check('前两批各 20 句', batches[0].length === 20 && batches[1].length === 20);
  check('最后一批 5 句', batches[2].length === 5, String(batches[2].length));
  check('拼回去顺序不变', batches.flat().join('|') === texts.join('|'));
  check('空数组不炸', chunkTexts([], 20).length === 0);
  check('默认批量是常量', chunkTexts(Array(25).fill('x')).length === Math.ceil(25 / TRANSLATE_BATCH));
}

console.log('\n2) 提示词');
{
  const msgs = buildTranslateMessages(['おはよう', 'ありがとう'], { target: '中文' });
  check('两条消息（system + user）', msgs.length === 2, String(msgs.length));
  check('system 要求 JSON 数组', /JSON 数组/.test(msgs[0].content), msgs[0].content.slice(0, 40));
  check('system 要求行数一致', /数量.*一致/.test(msgs[0].content));
  check('user 带编号', /^1\. おはよう/m.test(msgs[1].content), msgs[1].content);
  check('默认目标是中文', DEFAULT_TARGET === '中文');
  const custom = buildTranslateMessages(['a'], { target: '英文' });
  check('目标语言可改', /英文/.test(custom[0].content));
}

console.log('\n3) 解析模型回复');
{
  const ok = parseTranslateReply('["早上好","谢谢"]', 2);
  check('标准 JSON 数组', ok && ok[0] === '早上好' && ok[1] === '谢谢', JSON.stringify(ok));

  const fenced = parseTranslateReply('```json\n["早上好","谢谢"]\n```', 2);
  check('带代码围栏也能解析', fenced && fenced.length === 2, JSON.stringify(fenced));

  const chatty = parseTranslateReply('好的，翻译如下：\n["早上好","谢谢"]\n希望有帮助', 2);
  check('前后有解释也能解析', chatty && chatty.length === 2, JSON.stringify(chatty));

  const lines = parseTranslateReply('1. 早上好\n2. 谢谢', 2);
  check('纯按行兜底', lines && lines[0] === '早上好' && lines[1] === '谢谢', JSON.stringify(lines));

  const wrong = parseTranslateReply('["只有一句"]', 3);
  check('数量不对必须返回 null', wrong === null, JSON.stringify(wrong));

  check('空回复返回 null', parseTranslateReply('', 2) === null);
  check('纯废话返回 null', parseTranslateReply('抱歉我不能做这个', 2) === null, String(parseTranslateReply('抱歉我不能做这个', 2)));

  const empty = parseTranslateReply('["",""]', 2);
  check('允许空字符串（模型跳过某句）', empty && empty.length === 2);
}

console.log('\n4) 回填不改原文');
{
  const segs = [
    { index: 0, text: 'おはよう', status: 'done' },
    { index: 1, text: 'ありがとう', status: 'done' }
  ];
  const out = applyTranslations(segs, ['早上好', '谢谢']);
  check('译文已写入', out[0].translation === '早上好' && out[1].translation === '谢谢');
  check('原文没被改', out[0].text === 'おはよう');
  check('不修改入参', segs[0].translation === undefined);
  check('从第 3 条开始回填', applyTranslations([{ text: 'a' }, { text: 'b' }, { text: 'c' }], ['X'], 2)[2].translation === 'X');
  check('超出范围不报错', applyTranslations([{ text: 'a' }], ['X', 'Y']).length === 1);
}

console.log('\n5) 统计与跳过');
{
  check('空文本不需要翻译', needsTranslation({ text: '  ' }) === false);
  check('已有译文不重复翻译', needsTranslation({ text: 'a', translation: 'b' }) === false);
  check('有原文无译文需要翻译', needsTranslation({ text: 'a' }) === true);

  const stats = translationStats([
    { status: 'done', text: 'a', translation: 'A' },
    { status: 'done', text: 'b' },
    { status: 'skipped', text: 'c' }
  ]);
  check('总数只算 done 且有文本', stats.total === 2, String(stats.total));
  check('已译 1', stats.done === 1, String(stats.done));
  check('待译 1', stats.pending === 1, String(stats.pending));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
