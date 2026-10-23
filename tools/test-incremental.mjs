/**
 * test-incremental.mjs —— 增量识别纯逻辑的测试
 *
 * 这些规则全部与内容无关：按标点切句、碎片合并、回声去重、按比例裁音频。
 * 所以测试只用构造文本，不绑定任何具体课程或句子。
 *
 * 运行：node tools/test-incremental.mjs
 */

import {
  splitSentences,
  isShortUtterance,
  stripCommittedOverlap,
  planInterim,
  alnumCount
} from '../lib/incremental.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

console.log('\n1) 按标点切句');
{
  check('中文句号', splitSentences('第一句。第二句。').length === 2, JSON.stringify(splitSentences('第一句。第二句。')));
  check('问号感叹号', splitSentences('真的吗？是的！').length === 2);
  check('英文标点', splitSentences('One. Two! Three?').length === 3, JSON.stringify(splitSentences('One. Two! Three?')));
  check('保留标点', splitSentences('第一句。')[0] === '第一句。', splitSentences('第一句。')[0]);
  check('没标点只有一句', splitSentences('没有标点的一句话啊').length === 1);
  check('空文本', splitSentences('').length === 0);
  check('只有标点也不炸', Array.isArray(splitSentences('。。。')));
  check('句末引号并入', splitSentences('他说：“好的。”然后走了。').length === 2, JSON.stringify(splitSentences('他说：“好的。”然后走了。')));
}

console.log('\n2) 逗号兜底（长句降延迟）');
{
  const long = '本部分包括以下四个内容，无线局域网的组成，还有物理层和MAC层协议以及帧格式等等';
  const parts = splitSentences(long);
  check('长句被切开', parts.length === 2, JSON.stringify(parts).slice(0, 80));
  check('切点在逗号后', !!parts[0] && parts[0].endsWith('，'), parts[0]?.slice(-6));
  check('两半都不至于太短', parts[0].length > 15 && parts[1].length > 3, `${parts[0].length}/${parts[1].length}`);

  const short = '短句，不切。';
  check('短句不切', splitSentences(short).length === 1);
}

console.log('\n3) 碎片判定');
{
  check('“啊。”算碎片', isShortUtterance('啊。'));
  check('“嗯，好。”算碎片', isShortUtterance('嗯，好。'));
  check('一句正常话不算', !isShortUtterance('同学们好我是郑红老师'));
  check('8 个汉字的短句不算碎片', !isShortUtterance('第一句已经说完了。'), String(alnumCount('第一句已经说完了。')));
  check('英文 9 个字符不算碎片', !isShortUtterance('good morning'), String(alnumCount('good morning')));
  check('标点不计入字数', alnumCount('啊，好。') === 2, String(alnumCount('啊，好。')));
}

console.log('\n4) 回声去重');
{
  const tail = '今天我们学习无线局域网的 MAC 帧';
  check(
    '重叠前缀被掐掉',
    stripCommittedOverlap('无线局域网的 MAC 帧，共三种类型。', tail) === '共三种类型。',
    stripCommittedOverlap('无线局域网的 MAC 帧，共三种类型。', tail)
  );
  check('不重叠就原样返回', stripCommittedOverlap('完全新的一句话。', tail) === '完全新的一句话。');
  check('空尾巴原样返回', stripCommittedOverlap('随便', '') === '随便');
  check('太短的重叠（≤2 字）不动', stripCommittedOverlap('好的开始', '好') === '好的开始');
}

console.log('\n5) planInterim：只有一句时不提交');
{
  const r = planInterim({ text: '这是一句还没说完的话', committedTail: '', bufferStartMs: 0, bufferDurationMs: 2000 });
  check('不提交', r.commits.length === 0, JSON.stringify(r));
  check('把这句话作为 remainder 返回（可以当"正在说"显示）', r.remainder === '这是一句还没说完的话', r.remainder);
}

console.log('\n6) planInterim：两句时提交前一句');
{
  const r = planInterim({
    text: '第一句已经说完了。第二句还在说',
    committedTail: '',
    bufferStartMs: 10000,
    bufferDurationMs: 4000
  });
  check('提交 1 句', r.commits.length === 1, JSON.stringify(r.commits));
  check('提交的是前一句', r.commits[0]?.text === '第一句已经说完了。', r.commits[0]?.text);
  check('remainder 是后一句', r.remainder === '第二句还在说', r.remainder);
  check('时间戳在缓冲区间内', r.commits[0].startMs >= 10000 && r.commits[0].startMs < 14000, String(r.commits[0].startMs));
  check('要裁剪音频', r.trimMs > 0, String(r.trimMs));
  check('裁剪留了余量（不会裁到末尾）', r.trimMs <= 4000 - 500 + 300, String(r.trimMs));
}

console.log('\n7) planInterim：碎片攒到下一句');
{
  const r = planInterim({
    text: '嗯。这是一个完整的长句子内容。下一句还在说',
    committedTail: '',
    bufferStartMs: 0,
    bufferDurationMs: 6000
  });
  check('碎片没有单独提交', r.commits.every((c) => c.text !== '嗯。'), JSON.stringify(r.commits.map((c) => c.text)));
  check('碎片并到了下一句前面', r.commits[0].text.startsWith('嗯。'), r.commits[0].text);
}

console.log('\n8) planInterim：去重后为空则什么都不做');
{
  const r = planInterim({
    text: '局域网的 MAC 帧',
    committedTail: '今天我们学习无线局域网的 MAC 帧',
    bufferStartMs: 0,
    bufferDurationMs: 3000
  });
  check('没有提交', r.commits.length === 0, JSON.stringify(r));
  check('不裁剪', r.trimMs === 0);
}

console.log('\n9) planInterim：尾巴累积，供下次去重');
{
  const a = planInterim({ text: '甲乙丙丁戊己庚辛壬癸。后面还在说', committedTail: '', bufferStartMs: 0, bufferDurationMs: 5000 });
  check('产生尾巴', a.tail.length > 0, a.tail);
  // 下一轮从已提交的尾巴处开始（3 字以上重叠才算回声，这是 LiveTranslate 的同款阈值）
  const b = planInterim({
    text: '壬癸。另一句已经完整。最后半句',
    committedTail: a.tail,
    bufferStartMs: 3000,
    bufferDurationMs: 5000
  });
  check(
    '下一轮识别到重叠不会重复输出',
    b.commits.length === 1 && b.commits[0].text === '另一句已经完整。',
    JSON.stringify(b.commits.map((c) => c.text))
  );

  // 重叠太短（≤2 字）时故意不动：否则容易误伤正常开头
  const c = planInterim({
    text: '癸。这是一句完整的话。还在说',
    committedTail: a.tail,
    bufferStartMs: 0,
    bufferDurationMs: 3000
  });
  check('2 字重叠不裁（避免误伤）', !!c.commits[0] && c.commits[0].text.startsWith('癸。'), JSON.stringify(c.commits.map((x) => x.text)));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');





