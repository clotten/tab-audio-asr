/**
 * test-platforms.mjs —— 平台适配器注册表
 *
 * 这一层的意义是"以后加平台只改一个文件"。所以测试要盯两件事：
 *   1. 每个适配器都把必需字段声明全了（漏一个，主流程就会出现 if 分支）；
 *   2. 用**真机抓到的 URL** 验证挑音轨的结果对不对（B 站 / 抖音各一组）。
 *
 * 运行：node tools/test-platforms.mjs
 */

import {
  PLATFORMS,
  REQUIRED_FIELDS,
  platformForPage,
  platformForMedia,
  platformLabel,
  hookSpec,
  cdnRulesFor,
  allRuleIds,
  pickAudioUrl
} from '../lib/platforms/registry.js';

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

/* 真机抓到的样本（2026-11 实测） */
const BILI_AUDIO =
  'https://cn-hnzz-fx-01-03.bilivideo.com/upgcxcode/58/28/123456789/123456789-1-30280.m4s?e=xxx&uipk=5&nbs=1';
const BILI_AUDIO_LOW =
  'https://cn-hnzz-fx-01-03.bilivideo.com/upgcxcode/58/28/123456789/123456789-1-30216.m4s?e=xxx';
const BILI_VIDEO =
  'https://cn-hnzz-fx-01-03.bilivideo.com/upgcxcode/58/28/123456789/123456789-1-100026.m4s?e=xxx';

const DY_AUDIO =
  'https://v26-web.douyinvod.com/3b45.../video/tos/cn/tos-cn-ve-15/okIAFi.../media-audio-und-mp4a/?a=6383&br=190&mime_type=video_mp4';
const DY_VIDEO =
  'https://v26-web.douyinvod.com/3b45.../video/tos/cn/tos-cn-vd-0026/oMFD.../media-video-avc1/?a=6383&br=2294&mime_type=video_mp4';

console.log('\n1) 适配器完整性（加平台时最容易漏的地方）');
{
  check('至少有两个平台', PLATFORMS.length >= 2, String(PLATFORMS.length));
  for (const p of PLATFORMS) {
    const missing = REQUIRED_FIELDS.filter((f) => p[f] === undefined || p[f] === null);
    check(`${p.id}：必需字段齐全`, missing.length === 0, missing.join(','));
    check(`${p.id}：有中文名`, typeof p.name === 'string' && p.name.length > 0);
    check(`${p.id}：pagePattern 是正则`, p.pagePattern instanceof RegExp);
    check(`${p.id}：pickAudio 是函数`, typeof p.pickAudio === 'function');
    check(`${p.id}：cdn.ruleBase 是数字`, Number.isFinite(p.cdn?.ruleBase), String(p.cdn?.ruleBase));
  }
  const ids = PLATFORMS.map((p) => p.id);
  check('id 不重复', new Set(ids).size === ids.length, ids.join(','));
  const bases = PLATFORMS.map((p) => p.cdn.ruleBase);
  check('ruleBase 不重叠', new Set(bases).size === bases.length, bases.join(','));
}

console.log('\n2) 页面归属');
{
  check('B 站视频页', platformForPage('https://www.bilibili.com/video/BV1Qv4y197V6/')?.id === 'bilibili');
  check('B 站带语言前缀', platformForPage('https://www.bilibili.com/zh-Hans/video/BV1UJFKeWEx6/')?.id === 'bilibili');
  check('B 站空间页', platformForPage('https://space.bilibili.com/123')?.id === 'bilibili');
  check('抖音视频页', platformForPage('https://www.douyin.com/video/7710521429434862884')?.id === 'douyin');
  check('抖音精选弹窗', platformForPage('https://www.douyin.com/jingxuan?modal_id=771')?.id === 'douyin');
  check('无关站点返回 null', platformForPage('https://example.com/x') === null);
  check('非法 URL 返回 null', platformForPage('not-a-url') === null);
  check('platformLabel 给中文名', platformLabel('https://www.douyin.com/video/1') === '抖音');
}

console.log('\n3) 媒体链接归属');
{
  check('bilivideo → bilibili', platformForMedia(BILI_AUDIO)?.id === 'bilibili');
  check('douyinvod → douyin', platformForMedia(DY_AUDIO)?.id === 'douyin');
  check('未知 CDN → null', platformForMedia('https://cdn.example.com/a.mp4') === null);
}

