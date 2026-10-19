/**
 * vad.js —— 基于能量的语音端点检测（VAD），把一段音频切成"句子级"的区域
 *
 * 为什么需要它：
 *   字幕要按时间轴走，就必须知道"这句话在音频里的第几秒到第几秒"。
 *   语音识别接口不返回时间戳，所以只能自己切：在每个静音处断开，
 *   每段单独上传，就天然获得了每句的起止时间。
 *
 * 副作用（都是好的）：首句很短 → 第一段文字出得更快；单片更小 → 失败重试代价更低。
 *
 * 门限策略：不做"语音/音乐"分类，只找"安静的地方"。
 *   thr = max(峰值 * 8%, 绝对下限 0.003)
 * 这样即使整段都有背景音乐（B 站视频很常见），也不会一句都切不出来，
 * 最后还有 maxRegionMs 兜底强行在能量最低处切。
 */

export const VAD_DEFAULTS = {
  frameMs: 20,          // 分析帧长
  minGapMs: 600,        // 短于这个的静音间隙不算句间停顿（气口/咬字）
  dropRegionMs: 300,    // 短于这个的有声段当噪声丢掉（咔哒声）
  targetMinMs: 2500,    // 合并目标：每句至少这么长，否则跟邻居并起来
  maxJoinGapMs: 1500,   // 合并时允许跨越的最大间隙（课堂里 1 秒的停顿要能跨过去）
  maxRegionMs: 10000,   // 超过就在能量最低处强行切开
  padMs: 140,           // 每段前后留一点，避免把字的头尾削掉
  thresholdRatio: 0.08, // 门限 = 峰值 * 该比例
  absFloor: 0.003
};

/* ==================================================================== */
/* 流式切句：边收音频边切，说完一句立刻吐出来，不用等整块录完            */
/* ==================================================================== */

export const STREAM_DEFAULTS = {
  frameMs: 20,
  preRollMs: 200,       // 语音起点前多留一点，别削掉字头
  padMs: 150,           // 切点后再带一点
  silenceGapMs: 600,    // 停顿这么久就认为一句说完了
  targetMinMs: 2000,    // 至少说这么久才算一句，更短的等下一句合并
                        // （实测：800ms 时 30% 的段是 2 秒内碎片；2000ms 时碎片为 0，平均 3.7s）
  graceSilenceMs: 1200, // 短句后面静音这么久还没人接话，就别等了，硬切
  // 渐进式静音（借鉴 LiveTranslate）：缓冲越长，接受的停顿越短。
  // 语义是"从这么长的缓冲开始，用这个倍数"——所以 3–6 秒还是 1.0（保守），
  // 6–10 秒才降到 0.5。注意：默认 softCut 5 秒会先一步切掉，
  // 所以这套要真正生效，需要把 softCut 调到 6 秒以上。
  progressiveTiers: [
    [3000, 1.0], // 缓冲 ≥ 3 秒：完整阈值
    [6000, 0.5], // ≥ 6 秒：一半
    [10000, 0.3] // ≥ 10 秒：三成
  ],
  progressiveFloorMs: 300, // 再怎么降也不低于这个值
  softCutMs: 5000,      // 连续讲话：到这个长度就在能量最低处切开
  hardCutMs: 10000,     // 硬上限
  thresholdRatio: 0.08,
  absFloor: 0.003,
  peakDecay: 0.9995     // 峰值缓降，让门限能适应音量变化
};

/**
 * 流式切句器。
 *
 * 用法：
 *   const seg = createStreamingSegmenter(16000);
 *   for (;;) { const out = seg.push(float32Block); out.forEach(emit); }
 *   // 停止时 const rest = seg.flush();
 *
 * push() 返回"这一次刚好凑够一句"的段落数组（通常 0 或 1 个），
 * 每个段落自带 samples 与相对录音起点的 startMs / durationMs。
 */
