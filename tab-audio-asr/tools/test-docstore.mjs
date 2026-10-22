/**
 * test-docstore.mjs —— 字幕库（按视频存/取）的纯逻辑测试
 *
 * 只测数据层面：整理、去重、容量淘汰、排序、容错。
 * 真正的 chrome.storage 读写由 background.js 负责，不在这里测。
 *
 * 运行：node tools/test-docstore.mjs
 */

import {
  MAX_DOCS,
  buildDoc,
  getDoc,
  upsertDoc,
  pruneDocs,
  listDocs,
  removeDoc,
  sanitizeDocs
} from '../lib/docstore.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
}

const seg = (t, start, dur = 2000) => ({ status: 'done', text: t, startMs: start, durationMs: dur });

console.log('\n1) buildDoc：整理成可存储的文档');
{
  const doc = buildDoc({
    key: 'https://x.com/a#529s',
    segments: [seg('第二句。', 10000), seg('第一句。', 0), { status: 'skipped', text: 'x', startMs: 0 }],
    model: 'Qwen/Qwen3-ASR-1.7B',
    title: '第9章',
    durationMs: 529000
  });

  check('句数只算 done', doc.count === 2, String(doc.count));
  check('按时间排序', doc.segments[0].text === '第一句。', doc.segments.map((s) => s.text).join('|'));
  check('跳过段被丢掉', !doc.segments.some((s) => s.text === 'x'));
  // 正文用换行连接，所以字符数按 join('\n') 算
  check('字符数统计正确', doc.chars === doc.segments.map((s) => s.text).join('\n').length, String(doc.chars));
  check('保留标题与模型', doc.title === '第9章' && doc.model.includes('ASR'), `${doc.title}/${doc.model}`);
  check('没有 key 返回 null', buildDoc({ segments: [seg('a', 0)] }) === null);
  check('没有句子返回 null', buildDoc({ key: 'k', segments: [] }) === null);
}

console.log('\n2) 存 / 取 / 删');
{
  let docs = {};
  const d1 = buildDoc({ key: 'k1', segments: [seg('甲的稿子。', 0)], title: '甲' });
  docs = upsertDoc(docs, d1);
  check('存进去能取到', getDoc(docs, 'k1')?.title === '甲');

  const d2 = buildDoc({ key: 'k2', segments: [seg('乙的稿子。', 0)], title: '乙' });
  docs = upsertDoc(docs, d2);
  check('两份都在', Object.keys(docs).length === 2);

  // 同 key 再存 → 覆盖
  const d1b = buildDoc({ key: 'k1', segments: [seg('甲改过。', 0)], title: '甲2' });
  docs = upsertDoc(docs, d1b);
  check('同 key 覆盖而不是新增', Object.keys(docs).length === 2, String(Object.keys(docs).length));
  check('覆盖后是新内容', getDoc(docs, 'k1')?.title === '甲2');

  docs = removeDoc(docs, 'k1');
  check('删除生效', getDoc(docs, 'k1') === null && Object.keys(docs).length === 1);
  check('删不存在的 key 不报错', removeDoc(docs, 'nope') === docs);
  check('取不存在的 key 返回 null', getDoc(docs, 'nope') === null);
}

console.log('\n3) upsertDoc 不修改原对象（防止外部持有旧引用）');
{
  const docs = {};
  const d = buildDoc({ key: 'k', segments: [seg('a。', 0)] });
  const next = upsertDoc(docs, d);
  check('原对象仍为空', Object.keys(docs).length === 0);
  check('新对象有内容', Object.keys(next).length === 1);
}

console.log('\n4) 容量淘汰（保留最新的 max 份）');
{
  let docs = {};
  for (let i = 0; i < 12; i++) {
    docs = upsertDoc(docs, buildDoc({ key: `k${i}`, segments: [seg('句子。', 0)], createdAt: 1000 + i }), { max: 10 });
  }
  const keys = Object.keys(docs);
  check('只留 10 份', keys.length === 10, String(keys.length));
  check('最旧的 k0 被淘汰', !keys.includes('k0'), keys.join(','));
  check('最新的 k11 还在', keys.includes('k11'));
}

console.log('\n5) pruneDocs 边界');
{
  const docs = { a: { createdAt: 1 }, b: { createdAt: 2 } };
  check('没超限就原样返回', pruneDocs(docs, { max: 5 }) === docs);
  check('max=0 时清空', Object.keys(pruneDocs(docs, { max: 0 })).length === 0);
  check('空对象安全', Object.keys(pruneDocs({}, { max: 3 })).length === 0);
  check('默认上限是 MAX_DOCS', typeof MAX_DOCS === 'number' && MAX_DOCS > 0, String(MAX_DOCS));
}

console.log('\n6) listDocs：按时间新→旧，且不含正文');
{
  const docs = {
    a: { title: '旧', count: 1, chars: 5, createdAt: 100 },
    b: { title: '新', count: 2, chars: 9, createdAt: 300 }
  };
  const list = listDocs(docs);
  check('新的在前', list[0].title === '新', JSON.stringify(list.map((x) => x.title)));
  check('返回条数正确', list.length === 2);
  check('不带 segments', list.every((x) => !('segments' in x)));
  check('空库返回空数组', listDocs({}).length === 0);
}

console.log('\n7) sanitizeDocs：坏数据兜住');
{
  check('null → {}', Object.keys(sanitizeDocs(null)).length === 0);
  check('数组 → {}', Object.keys(sanitizeDocs([1, 2])).length === 0);
  check('字符串 → {}', Object.keys(sanitizeDocs('x')).length === 0);
  const mixed = sanitizeDocs({
    good: { segments: [seg('a。', 0)], createdAt: 1 },
    noSeg: { createdAt: 1 },
    emptySeg: { segments: [] },
    notObj: 5
  });
  check('只保留有 sentences 的条目', Object.keys(mixed).join(',') === 'good', Object.keys(mixed).join(','));
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');

