/**
 * lib/platforms/bilibili.js —— B 站适配器
 *
 * 一个平台适配器只声明"这个平台长什么样、怎么从它的响应里认出音轨"，
 * 不碰消息流、不碰解码、不碰 UI。新增平台 = 加一个这样的文件 + 在 registry 里注册。
 */

export default {
  id: 'bilibili',
  name: 'B 站',

  /** 页面地址（用来判断"当前这个网页属于哪个平台"） */
  pagePattern: /(^|\.)bilibili\.com$/i,

  /** 媒体地址里会出现的域名（用来判断"这个下载链接属于哪个平台"） */
  mediaHosts: ['bilivideo.com', 'hdslb.com', 'biliapi.net'],

  /**
   * 这个平台的 CDN 需要什么请求头。
   * 浏览器不允许 fetch 手写 Referer，只能靠 declarativeNetRequest 在发请求前塞进去。
   */
  cdn: {
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    /** DNR 会话规则 id 的起始值，每个平台占 10 个位置 */
    ruleBase: 9001
  },

  /**
   * 这个平台能不能在页面里用登录态现查音轨（内容脚本收到这个消息就去调播放接口）。
   * 没有这个能力的平台就不写这一项。
   */
  pageResolver: 'BILI_AUDIO',

  /** 注入到主世界的钩子要监听哪些请求（正则源码，钩子那边自己 new RegExp） */
  hookPattern: 'playurl|playinfo|player\\/wbi|mediainfo|\\/x\\/player\\/',

  /** 从响应里捞 URL 时，怎么区分音轨/视频轨（B 站按 m4s 的 id 段区分） */
  markers: {
    audio: ['-30280', '-30216', '-30232', 'audio'],
    video: ['-100026', '-30080', '-30077', 'video']
  },

  /**
   * 从候选 URL 里挑最合适的音轨。
   * B 站实测：-30280 约 200kbps，-30216 约 67kbps，优先高码率。
   */
  pickAudio(urls) {
    const list = (urls || []).filter(Boolean);
    const score = (u) => {
      if (/-30280/.test(u)) return 100;
      if (/-30232/.test(u)) return 80;
      if (/-30216/.test(u)) return 60;
      if (/mime_type=audio|audio/i.test(u)) return 40;
      return 0;
    };
    const best = list.slice().sort((a, b) => score(b) - score(a))[0];
    return best && score(best) > 0 ? best : '';
  }
};