export function createStreamingSegmenter(sampleRate, options = {}) {
  const opt = { ...STREAM_DEFAULTS, ...options };
  const rate = sampleRate || 16000;
  const frameLen = Math.max(1, Math.round((rate * opt.frameMs) / 1000));
  const silenceCut = Math.round((opt.silenceGapMs / 1000) * rate);
  const preRoll = Math.round((opt.preRollMs / 1000) * rate);
  const pad = Math.round((opt.padMs / 1000) * rate);
  const targetMin = Math.round((opt.targetMinMs / 1000) * rate);
  const graceSilence = Math.round((opt.graceSilenceMs / 1000) * rate);
  const softCut = Math.round((opt.softCutMs / 1000) * rate);
  const hardCut = Math.round((opt.hardCutMs / 1000) * rate);

  /** 保留最近的音频，chunks[0][0] 对应绝对下标 bufStart */
  let chunks = [];
  let bufStart = 0;
  let total = 0;          // 收到的总样本数（绝对下标上限）
  let remnant = new Float32Array(0); // 不足一帧的尾巴
  let remnantStart = 0;

  let peak = 0;
  let voiceStart = -1;    // 绝对下标（含 preRoll）
  let lastVoiceEnd = -1;
  let silenceRun = 0;
  /** 最近约 2 秒的帧能量，用来找"最低点"切开 */
  let recent = [];        // { endAbs, rms }

  function append(block) {
    if (!block || !block.length) return;
    chunks.push(block);
    total += block.length;
  }

  function sliceAbs(from, to) {
    const start = Math.max(from, bufStart);
    const end = Math.min(to, total);
    if (end <= start) return new Float32Array(0);
    const out = new Float32Array(end - start);
    let abs = bufStart;
    let w = 0;
    for (const c of chunks) {
      const cEnd = abs + c.length;
      if (cEnd <= start) {
        abs = cEnd;
        continue;
      }
      if (abs >= end) break;
      const s = Math.max(0, start - abs);
      const e = Math.min(c.length, end - abs);
      out.set(c.subarray(s, e), w);
      w += e - s;
      abs = cEnd;
    }
    return out;
  }

  /** 丢掉已经吐出去的音频，只留 pad + preRoll 的余量 */
  function trim(keepFrom) {
    while (chunks.length) {
      const c = chunks[0];
      if (bufStart + c.length <= keepFrom) {
        bufStart += c.length;
        chunks.shift();
      } else break;
    }
  }

  function emit(startAbs, endAbs, reason) {
    const samples = sliceAbs(startAbs, endAbs);
    if (!samples.length) return null;
    const seg = {
      samples,
      startMs: Math.round((startAbs / rate) * 1000),
      durationMs: Math.round((samples.length / rate) * 1000),
      reason
    };
    trim(endAbs);
    voiceStart = -1;
    lastVoiceEnd = -1;
    silenceRun = 0;
    recent = [];
    return seg;
  }

  /**
   * 在 [fromAbs, toAbs] 里找切点：取能量最低的帧，但允许 5% 容差，
   * 容差内取最靠后的那个。这样连续平稳的讲话会尽量切在后面
   * （段落更长、上下文更多），真有明显低谷时才切在低谷。
   */
  function lowestPoint(fromAbs, toAbs) {
    let minRms = Infinity;
    for (const f of recent) {
      if (f.endAbs < fromAbs || f.endAbs > toAbs) continue;
      if (f.rms < minRms) minRms = f.rms;
    }
    if (!Number.isFinite(minRms)) return -1;

    let best = -1;
    for (const f of recent) {
      if (f.endAbs < fromAbs || f.endAbs > toAbs) continue;
      if (f.rms <= minRms * 1.05 && f.endAbs > best) best = f.endAbs;
    }
    return best;
  }

  /**
   * 渐进式静音阈值：缓冲越长，接受的停顿越短。
   * 例：say 已经攒了 7 秒 → 用 30% 的阈值（600ms → 300ms 的下限），
   * 这样连续讲话也能 3 秒左右出一句，而不是憋到软上限。
   */
  function effectiveSilenceCut(spokenSamples) {
    const spokenMs = (spokenSamples / rate) * 1000;
    let mult = 1;
    for (const [tierMs, tierMult] of opt.progressiveTiers || []) {
      if (spokenMs < tierMs) break;
      mult = tierMult;
    }
    const floorSamples = Math.round(((opt.progressiveFloorMs || 300) / 1000) * rate);
    return Math.max(floorSamples, Math.round(silenceCut * mult));
  }

  function processFrame(startAbs, rms, endAbs) {
    // 峰值缓降：门限能跟着音量漂移，又不至于被一声巨响长期拉高
    peak = Math.max(peak * opt.peakDecay, rms);
    const thr = Math.max(peak * opt.thresholdRatio, opt.absFloor);
    const voiced = rms > thr;

    recent.push({ endAbs, rms });
    if (recent.length > Math.round((hardCut / rate) * 1000 / opt.frameMs) + 50) recent.shift();

    if (voiced) {
      if (voiceStart < 0) voiceStart = Math.max(bufStart, startAbs - preRoll);
      lastVoiceEnd = endAbs;
      silenceRun = 0;
    } else if (voiceStart >= 0) {
      silenceRun += frameLen;
    }

    if (voiceStart < 0) return null;

    const spoken = lastVoiceEnd - voiceStart;

    // ① 停顿够久 → 一句说完了，立刻切（这是"实时"的主要来源）
    //    缓冲越长，接受的停顿越短（渐进式）：连续讲话时能更早出字，
    //    而短缓冲仍用原始阈值，不会把句子切碎。
    if (silenceRun >= effectiveSilenceCut(spoken)) {
      if (spoken >= targetMin) return emit(voiceStart, lastVoiceEnd + pad, 'silence');
      // 短句后面长期没人接话，就别死等合并了
      if (silenceRun >= graceSilence) return emit(voiceStart, lastVoiceEnd + pad, 'grace');
    }

    // ② 连续讲话到软上限 → 在能量最低处切，别硬等停顿
    if (spoken >= softCut) {
      const from = voiceStart + targetMin;
      const to = lastVoiceEnd - Math.round(rate * 0.35);
      const cut = to > from ? lowestPoint(from, to) : -1;
      if (cut > from) return emit(voiceStart, cut, 'soft');
      return emit(voiceStart, Math.min(lastVoiceEnd, voiceStart + softCut), 'soft-fallback');
    }

    // ③ 硬上限兜底
    if (spoken >= hardCut) {
      const cut = lowestPoint(voiceStart + targetMin, lastVoiceEnd - Math.round(rate * 0.5));
      return emit(voiceStart, cut > 0 ? cut : lastVoiceEnd, 'hard');
    }

    return null;
  }

  return {
    /** 推入一块音频，返回这次切出的段落（0 或 1 个，偶尔 2 个） */
    push(block) {
      const out = [];
      if (!block || !block.length) return out;

      // 拼上上次不足一帧的尾巴
      let merged;
      if (remnant.length) {
        merged = new Float32Array(remnant.length + block.length);
        merged.set(remnant, 0);
        merged.set(block, remnant.length);
      } else {
        merged = block;
      }

      append(merged);
      const baseAbs = remnantStart;

      let offset = 0;
      while (offset + frameLen <= merged.length) {
        const startAbs = baseAbs + offset;
        const frame = merged.subarray(offset, offset + frameLen);
        let sum = 0;
        for (let i = 0; i < frameLen; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frameLen);
        const seg = processFrame(startAbs, rms, startAbs + frameLen);
        if (seg) out.push(seg);
        offset += frameLen;
      }

      const rest = merged.subarray(offset);
      remnant = rest.length ? new Float32Array(rest) : new Float32Array(0);
      remnantStart = baseAbs + offset;
      return out;
    },

    /**
     * 看一眼"当前还没说完的这一句"（不消费、不影响切句状态）。
     * 增量识别用它：语音还在继续时，先拿这段做个临时预览。
     */
    peek() {
      if (voiceStart < 0 || lastVoiceEnd <= voiceStart) return null;
      const startAbs = Math.max(voiceStart, bufStart);
      const endAbs = Math.min(total, lastVoiceEnd + pad);
      if (endAbs - startAbs < Math.round(rate * 0.3)) return null;
      return {
        samples: sliceAbs(startAbs, endAbs),
        startMs: Math.round((startAbs / rate) * 1000),
        durationMs: Math.round(((endAbs - startAbs) / rate) * 1000)
      };
    },

    /**
     * 从缓冲头部丢掉 n 个采样（增量提交后调用，对应 LiveTranslate 的 trim_front）。
     * 已提交的音频不必再识别，剪掉既省算力也避免回声重复。
     */
    trimFront(samples) {
      let want = Math.floor(Number(samples) || 0);
      if (want <= 0 || !chunks.length) return 0;

      let removed = 0;
      let drop = 0;
      while (drop < chunks.length && removed + chunks[drop].length <= want) {
        removed += chunks[drop].length;
        drop += 1;
      }
      if (drop) chunks = chunks.slice(drop);

      if (removed < want && chunks.length) {
        const part = want - removed;
        chunks[0] = chunks[0].subarray(part);
        removed += part;
      }

      bufStart += removed;
      // 语音起点被剪掉时跟着前移，别让 voiceStart 落在缓冲之外
      if (voiceStart >= 0 && voiceStart < bufStart) voiceStart = bufStart;
      if (lastVoiceEnd >= 0 && lastVoiceEnd < bufStart) {
        lastVoiceEnd = -1;
        voiceStart = -1;
        silenceRun = 0;
      }
      return removed;
    },

    /** 停止时把剩下的话收尾 */
    flush() {
      const out = [];
      if (voiceStart >= 0 && lastVoiceEnd > voiceStart) {
        const seg = emit(voiceStart, Math.min(lastVoiceEnd + pad, total), 'flush');
        if (seg) out.push(seg);
      }
      chunks = [];
      bufStart = total;
      voiceStart = -1;
      lastVoiceEnd = -1;
      silenceRun = 0;
      recent = [];
      remnant = new Float32Array(0);
      return out;
    },

    stats() {
      return { totalSamples: total, voiceStart, lastVoiceEnd, peak };
    }
  };
}

