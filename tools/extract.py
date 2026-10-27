#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
频域掩码提取器（独立实现，供玩家端 / 命令行使用）

    python tools/extract.py 原图.png 修改图.png -o 结果.png

原理：D = |F(修改图) - F(原图)|，只在指定频带内做阈值二值化，恢复频域图案。
内置 16 位 PNG 解码（不依赖 PIL 的 16 位支持），TIFF 走 tifffile。

与本项目 index.html 的「解码 / 玩家端」等价，可互相验证。
"""
import argparse
import json
import os
import struct
import sys
import zlib

import numpy as np
from PIL import Image

try:
    import tifffile
except Exception:
    tifffile = None


# --------------------------------------------------------------- 读图

def read_png_array(path):
    """纯 Python 解 16/8 位 PNG，返回 0..1 的单通道或 RGB 浮点数组。"""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")
    pos = 8
    idat = []
    w = h = bd = ct = 0
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct, comp, filt, inter = struct.unpack(">IIBBBBB", chunk)
            if inter:
                raise ValueError("不支持隔行 PNG")
        elif typ == b"IDAT":
            idat.append(chunk)
        elif typ == b"IEND":
            break
        pos += 12 + ln

    raw = zlib.decompress(b"".join(idat))
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    bpp = ch * bd // 8
    stride = w * bpp
    out = bytearray(stride * h)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = raw[p:p + stride]
        p += stride
        row = y * stride
        prev = row - stride
        for i in range(stride):
            x = line[i]
            if ft == 0:
                v = x
            else:
                a = out[row + i - bpp] if i >= bpp else 0
                b = out[prev + i] if y else 0
                if ft == 1:
                    v = x + a
                elif ft == 2:
                    v = x + b
                elif ft == 3:
                    v = x + ((a + b) >> 1)
                else:
                    c = out[prev + i - bpp] if (y and i >= bpp) else 0
                    pp = a + b - c
                    pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                    v = x + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))
            out[row + i] = v & 0xFF

    arr = np.frombuffer(bytes(out), dtype=np.uint8)
    if bd == 16:
        pair = arr.reshape(-1, 2).astype(np.uint32)
        vals = (pair[:, 0] << 8) | pair[:, 1]
        a = vals.reshape(h, w * ch).astype(np.float64) / 65535.0
    else:
        a = arr.reshape(h, w * ch).astype(np.float64) / 255.0
    if ch >= 3:
        a = a.reshape(h, w, ch)[:, :, :3].mean(axis=2)
    elif ch == 2:
        a = a.reshape(h, w, ch)[:, :, 0]
    else:
        a = a.reshape(h, w)
    return a, bd


def load_gray_float(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        try:
            a, bd = read_png_array(path)
            print("读入 PNG: %d 位" % bd)
            return a
        except Exception as e:
            print("PNG 自解码失败(%s)，改用 PIL" % e)
    if ext in (".tif", ".tiff") and tifffile is not None:
        a = np.asarray(tifffile.imread(path))
    else:
        a = np.asarray(Image.open(path))
    a = a.astype(np.float64)
    if a.ndim == 3:
        a = a[:, :, :3].mean(axis=2)
    if a.max() > 1.5:
        a = a / 65535.0 if a.max() > 255 else a / 255.0
    return a


# --------------------------------------------------------------- 提取

def otsu(values):
    v = np.asarray(values, dtype=np.float64).ravel()
    lo, hi = float(v.min()), float(v.max())
    if hi <= lo:
        return hi
    hist, edges = np.histogram(v, bins=512, range=(lo, hi))
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2.0
    w = np.cumsum(hist)
    total = w[-1]
    s = np.cumsum(hist * centers)
    mB = s / np.maximum(w, 1e-12)
    mF = (s[-1] - s) / np.maximum(total - w, 1e-12)
    between = w * (total - w) * (mB - mF) ** 2
    between[w == 0] = -1
    between[total - w == 0] = -1
    best = between.max()
    idx = np.where(between >= best * (1 - 1e-6))[0]
    return float(centers[int(idx.mean())])


def band_mask(shape, rmin, rmax):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = h // 2, w // 2
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / (min(h, w) / 2.0)
    return (r >= rmin) & (r <= rmax)


def main():
    ap = argparse.ArgumentParser(description="从两张图里恢复频域掩码图案")
    ap.add_argument("original", help="原图（未修改）")
    ap.add_argument("modified", help="修改图")
    ap.add_argument("-o", "--out", default="extracted.png", help="输出 PNG 路径")
    ap.add_argument("--band", nargs=2, type=float, default=[0.10, 0.98], metavar=("MIN", "MAX"),
                    help="频带内/外径，以图像半宽为 1（默认 0.10 0.98）")
    ap.add_argument("--threshold", type=float, default=None, help="手动阈值（默认 Otsu）")
    ap.add_argument("--truth", default=None, help="已知答案掩码 PNG，用于计算 IoU")
    ap.add_argument("--pack", default=None, help="谜题包 JSON，读取其中的频带")
    ap.add_argument("--half", action="store_true", help="只输出右半平面（去掉镜像）")
    args = ap.parse_args()

    band_min, band_max = args.band
    pack = None
    if args.pack:
        with open(args.pack, "r", encoding="utf-8") as f:
            pack = json.load(f)
        band_min = pack.get("band", {}).get("min", band_min)
        band_max = pack.get("band", {}).get("max", band_max)

    A = load_gray_float(args.original)
    B = load_gray_float(args.modified)
    if A.shape != B.shape:
        sys.exit("尺寸不一致：%s vs %s" % (A.shape, B.shape))
    if A.shape[0] != A.shape[1]:
        side = 1 << int(np.floor(np.log2(min(A.shape))))
        print("警告：非正方形输入，按 %d x %d 裁剪" % (side, side))
        A, B = A[:side, :side], B[:side, :side]

    FA = np.fft.fftshift(np.fft.fft2(A))
    FB = np.fft.fftshift(np.fft.fft2(B))
    D = np.abs(FB - FA)

    bm = band_mask(D.shape, band_min, band_max)
    t = otsu(D[bm]) if args.threshold is None else args.threshold
    M = (D > t) & bm
    if args.half:
        h = D.shape[1] // 2
        M[:, :h + 1] = False

    Image.fromarray((M * 255).astype(np.uint8)).save(args.out)

    print("尺寸        : %d x %d" % (D.shape[1], D.shape[0]))
    print("频带        : %.2f ~ %.2f" % (band_min, band_max))
    print("阈值        : %.6g" % t)
    print("判定为选点  : %d" % int(M.sum()))
    if pack:
        print("谜题包选点  : %s" % pack.get("selection", {}).get("count"))
    print("输出        : %s" % args.out)

    if args.truth:
        T = np.asarray(Image.open(args.truth).convert("L")) > 127
        inter = np.logical_and(M, T).sum()
        union = np.logical_or(M, T).sum()
        iou = inter / union if union else 1.0
        print("IoU vs 答案 : %.4f" % iou)
        if iou < 0.9:
            sys.exit(2)


if __name__ == "__main__":
    main()
