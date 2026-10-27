# -*- coding: utf-8 -*-
"""用 PIL / tifffile 独立校验工具导出的文件是否符合通用格式。
   先跑 node test/codec.test.cjs 生成夹具。
"""
import os
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")

fails = 0


def ok(name, cond, extra=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("  " + extra if extra else ""))
    if not cond:
        fails += 1


def path(n):
    return os.path.join(FIX, n)


if not os.path.isdir(FIX):
    sys.exit("缺少夹具目录，先运行 node test/codec.test.cjs")

# 16 位灰度 PNG
im = Image.open(path("out_gray16.png"))
a = np.array(im)
ok("PIL 打开 16 位灰度 PNG", im.size == (37, 23) and (a.dtype == np.uint16 or a.max() > 255),
   "mode=%s dtype=%s max=%d" % (im.mode, a.dtype, int(a.max())))

# 16 位 RGB PNG
ok("PIL 打开 16 位 RGB PNG", Image.open(path("out_rgb16.png")).size == (37, 23))

# 8 位 PNG
ok("PIL 打开 8 位 PNG", Image.open(path("out_gray8.png")).size == (37, 23))

# float32 TIFF：灰度用 PIL 可读，RGB 需 tifffile
im = Image.open(path("out_gray_f32.tif"))
arr = np.array(im)
ok("PIL 打开 float32 灰度 TIFF", im.mode == "F" and arr.dtype == np.float32, "mode=%s" % im.mode)
ok("float32 灰度 TIFF 数值在 0..1", 0.0 <= float(arr.min()) and float(arr.max()) <= 1.0,
   "min=%.3f max=%.3f" % (float(arr.min()), float(arr.max())))

try:
    import tifffile
    b = tifffile.imread(path("out_rgb_f32.tif"))
    ok("tifffile 打开 float32 RGB TIFF", b.shape == (23, 37, 3) and b.dtype == np.float32, str(b.shape))
except ImportError:
    print("  skip tifffile 未安装，跳过 RGB 浮点 TIFF 校验")

# PNG 文本块
p = path("textchunk.png")
if os.path.exists(p):
    im = Image.open(p)
    ok("PIL 读到 PNG tEXt 文本块", bool(getattr(im, "text", None)), str(dict(im.text))[:80])

print("")
print("格式独立校验全部通过" if fails == 0 else "失败 %d 项" % fails)
sys.exit(0 if fails == 0 else 1)
