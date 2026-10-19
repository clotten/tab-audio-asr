/**
 * test-glossary.mjs —— 术语表机制测试
 *
 * 注意：默认术语表是**空的**（这是通用性要求）。所以这里自带一份 fixture，
 * 测的是"机制"（解析、按长度排序、替换、格式化、模型回复解析），
 * 不绑定任何具体领域数据。
 *
 * 运行：node tools/test-glossary.mjs
 */

import {
  DEFAULT_GLOSSARY_TEXT,
  parseGlossary,
  applyGlossary,
  buildCorrectionMessages,
  parseCorrectionResponse
} from '../lib/glossary.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

/* 测试用 fixture（不是内置默认值） */
const FIXTURE = `# 注释行应被忽略
无线局域网
802.11
甲错法 => 正确说法
乙错法很长 => 长错法
ABC错 => ABC 对
MAX协议 => MAC 协议
`;

console.log('\n1) 默认值是空的（通用性要求）');
{
  check('DEFAULT_GLOSSARY_TEXT 为空字符串', DEFAULT_GLOSSARY_TEXT === '', JSON.stringify(DEFAULT_GLOSSARY_TEXT));
  const empty = parseGlossary(DEFAULT_GLOSSARY_TEXT);
  check('默认解析出 0 条规则', empty.pairs.length === 0);
  check('默认解析出 0 个术语', empty.terms.length === 0);
  check('空术语表下 applyGlossary 只做格式化', applyGlossary('中文abc', empty) === '中文 abc');
}

console.log('\n2) 解析 fixture');
{
  const g = parseGlossary(FIXTURE);
  check('4 条替换规则', g.pairs.length === 4, `实际 ${g.pairs.length}`);
  // 裸词 + 每条规则的"右边"都会作为术语交给模型（右边才是正确写法）
  check('术语含裸词', g.terms.includes('无线局域网') && g.terms.includes('802.11'), JSON.stringify(g.terms));
  check(
    '术语也含规则右侧的正确写法',
    ['正确说法', '长错法', 'ABC 对', 'MAC 协议'].every((t) => g.terms.includes(t)),
    JSON.stringify(g.terms)
  );
  check('术语去重', g.terms.length === new Set(g.terms).size, JSON.stringify(g.terms));
  check('注释被忽略', !g.terms.some((t) => t.startsWith('#')));
  check(
    '长错法排在短错法前面',
    g.pairs.findIndex(([w]) => w === '乙错法很长') < g.pairs.findIndex(([w]) => w === '甲错法')
  );
}

console.log('\n3) 替换行为');
{
  const g = parseGlossary(FIXTURE);
  check('中文字面替换', applyGlossary('这是甲错法。', g) === '这是正确说法。');
  check('长规则优先', applyGlossary('乙错法很长', g) === '长错法');
  check('英文忽略大小写', applyGlossary('讨论 max协议', g) === '讨论 MAC 协议');
  check('英文规则保留原空格写法', applyGlossary('ABC错', g) === 'ABC 对');
  check('未命中不改动', applyGlossary('完全正常的一句话。', g) === '完全正常的一句话。');
}

console.log('\n4) 边界');
{
  const g = parseGlossary(FIXTURE);
  check('空输入安全', applyGlossary('', g) === '');
  check('无规则时原样返回（仅格式化）', applyGlossary('abc', { pairs: [], terms: [] }) === 'abc');
  check('只有注释的术语表解析为空', parseGlossary('# 只有注释\n\n').pairs.length === 0);
  check(
    '缺右边时不成为规则',
    parseGlossary('只写错法 =>').pairs.length === 0,
    JSON.stringify(parseGlossary('只写错法 =>'))
  );
}

console.log('\n5) 中英文之间补空格');
{
  check('数字与中文之间', applyGlossary('学习802.11无线局域网', parseGlossary('')) === '学习 802.11 无线局域网');
}

console.log('\n6) 纠错提示词：有/无术语表都能构造');
{
  const withTerms = buildCorrectionMessages([{ time: '00:01', text: '测试' }], parseGlossary(FIXTURE));
  check('带术语表时提示里出现术语', withTerms[1].content.includes('无线局域网'), withTerms[1].content.slice(0, 80));

  const noTerms = buildCorrectionMessages([{ time: '00:01', text: '测试' }], parseGlossary(''));
  check('无术语表时不出现"术语表"字样', !noTerms[1].content.includes('术语表'), noTerms[1].content.slice(0, 60));
  check('无论如何都包含正文行', noTerms[1].content.includes('00:01 测试'));
  check('system 仍要求保持行数与格式', noTerms[0].content.includes('行数必须与输入一致'));
}

console.log('\n7) 解析模型回复');
{
  const r1 = parseCorrectionResponse('00:29 第一行。\n00:37 第二行。');
  check('标准两行', r1.length === 2 && r1[0].time === '00:29' && r1[0].text === '第一行。', JSON.stringify(r1));

  const r2 = parseCorrectionResponse('\n\n[00:39] 带方括号\n\n\n');
  check('容错：空行 + 方括号', r2.length === 1 && r2[0].time === '00:39', JSON.stringify(r2));

  const r3 = parseCorrectionResponse('```\n00:42 代码块里\n```');
  check('容错：代码块围栏', r3.length === 1 && r3[0].text === '代码块里', JSON.stringify(r3));

  const r4 = parseCorrectionResponse('好的，下面是校对结果：\n00:45 正文');
  check('容错：无视前后解释文字', r4.length === 1 && r4[0].time === '00:45', JSON.stringify(r4));

  const r5 = parseCorrectionResponse('1:05:09 长视频时间戳');
  check('支持 h:mm:ss', r5.length === 1 && r5[0].time === '1:05:09', JSON.stringify(r5));

  check('空回复返回空数组', parseCorrectionResponse('').length === 0);
  check('乱七八糟的回复不抛错', parseCorrectionResponse('这不是时间戳开头的行').length === 0);
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
