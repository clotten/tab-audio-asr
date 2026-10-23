/**
 * pcm-worklet.js —— 把标签页音频以"块"的形式实时送回主线程
 *
 * 放在 AudioWorklet 里跑，是为了拿到真正的 PCM：
 * MediaRecorder 只能给出 webm，而且必须等一段录完才能解码，
 * 这正是之前"要等 20 秒才出字"的根源。有了 PCM，切句和上传都可以边收边做。
 */

class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = options?.processorOptions?.blockSize || 2048;
    this.blockSize = size;
    this.buf = new Float32Array(size);
    this.n = 0;
    this.port.onmessage = event => {
      if (event.data !== 'flush') return;
      if (this.n) {
        const tail = this.buf.slice(0, this.n);
        this.port.postMessage(tail, [tail.buffer]);
        this.n = 0;
      }
      this.port.postMessage({ type: 'flushed' });
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;

    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      let sample = 0;
      for (const channel of input) sample += channel[i] || 0;
      this.buf[this.n++] = sample / input.length;
      if (this.n === this.blockSize) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(this.blockSize);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