/**
 * @param {Float32Array} samples 单声道采样，建议 16k
 * @param {number} sampleRate
 * @param {object} [options]
 * @returns {{startSample:number,endSample:number,startMs:number,endMs:number,durationMs:number}[]}
 */
export function detectSpeechRegions(samples, sampleRate, options = {}) {
  const opt = { ...VAD_DEFAULTS, ...options };
  const total = samples?.length || 0;
  if (!total || !sampleRate) return [];

  const frameLen = Math.max(1, Math.round((sampleRate * opt.frameMs) / 1000));
  const frames = Math.floor(total / frameLen);
  if (frames < 3) return [];

  // 1) 每帧能量（RMS）
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * frameLen;
    let sum = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[off + i];
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / frameLen);
  }

  // 2) 3 帧滑窗平滑，避免单帧抖动把一句话切碎
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let count = 0;
    for (let k = -1; k <= 1; k++) {
      const j = f + k;
      if (j >= 0 && j < frames) {
        sum += rms[j];
        count++;
      }
    }
    smooth[f] = sum / count;
  }

  // 3) 门限
  let peak = 0;
  for (let f = 0; f < frames; f++) if (smooth[f] > peak) peak = smooth[f];
  if (peak <= 1e-5) return []; // 数字静音，一句都没有

  const threshold = Math.max(peak * opt.thresholdRatio, opt.absFloor);

  const voiced = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) voiced[f] = smooth[f] > threshold ? 1 : 0;

  const minGapFrames = Math.max(1, Math.round(opt.minGapMs / opt.frameMs));
  const dropRegionFrames = Math.max(1, Math.round(opt.dropRegionMs / opt.frameMs));
  const maxRegionFrames = Math.max(dropRegionFrames + 1, Math.round(opt.maxRegionMs / opt.frameMs));
  const targetMinFrames = Math.max(0, Math.round(opt.targetMinMs / opt.frameMs));
  const maxJoinGapFrames = Math.max(0, Math.round(opt.maxJoinGapMs / opt.frameMs));
  const padFrames = Math.max(0, Math.round(opt.padMs / opt.frameMs));

  // 4) 取出连续有声段
  let runs = collectRuns(voiced);
  if (!runs.length) return [];

  // 5) 合并过短的间隙（气口），丢掉过短的段（咔哒声）
  runs = mergeRuns(runs, minGapFrames);
  runs = runs.filter((r) => r.end - r.start + 1 >= dropRegionFrames);
  if (!runs.length) return [];

  // 6) 前后加余量，并处理重叠
  const padded = [];
  let lastEnd = 0;
  for (const run of runs) {
    const start = Math.max(lastEnd, run.start - padFrames);
    const end = Math.min(frames, run.end + padFrames + 1);
    if (end - start < 1) continue;
    padded.push({ start, end });
    lastEnd = end;
  }

  // 7) 把过短的句子并起来。
  //    这一步是识别质量的关键：1～2 秒的碎片会让模型失去上下文，
  //    实测 "RTS帧" 被识别成 "RTS针"、"CTS帧" 变成 "CT、X光"。
  const packed = packRegions(padded, targetMinFrames, maxJoinGapFrames, maxRegionFrames);

  // 8) 仍然太长的，在能量最低处强行切（连续讲话 / 全程有背景音乐时靠这个兜底）
  const split = [];
  for (const region of packed) {
    splitLong(region, smooth, maxRegionFrames, dropRegionFrames, split);
  }

  // 9) 换算回采样点
  const out = [];
  for (const region of split) {
    const startSample = region.start * frameLen;
    const endSample = Math.min(total, region.end * frameLen);
    if (endSample - startSample < frameLen) continue;
    out.push({
      startSample,
      endSample,
      startMs: Math.round((startSample / sampleRate) * 1000),
      endMs: Math.round((endSample / sampleRate) * 1000),
      durationMs: Math.round(((endSample - startSample) / sampleRate) * 1000)
    });
  }
  return out;
}

