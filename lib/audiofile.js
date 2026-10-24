/**
 * audiofile.js —— 把录到的音频同时存成 WAV 文件
 *
 * 为什么用 OPFS（Origin Private File System）而不是攒在内存里：
 *   1 小时 16k 单声道是 115MB，全放内存容易把后台页面拖崩；
 *   OPFS 可以边录边写，内存占用恒定，也不需要用户授权选目录。
 *
 * 写入方式：先写 44 字节占位头 → 逐块追加 PCM → 结束时 seek(0) 回填真实长度。
 *
 * 注意：popup 和 offscreen 是同一个扩展源，共享同一份 OPFS，
 * 所以弹窗可以直接把文件读出来交给下载，不需要经过消息传几 MB 的数据。
 */

import { buildWavHeader, float32ToPcm16 } from './wav.js';

const DEFAULT_NAME = 'recording.wav';

export function audioFileSupported(storage) {
  try {
    const s = storage || globalThis.navigator?.storage;
    return !!s?.getDirectory;
  } catch {
    return false;
  }
}

async function rootDir(storage) {
  const s = storage || globalThis.navigator?.storage;
  if (!s?.getDirectory) throw new Error('当前浏览器不支持 OPFS，无法保存音频');
  return s.getDirectory();
}

/**
 * 打开一个 WAV 写入器。
 * @param {string} name 文件名
 * @param {number} sampleRate 采样率
 * @param {object} [storage] 可选：注入 storage（测试用），默认用 navigator.storage
 */
export async function createWavWriter(name, sampleRate, storage) {
  const dir = await rootDir(storage);
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();

  await writable.write(buildWavHeader(0, sampleRate));

  let bytes = 0;

  return {
    name,
    get bytes() {
      return bytes;
    },
    async write(block) {
      if (!block || !block.length) return;
      const pcm = float32ToPcm16(block);
      await writable.write(pcm);
      bytes += pcm.byteLength;
    },
    async close() {
      await writable.seek(0);
      await writable.write(buildWavHeader(bytes, sampleRate));
      await writable.close();
      return {
        name,
        bytes,
        durationMs: Math.round((bytes / 2 / sampleRate) * 1000)
      };
    }
  };
}

/** 读回录音文件（popup 用它做下载） */
export async function readAudioFile(name = DEFAULT_NAME, storage) {
  const dir = await rootDir(storage);
  const fh = await dir.getFileHandle(name);
  return fh.getFile();
}

export async function removeAudioFile(name = DEFAULT_NAME, storage) {
  try {
    const dir = await rootDir(storage);
    await dir.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

export { DEFAULT_NAME };
