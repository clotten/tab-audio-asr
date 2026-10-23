"""生成插件图标（16/32/48/128），深蓝渐变圆角方块 + 白色声波柱。"""

from PIL import os
import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
SIZE = 512          # 超采样后缩小，边缘更干净
PAD = 26
RADIUS = 108

# 渐变：上 #4B8EF7 → 下 #1D4ED8
TOP = (75, 142, 247)
BOTTOM = (29, 78, 216)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# 竖向渐变
grad = Image.new("RGB", (1, SIZE))
for y in range(SIZE):
    t = y / (SIZE - 1)
    grad.putpixel(
        (0, y),
        (
            round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
            round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
            round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
        ),
    )
grad = grad.resize((SIZE, SIZE))

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD], radius=RADIUS, fill=255
)
img.paste(grad, (0, 0), mask)

draw = ImageDraw.Draw(img)

# 声波柱：高度比例模仿音频波形
bars = [0.34, 0.62, 1.0, 0.72, 0.42]
bar_w = 42
gap = 26
total = len(bars) * bar_w + (len(bars) - 1) * gap
x = (SIZE - total) // 2
center = SIZE // 2
max_h = 250

for ratio in bars:
    h = int(max_h * ratio)
    draw.rounded_rectangle(
        [x, center - h // 2, x + bar_w, center + h // 2],
        radius=bar_w // 2,
        fill=(255, 255, 255, 242),
    )
    x += bar_w + gap

for s in (16, 32, 48, 128):
    img.resize((s, s), Image.LANCZOS).save(f"{OUT}\\icon{s}.png")
    print("wrote", f"icon{s}.png")

img.resize((128, 128), Image.LANCZOS).save(f"{OUT}\\preview.png")
print("done")