console.log('\n4) 挑音轨（用真机 URL 验证）');
{
  const bili = pickAudioUrl([BILI_VIDEO, BILI_AUDIO], { pageUrl: 'https://www.bilibili.com/video/BV1' });
  check('B 站：挑出 -30280 音轨而不是视频轨', bili === BILI_AUDIO, bili.slice(-40));

  const biliBest = pickAudioUrl([BILI_AUDIO_LOW, BILI_AUDIO]);
  check('B 站：高码率优先（30280 > 30216）', biliBest === BILI_AUDIO, biliBest.slice(-40));
  check('B 站：顺序反过来也挑对', pickAudioUrl([BILI_AUDIO, BILI_VIDEO]) === BILI_AUDIO);

  const dy = pickAudioUrl([DY_VIDEO, DY_AUDIO], { pageUrl: 'https://www.douyin.com/video/1' });
  check('抖音：挑 media-audio 而不是 media-video', dy === DY_AUDIO, dy.slice(-40));
  check('抖音：顺序反过来也挑对', pickAudioUrl([DY_AUDIO, DY_VIDEO]) === DY_AUDIO);

  // 抖音经常只给"混合轨"（play_addr），里面也有音轨——不能挑空
  const muxed = 'https://v26-web.douyinvod.com/x/video/tos/cn/abc/?a=6383&mime_type=video_mp4';
  check('抖音：只有混合轨时也能用', pickAudioUrl([muxed], { pageUrl: 'https://www.douyin.com/video/1' }) === muxed);

  check('空输入返回空串', pickAudioUrl([]) === '');
  check('非 http 的候选被忽略', pickAudioUrl(['blob:https://x/y', 'data:audio/wav;base64,AA']) === '');
}

console.log('\n5) 钩子配置（合并所有平台的监听规则）');
{
  const spec = hookSpec();
  check('pattern 是字符串', typeof spec.pattern === 'string' && spec.pattern.length > 0);
  const re = new RegExp(spec.pattern, 'i');
  check('能匹配 B 站播放接口', re.test('https://api.bilibili.com/x/player/playurl?bvid=BV1'));
  check('能匹配 B 站 wbi 接口', re.test('https://api.bilibili.com/x/player/wbi/playurl'));
  check('能匹配抖音详情接口', re.test('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1'));
  check('不匹配普通接口', !re.test('https://api.example.com/user/profile'));
  check('音轨关键词合并了各平台', /media-audio/.test(spec.audioMarkers.join(' ')) && /-30280/.test(spec.audioMarkers.join(' ')));
}

console.log('\n6) CDN 请求头规则（各平台自己声明）');
{
  const dy = cdnRulesFor(DY_AUDIO);
  check('抖音：生成了规则', dy.rules.length === 1, String(dy.rules.length));
  const dyHeader = dy.rules[0]?.action?.requestHeaders?.find((h) => h.header === 'referer');
  check('抖音：Referer 指向 douyin.com', dyHeader?.value === 'https://www.douyin.com/', dyHeader?.value);
  check('抖音：规则 id 落在自己的号段', dy.rules[0]?.id >= 9011 && dy.rules[0]?.id < 9021, String(dy.rules[0]?.id));

  const bili = cdnRulesFor(BILI_AUDIO);
  const biliHeader = bili.rules[0]?.action?.requestHeaders?.find((h) => h.header === 'referer');
  check('B 站：Referer 指向 bilibili.com', biliHeader?.value === 'https://www.bilibili.com/', biliHeader?.value);
  check('B 站：规则 id 落在自己的号段', bili.rules[0]?.id >= 9001 && bili.rules[0]?.id < 9011, String(bili.rules[0]?.id));

  const none = cdnRulesFor('https://cdn.example.com/a.mp4');
  check('未知 CDN：不生成规则', none.rules.length === 0);

  const ids = allRuleIds();
  check('卸载用的 id 列表覆盖两个平台', ids.length >= 2 && ids.includes(9001) && ids.includes(9011), ids.join(','));
  check('id 不重复', new Set(ids).size === ids.length);
}

console.log('');
if (failed) {
  console.log(`${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
