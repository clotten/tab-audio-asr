/**
 * ms-hook.js —— 在主世界（页面自己的 JS 环境）里镜像播放器喂给 MSE 的字节
 *
 * 为什么需要它：
 *   抖音这类站点的 <video> 永远是 blob:（MediaSource），音轨地址既不在 DOM 里、
 *   也不在任何可读的 JSON 里；而"观察网络请求"又分不清是哪条视频的——
 *   实测 95 秒的视频，观察到的 media-audio 是另一条 645 秒的；
 *   就算时长碰巧接近，内容也可能是别的视频（用户已经踩到）。
 *
 *   唯一确定"这就是当前这条视频"的东西，是播放器**实际 appendBuffer 进去的字节**。
 *
 * 做法：
 *   1. 包住 MediaSource.prototype.addSourceBuffer，拿到每个 SourceBuffer 的 mimeType；
 *   2. 包住 SourceBuffer.prototype.appendBuffer，把传进来的数据**复制一份**存起来
 *      （必须复制：播放器之后可能回收/transfer 那个 ArrayBuffer）；
 *   3. 暴露 window.__dshMsDump(keyword) 给扩展取用（按 mime 关键字筛，如 "audio"）。
 *
 * 注意：
 *   - 必须在 document_start 注入（MAIN world），否则页面先创建的 MediaSource 抓不到；
 *   - 只留音频轨（视频轨动辄几十上百 MB，没必要），总量有上限；
 *   - 数据是页面自己的，不发送、不上传，除非用户点「整段提取」。
 */

(function () {
  if (window.__dshMsHookInstalled) return;
  window.__dshMsHookInstalled = true;

  /** mimeType → { chunks: Uint8Array[], bytes } */
  const tracks = new Map();
  let totalBytes = 0;

  // 只镜像音频轨（audio/mp4、audio/webm…），视频轨不进内存
  const AUDIO_ONLY = true;
  const MAX_TOTAL = 24 * 1024 * 1024;
  const MAX_PER_TRACK = 24 * 1024 * 1024;

  function isAudioMime(mime) {
    return /audio\//i.test(String(mime || ''));
  }

  /** 把一个 ArrayBuffer/TypedArray 复制成 Uint8Array（不能持有原对象） */
  function copyOf(data) {
    try {
      if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
    } catch {
      /* SharedArrayBuffer 等取不到就算了 */
    }
    return null;
  }

  function record(mime, data) {
    if (!mime) return;
    if (AUDIO_ONLY && !isAudioMime(mime)) return;
    const bytes = copyOf(data);
    if (!bytes || !bytes.length) return;

    const track = tracks.get(mime) || { chunks: [], bytes: 0 };
    if (track.bytes + bytes.length > MAX_PER_TRACK) return;
    if (totalBytes + bytes.length > MAX_TOTAL) return;

    track.chunks.push(bytes);
    track.bytes += bytes.length;
    totalBytes += bytes.length;
    tracks.set(mime, track);
  }

  // ① 记录每个 SourceBuffer 的 mimeType
  const MS = window.MediaSource;
  if (MS && MS.prototype && typeof MS.prototype.addSourceBuffer === 'function') {
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.apply(this, arguments);
      try {
        if (sb && !sb.__dshMime) sb.__dshMime = String(mime || '');
      } catch {
        /* ignore */
      }
      return sb;
    };
  }

  // ② 镜像 appendBuffer 的字节
  const SB = window.SourceBuffer;
  if (SB && SB.prototype && typeof SB.prototype.appendBuffer === 'function') {
    const origAppend = SB.prototype.appendBuffer;
    SB.prototype.appendBuffer = function (data) {
      try {
        record(this && this.__dshMime, data);
      } catch {
        /* 镜像失败不影响播放 */
      }
      return origAppend.apply(this, arguments);
    };
  }

  /**
   * 给扩展取数据用。
   * @param {string} keyword mime 关键字，默认 "audio"
   * @param {number} offset  从第几字节开始（分片传输用）
   * @param {number} length  取多少字节
   */
  window.__dshMsDump = function (keyword, offset, length) {
    const key = String(keyword || 'audio').toLowerCase();
    let hit = null;
    for (const [mime, track] of tracks) {
      if (mime.toLowerCase().includes(key) && track.bytes > 0) {
        if (!hit || track.bytes > hit.track.bytes) hit = { mime, track };
      }
    }
    if (!hit) return { ok: false, reason: 'no-track', tracks: [...tracks.keys()] };

    const { mime, track } = hit;
    const off = Math.max(0, Number(offset) || 0);
    const len = Math.max(0, Number(length) || track.bytes);

    // 拼成一个连续数组再切（音频只有几 MB，代价可接受）
    const all = new Uint8Array(track.bytes);
    let p = 0;
    for (const c of track.chunks) {
      all.set(c, p);
      p += c.length;
    }
    const slice = all.subarray(off, Math.min(all.length, off + len));

    // 转 base64（扩展那边拿到字符串再还原成字节）
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < slice.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, slice.subarray(i, i + CHUNK));
    }
    return {
      ok: true,
      mime,
      total: track.bytes,
      offset: off,
      length: slice.length,
      base64: btoa(binary)
    };
  };

  /** 只报状态，不搬数据（弹窗判断"有没有镜像可用的音频"） */
  window.__dshMsStatus = function () {
    const list = [];
    for (const [mime, track] of tracks) list.push({ mime, bytes: track.bytes });
    return { ok: true, tracks: list };
  };
})();
