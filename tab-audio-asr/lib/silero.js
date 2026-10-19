/**
 * silero.js —— Silero VAD（语音活动检测）的前端封装
 *
 * 为什么需要它：
 *   能量 VAD 只判断"有没有声音"，片头音乐、掌声、BGM 都会被当成语音送去识别，
 *   模型面对"听不清但要输出点什么"的输入就会编句子（实测出现过
 *   "I'm a little bit of a dreamer."）。Silero 是真正的语音/非语音分类器，
 *   在你这段真实录音上实测：片头音乐段均值概率 0.003（最大 0.039），
 *   老师讲话段均值 0.53–0.63 —— 界限非常干净。
 *
 * 设计要点：
 *   1. 模型是 512 采样（32ms @16k）一帧的 RNN，必须**逐帧顺序**喂，state 要回传；
 *   2. 推理是异步的，所以用一条 Promise 链串起来，并把每帧概率按帧序号存下来；
 *   3. 切句仍然是原来的能量 VAD，Silero 只做**事后判定**：
 *      一段的平均语音概率低于阈值就丢掉。这样不动时间轴，风险最低。
 *   4. ort 由外部注入，方便用假实现做离线测试。
 */

export const SILERO_FRAME_SIZE = 512; // 16kHz 下的固定窗口

/**
 * @param {{ort: any, modelBuffer: ArrayBuffer, sampleRate?: number}} opts
 */
export async function createSileroVad({ ort, modelBuffer, sampleRate = 16000 }) {
  if (!ort?.InferenceSession) throw new Error('onnxruntime 未加载');
  if (!modelBuffer || !modelBuffer.byteLength) throw new Error('模型文件为空');

  const session = await ort.InferenceSession.create(modelBuffer);

  const zeroState = () =>
    new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);

  let state = zeroState();
  const srTensor =
    typeof BigInt64Array !== 'undefined'
      ? new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), [])
      : new ort.Tensor('int64', Int32Array.from([sampleRate]), []);

  return {
    frameSize: SILERO_FRAME_SIZE,
    sampleRate,
    reset() {
      state = zeroState();
    },
    /** 喂一帧（必须正好 512 个采样），返回 0–1 的语音概率 */
    async push(frame) {
      const input = new ort.Tensor('float32', frame, [1, SILERO_FRAME_SIZE]);
      const out = await session.run({ input, state, sr: srTensor });
      state = out.stateN;
      const data = out.output?.data;
      return data && data.length ? Number(data[0]) : 0;
    }
  };
}

/**
 * 把连续的 PCM 拆成帧喂给 Silero，并记录每帧概率，
 * 便于事后按"某段的起止时间"求平均概率。
 */
export function createSileroGate({ vad, sampleRate = 16000 }) {
  const frameSize = vad.frameSize;
  const frameMs = (frameSize / sampleRate) * 1000;

  let pending = new Float32Array(0);
  let frameIndex = 0;
  const probs = []; // [{ i, p }]
  let chain = Promise.resolve();
  let failures = 0;

  function push(samples) {
    if (!samples || !samples.length) return;
    const merged = new Float32Array(pending.length + samples.length);
    merged.set(pending, 0);
    merged.set(samples, pending.length);

    let offset = 0;
    while (offset + frameSize <= merged.length) {
      const frame = merged.slice(offset, offset + frameSize);
      const idx = frameIndex++;
      chain = chain
        .then(() => vad.push(frame))
        .then((p) => {
          if (Number.isFinite(p)) probs.push({ i: idx, p });
        })
        .catch(() => {
          failures += 1;
        });
      offset += frameSize;
    }

    pending = merged.slice(offset);
  }

  /**
   * 求 [startMs, endMs) 区间的平均语音概率。
   * 会先等推理队列跑完；超时或没有数据时返回 null（调用方按"未知"处理）。
   */
  async function meanProb(startMs, endMs, timeoutMs = 3000) {
    await Promise.race([chain, new Promise((r) => setTimeout(r, timeoutMs))]);

    const a = Math.floor(startMs / frameMs);
    const b = Math.ceil(endMs / frameMs);
    let sum = 0;
    let n = 0;
    for (const { i, p } of probs) {
      if (i < a || i >= b) continue;
      sum += p;
      n += 1;
    }
    return n ? sum / n : null;
  }

  return {
    push,
    meanProb,
    stats: () => ({ frames: frameIndex, stored: probs.length, failures })
  };
}
