/**
 * lib/platforms/douyin.js —— 抖音适配器
 *
 * 抖音的坑（2026-11 实测）：
 *   1. 页面上的 `<video>` 是 blob:（MSE），拿不到直链；
 *   2. yt-dlp 直接解析会 403（需要 cookie/a_bogus 签名）；
 *   3. 播放器把音视频**分成两条 DASH 轨**请求：
 *        …/media-video-avc1/…   （视频）
 *        …/media-audio-und-mp4a/…（音频，193kbps）
 *   4. 这两条 URL 带签名、有时效，而且**必须带 Referer: https://www.douyin.com/** 才不 403。
 *
 * 所以适配器要做两件事：认出 `media-audio` 这条轨，以及要求 CDN 规则补 Referer。
 */

export default {
  id: 'douyin',
  name: '抖音',

  pagePattern: /(^|\.)douyin\.com$/i,

  mediaHosts: ['douyinvod.com', 'douyinpic.com', 'douyinstatic.com', 'amemv.com', 'bytecdn.cn'],

  cdn: {
    referer: 'https://www.douyin.com/',
    origin: 'https://www.douyin.com',
    ruleBase: 9011
  },

  /**
   * 抖音的媒体请求 URL 里直接写了轨类型（media-audio-und-mp4a / media-video-avc1），
   * 但"取到这些 URL"要靠监听 aweme 的 JSON 接口。
   */
  hookPattern: 'aweme\\/v1\\/web|aweme\\/detail|\\/aweme\\/|play_addr|media-audio',

  markers: {
    audio: ['media-audio', 'play_addr', 'audio'],
    video: ['media-video', 'video']
  },

  /**
   * 挑音轨：
   *   1. 首选 `media-audio-und-mp4a`（纯音频轨，体积只有视频的 1/10）；
   *   2. 退而求其次用 `play_addr` 那条（抖音常给"混合轨"，里面也有音轨，
   *      下载后交给 ffmpeg/解码器取音频即可）。
   */
  pickAudio(urls) {
    const list = (urls || []).filter(Boolean);
    const pure = list.find((u) => /media-audio/i.test(u));
    if (pure) return pure;
    const muxed = list.find((u) => /mime_type=video_mp4|play_addr|\/video\/tos\//i.test(u));
    return muxed || '';
  }
};