/** 把 0/1 数组里连续的 1 收成 [{start,end}]（end 含） */
function collectRuns(voiced) {
  const runs = [];
  let start = -1;
  for (let f = 0; f < voiced.length; f++) {
    if (voiced[f]) {
      if (start < 0) start = f;
    } else if (start >= 0) {
      runs.push({ start, end: f - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: voiced.length - 1 });
  return runs;
}

/** 间隙小于 minGap 的两个段合并 */
function mergeRuns(runs, minGap) {
  if (runs.length < 2) return runs;
  const out = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const prev = out[out.length - 1];
    const cur = runs[i];
    if (cur.start - prev.end - 1 < minGap) {
      prev.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * 贪心合并：把过短的段并给后一段，直到达到 targetMinFrames；
 * 只允许跨越 <= maxJoinGapFrames 的间隙，合并后不超过 maxFrames。
 * 目的是给识别模型足够的上下文，避免 1～2 秒碎片导致的错字。
 */
function packRegions(regions, targetMinFrames, maxJoinGapFrames, maxFrames) {
  if (regions.length < 2 || targetMinFrames <= 0) return regions;

  const out = [];
  let cur = { ...regions[0] };

  for (let i = 1; i < regions.length; i++) {
    const next = regions[i];
    const curLen = cur.end - cur.start;
    const gap = next.start - cur.end;
    const mergedLen = next.end - cur.start;

    if (curLen < targetMinFrames && gap <= maxJoinGapFrames && mergedLen <= maxFrames) {
      cur.end = next.end;
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);

  // 注意：不做"末尾回头合并"。那会导致连锁吞并——
  // 3 句各 1 秒、间隔 1.5 秒的输入会被并成一整块 6 秒，字幕粒度就没了。

  return out;
}

/** 超长段在中间窗口里找能量最低的一帧切开，递归处理后半段 */
function splitLong(region, smooth, maxFrames, minFrames, out) {
  const len = region.end - region.start;
  if (len <= maxFrames) {
    out.push(region);
    return;
  }

  const from = region.start + Math.floor(maxFrames * 0.35);
  const to = Math.min(region.end - 1, region.start + Math.floor(maxFrames * 0.9));

  let cut = Math.floor((region.start + region.end) / 2);
  let best = Infinity;
  for (let f = from; f <= to; f++) {
    if (smooth[f] < best) {
      best = smooth[f];
      cut = f;
    }
  }

  // 切点离两端太近就退回中点，避免产出碎片
  if (cut - region.start < minFrames) cut = region.start + Math.floor(len / 2);
  if (region.end - cut < minFrames) {
    out.push(region);
    return;
  }

  out.push({ start: region.start, end: cut });
  splitLong({ start: cut, end: region.end }, smooth, maxFrames, minFrames, out);
}
