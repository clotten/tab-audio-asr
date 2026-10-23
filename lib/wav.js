/**
 * wav.js —— 极简 PCM 处理工具（无依赖，浏览器 / Node 通用）
 *
 * 为什么要把音频转成 16kHz 单声道 16bit WAV：
 *  1. 语音识别模型的输入几乎都是 16k 单声道，采样率过高只是浪费上传体积；
 *  2. WAV 是最"笨"的容器，任何 ASR 接口都认，不存在 webm/opus 兼容性问题；
 *  3. 16k/16bit/单声道 = 32 KB/s，1 分钟只有 1.9 MB，远低于接口 50MB 上限。
 */

export const TARGET_SAMPLE_RATE = 16000;

/** 把多声道 AudioBuffer 混成单声道 Float32Array */
export function mixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  if (channels === 1) return audioBuffer.getChannelData(0).slice(0);

  const out = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  for (let i = 0; i < length; i++) out[i] /= channels;
  return out;
}

/**
 * 盒式滤波重采样（降采样时对分组取平均 = 天然低通），语音场景足够。
 * 48k -> 16k 就是每 3 个点求均值，等价于一个简单抗混叠低通。
 */
export function resampleBox(input, inRate, outRate = TARGET_SAMPLE_RATE) {
  if (!inRate || inRate === outRate) return input;

  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 只生成 44 字节的 WAV 头（流式写入磁盘时用：先占位，最后回填长度） */
export function buildWavHeader(dataBytes, sampleRate = TARGET_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}

/** Float32 [-1,1] -> 16bit PCM 的字节（流式写文件用） */
export function float32ToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

/** Float32 [-1,1] -> 16bit PCM WAV 的 ArrayBuffer（标准 44 字节头） */
export function encodeWav(float32, sampleRate = TARGET_SAMPLE_RATE) {
  const pcm = float32ToPcm16(float32);
  const header = buildWavHeader(pcm.byteLength, sampleRate);

  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out.buffer;
}

/** AudioBuffer -> 16k 单声道 WAV Blob */
export function audioBufferToWavBlob(audioBuffer) {
  const mono = mixToMono(audioBuffer);
  const resampled = resampleBox(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
  return new Blob([encodeWav(resampled, TARGET_SAMPLE_RATE)], { type: 'audio/wav' });
}

/**
 * 生成一段测试音（带 50ms 淡入淡出防爆音）。
 * 用途：popup 里的"自测接口"按钮，用它验证 key / 模型名 / 网络是否通。
 * 纯音调识别不出文字是正常的，只要 HTTP 200 就说明链路没问题。
 */
export function makeToneWav({ seconds = 1.5, freq = 440, sampleRate = TARGET_SAMPLE_RATE } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const data = new Float32Array(n);
  const fade = Math.min(0.05, seconds / 4);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / fade, (seconds - t) / fade);
    data[i] = 0.3 * Math.sin(2 * Math.PI * freq * t) * Math.max(0, env);
  }
  return encodeWav(data, sampleRate);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
