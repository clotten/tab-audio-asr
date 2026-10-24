"""用 Silero VAD 跑一遍真实录音，看它能不能分出片头音乐和人声。

输出每秒的语音概率，重点看 4–24 秒（实测 RMS 恒定的音乐段）和 26 秒之后（老师讲话）。
"""

import sys
import wave
import numpy as np
import onnxruntime as ort

# 用法：python tools/silero-probe.py <某个.wav> [模型.onnx]
# 不给参数时用仓库自带的模型，音频必须自己指定（不写死本机路径）
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
WAV = sys.argv[1] if len(sys.argv) > 1 else ""
MODEL = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "vendor", "silero_vad_v5.onnx")

sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
print("模型输入：")
for i in sess.get_inputs():
    print(f"  {i.name:8} shape={i.shape} type={i.type}")
print("模型输出：")
for o in sess.get_outputs():
    print(f"  {o.name:8} shape={o.shape} type={o.type}")

with wave.open(WAV, "rb") as w:
    sr = w.getframerate()
    ch = w.getnchannels()
    n = w.getnframes()
    raw = w.readframes(n)

audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
if ch > 1:
    audio = audio.reshape(-1, ch).mean(axis=1)
print(f"\n音频：{sr}Hz 单声道 {len(audio)/sr:.1f}s")

FRAME = 512  # v5 在 16k 下的窗口
state = np.zeros((2, 1, 128), dtype=np.float32)
sr_tensor = np.array(sr, dtype=np.int64)

probs = []
for start in range(0, len(audio) - FRAME + 1, FRAME):
    chunk = audio[start : start + FRAME].reshape(1, FRAME).astype(np.float32)
    out, state = sess.run(None, {"input": chunk, "state": state, "sr": sr_tensor})
    probs.append(float(out[0][0]))

# 每 0.5 秒汇总一次
per_sec = FRAME / sr
print(f"\n共 {len(probs)} 帧（每帧 {per_sec*1000:.0f}ms）\n")

def summary(t0, t1, label):
    a = int(t0 / per_sec)
    b = int(t1 / per_sec)
    seg = np.array(probs[a:b])
    if len(seg) == 0:
        return
    frac = float((seg > 0.5).mean())
    print(f"{label:<22} {t0:5.1f}-{t1:5.1f}s  均值 {seg.mean():.3f}  最大 {seg.max():.3f}  >0.5 占比 {frac*100:5.1f}%")

print("=== 分段统计 ===")
summary(0, 4, "片头静音")
summary(4, 24, "片头音乐（关键）")
summary(24, 26, "音乐结束静音")
summary(26, 60, "老师开场白")
summary(60, 300, "讲课中段")
summary(300, 534, "讲课后段")

print("\n=== 前 40 秒逐 0.5 秒概率 ===")
line = ""
for i, p in enumerate(probs[:80]):
    line += f"{p:4.2f} "
    if (i + 1) % 10 == 0:
        print(f"  {(i+1)*per_sec:5.1f}s  {line}")
        line = ""
