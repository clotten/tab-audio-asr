/** WAV 读取工具：严格按 RIFF 规范遍历 chunk（真实 WAV 常带额外 chunk，硬编码 44 偏移会读错） */

export function toArrayBuffer(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export function parseWav(input) {
  const ab = toArrayBuffer(input);
  const view = new DataView(ab);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));

  if (ab.byteLength < 12) throw new Error('文件太小，不是 WAV');
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件');

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= ab.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, ab.byteLength - body) };
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new Error('找不到 fmt chunk');
  if (!data) throw new Error('找不到 data chunk');

  const blockAlign = fmt.blockAlign || fmt.channels * (fmt.bitsPerSample / 8);
  return {
    ...fmt,
    dataOffset: data.offset,
    dataSize: data.size,
    frames: Math.floor(data.size / blockAlign),
    durationSec: data.size / (fmt.sampleRate * blockAlign)
  };
}

/** 读成每声道独立的 Float32Array */
export function readChannels(input) {
  const ab = toArrayBuffer(input);
  const h = parseWav(ab);
  const view = new DataView(ab);
  const bytesPerSample = h.bitsPerSample / 8;

  const channels = [];
  for (let c = 0; c < h.channels; c++) {
    const data = new Float32Array(h.frames);
    for (let i = 0; i < h.frames; i++) {
      const offset = h.dataOffset + (i * h.channels + c) * bytesPerSample;
      data[i] =
        h.bitsPerSample === 16 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
    }
    channels.push(data);
  }
  return { header: h, channels };
}
