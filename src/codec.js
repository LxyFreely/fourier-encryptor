/* =========================================================================
 * 编解码层：16 位 PNG / float32 TIFF / 专用位流
 * 浏览器与 Node 通用（依赖 CompressionStream / DecompressionStream）。
 * 浮点像素一律 0..1，满量程 = 1.0。
 * ========================================================================= */
(function (root) {
  'use strict';

  var F = (typeof module !== 'undefined' && module.exports) ? require('./fft.js') : root.FCore;

  /* ---------------------------------------------------------------- 工具 */

  function u8(bytes) {
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  async function deflate(bytes) {
    var cs = new CompressionStream('deflate');
    var stream = new Blob([u8(bytes)]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([u8(bytes)]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes, start, end) {
    var t = crcTable();
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function bytesToBase64(bytes) {
    var b = u8(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) {
      s += String.fromCharCode.apply(null, b.subarray(i, Math.min(b.length, i + CH)));
    }
    return btoa(s);
  }

  function base64ToBytes(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256Hex(bytes) {
    var d = await crypto.subtle.digest('SHA-256', u8(bytes));
    var a = new Uint8Array(d);
    var s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }

  /* ------------------------------------------------------------- PNG 写出 */

  function pngChunk(type, data) {
    var len = data ? data.length : 0;
    var out = new Uint8Array(12 + len);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    if (len) out.set(data, 8);
    dv.setUint32(8 + len, crc32(out, 4, 8 + len));
    return out;
  }

  /*
   * data: Float32Array 0..1，长度 w*h*ch（ch = 1 灰度 / 3 RGB）
   * bitDepth: 8 或 16
   */
  async function encodePng(data, w, h, ch, bitDepth) {
    var bps = bitDepth / 8;
    var stride = w * ch * bps;
    var raw = new Uint8Array((stride + 1) * h);
    var p = 0;
    var maxV = bitDepth === 16 ? 65535 : 255;
    for (var y = 0; y < h; y++) {
      raw[p++] = 0; /* filter: None，无损且解析简单 */
      for (var x = 0; x < w; x++) {
        for (var c = 0; c < ch; c++) {
          var v = data[(y * w + x) * ch + c];
          if (!(v >= 0)) v = 0;
          if (v > 1) v = 1;
          var q = Math.round(v * maxV);
          if (bitDepth === 16) {
            raw[p++] = (q >> 8) & 0xff;
            raw[p++] = q & 0xff;
          } else {
            raw[p++] = q & 0xff;
          }
        }
      }
    }
    var idat = await deflate(raw);
    var ihdr = new Uint8Array(13);
    var dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr[8] = bitDepth;
    ihdr[9] = ch === 1 ? 0 : (ch === 3 ? 2 : 6); /* 0=灰度 2=RGB 6=RGBA */
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    var parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', null)
    ];
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
    }
    return out;
  }

  /*
   * 往 PNG 里插一个标准 tEXt 文本块（keyword 最长 79 字节，Latin-1）。
   * 任何支持 PNG 的软件都能读到，是很好的"第一层线索"容器。
   */
  function pngAddText(png, keyword, text) {
    var b = u8(png);
    var kw = String(keyword).slice(0, 79);
    var kwBytes = [];
    for (var i = 0; i < kw.length; i++) kwBytes.push(kw.charCodeAt(i) & 0xff);
    var txtBytes = [];
    for (var j = 0; j < text.length; j++) {
      var c = text.charCodeAt(j);
      txtBytes.push(c < 256 ? c : 63);
    }
    var data = new Uint8Array(kwBytes.length + 1 + txtBytes.length);
    data.set(kwBytes, 0);
    data[kwBytes.length] = 0;
    data.set(txtBytes, kwBytes.length + 1);
    var chunk = pngChunk('tEXt', data);

    /* 插在 IHDR 之后 */
    var pos = 8;
    var dv = new DataView(b.buffer, b.byteOffset);
    var len = dv.getUint32(pos);
    var insertAt = pos + 12 + len;
    var out = new Uint8Array(b.length + chunk.length);
    out.set(b.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(b.subarray(insertAt), insertAt + chunk.length);
    return out;
  }

  /* 读回所有 tEXt 块 */
  function pngReadText(png) {
    var b = u8(png);
    var pos = 8;
    var out = [];
    var dv = new DataView(b.buffer, b.byteOffset);
    while (pos < b.length) {
      var len = dv.getUint32(pos);
      var type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      if (type === 'tEXt') {
        var s = b.subarray(pos + 8, pos + 8 + len);
        var k = '', t = '', inText = false;
        for (var i = 0; i < s.length; i++) {
          if (s[i] === 0 && !inText) { inText = true; continue; }
          if (inText) t += String.fromCharCode(s[i]);
          else k += String.fromCharCode(s[i]);
        }
        out.push({ keyword: k, text: t });
      }
      if (type === 'IEND') break;
      pos += 12 + len;
    }
    return out;
  }

  /* --------------------------------------------------------- 通道归一化 */

  /*
   * 统一成 3 通道 RGB。
   * 关键：PNG 可能是灰度(1)、灰度+alpha(2)、RGB(3)、RGBA(4)。
   * 下游若一律按 3 通道去读 RGBA 数据，整张图会被逐像素错位剪切。
   * alpha 按中灰合成，避免透明边缘变成黑白硬边（会在频谱里炸出十字）。
   */
  function ensureRgb(data, w, h, ch) {
    if (ch === 3) return data;
    var n = w * h;
    var out = new Float32Array(n * 3);
    var i, v, a;
    if (ch === 1) {
      for (i = 0; i < n; i++) {
        v = data[i];
        out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
      }
    } else if (ch === 2) {
      for (i = 0; i < n; i++) {
        v = data[i * 2];
        out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
      }
    } else if (ch === 4) {
      for (i = 0; i < n; i++) {
        a = data[i * 4 + 3];
        if (a >= 1) {
          out[i * 3] = data[i * 4];
          out[i * 3 + 1] = data[i * 4 + 1];
          out[i * 3 + 2] = data[i * 4 + 2];
        } else {
          out[i * 3] = data[i * 4] * a + 0.5 * (1 - a);
          out[i * 3 + 1] = data[i * 4 + 1] * a + 0.5 * (1 - a);
          out[i * 3 + 2] = data[i * 4 + 2] * a + 0.5 * (1 - a);
        }
      }
    } else {
      throw new Error('不支持的通道数: ' + ch);
    }
    return out;
  }

  /*
   * 拆出 alpha 通道（没有 alpha 的格式返回全 1，等价"完全不透明"）。
   * 与 ensureRgb 不同：这里不做合成，四通道模式要的是原始 RGBA。
   */
  function ensureAlpha(data, w, h, ch) {
    var n = w * h;
    var out = new Float32Array(n);
    var i;
    if (ch === 2) {
      for (i = 0; i < n; i++) out[i] = data[i * 2 + 1];
    } else if (ch === 4) {
      for (i = 0; i < n; i++) out[i] = data[i * 4 + 3];
    } else {
      out.fill(1);
    }
    return out;
  }

  /*
   * 原样拆出 RGB（透明像素也保留自己的颜色值），四通道模式的 R/G/B 画板用这份数据。
   * 用 ensureRgb 的"半透明合成到中灰"会让 alpha 的改动串到 RGB 上，
   * 四通道独立藏信息时必须避免这种串扰，所以单独提供一份未合成的视图。
   */
  function rawRgb(data, w, h, ch) {
    var n = w * h;
    var out = new Float32Array(n * 3);
    var i;
    if (ch === 3) return data;
    if (ch === 4) {
      for (i = 0; i < n; i++) {
        out[i * 3] = data[i * 4];
        out[i * 3 + 1] = data[i * 4 + 1];
        out[i * 3 + 2] = data[i * 4 + 2];
      }
    } else {
      /* 灰度 / 灰度+alpha：三通道同值 */
      for (i = 0; i < n; i++) {
        var v = data[i * ch];
        out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
      }
    }
    return out;
  }

  function ensureGray(data, w, h, ch) {
    var rgb = ensureRgb(data, w, h, ch);
    var n = w * h;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
    }
    return out;
  }

/* ------------------------------------------------------- 重采样 / 适配 */

  /* 区域重采样（面积平均；放大时等价于最近邻，保证"原图放大"可复现） */
  function resampleRect(src, sw, sh, ch, rx, ry, rw, rh, dw, dh) {
    var out = new Float32Array(dw * dh * ch);
    for (var dy = 0; dy < dh; dy++) {
      var sy0 = ry + dy * rh / dh, sy1 = ry + (dy + 1) * rh / dh;
      var y0 = Math.floor(sy0), y1 = Math.ceil(sy1);
      if (y1 <= y0) y1 = y0 + 1;
      for (var dx = 0; dx < dw; dx++) {
        var sx0 = rx + dx * rw / dw, sx1 = rx + (dx + 1) * rw / dw;
        var x0 = Math.floor(sx0), x1 = Math.ceil(sx1);
        if (x1 <= x0) x1 = x0 + 1;
        var a0 = 0, a1 = 0, a2 = 0, wsum = 0;
        for (var y = y0; y < y1; y++) {
          var wy = Math.min(sy1, y + 1) - Math.max(sy0, y);
          if (wy <= 0) continue;
          var yc = y < 0 ? 0 : (y >= sh ? sh - 1 : y);
          for (var x = x0; x < x1; x++) {
            var wx = Math.min(sx1, x + 1) - Math.max(sx0, x);
            if (wx <= 0) continue;
            var wgt = wx * wy;
            var xc = x < 0 ? 0 : (x >= sw ? sw - 1 : x);
            var si = (yc * sw + xc) * ch;
            if (ch >= 3) {
              a0 += src[si] * wgt;
              a1 += src[si + 1] * wgt;
              a2 += src[si + 2] * wgt;
            } else {
              a0 += src[si] * wgt;
            }
            wsum += wgt;
          }
        }
        var di = (dy * dw + dx) * ch;
        if (wsum > 0) {
          if (ch >= 3) {
            out[di] = a0 / wsum;
            out[di + 1] = a1 / wsum;
            out[di + 2] = a2 / wsum;
          } else {
            out[di] = a0 / wsum;
          }
        }
      }
    }
    return out;
  }

  /*
   * 把单通道灰度图适配到 N×N。
   * mode: cover 居中裁切 / stretch 拉伸 / fit 居中等比留边
   * 必须与编码端的几何完全一致，否则玩家端算出来的频谱会错位。
   */
  function fitToGray(gray, sw, sh, N, mode) {
    if (sw === N && sh === N) return Float32Array.from(gray);
    var out = new Float32Array(N * N);
    var y, x, k;
    if (mode === 'fit') {
      var scale = Math.min(N / sw, N / sh);
      var dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
      var small = resampleRect(gray, sw, sh, 1, 0, 0, sw, sh, dw, dh);
      var ox = Math.floor((N - dw) / 2), oy = Math.floor((N - dh) / 2);
      for (y = 0; y < dh; y++) {
        for (x = 0; x < dw; x++) out[(y + oy) * N + (x + ox)] = small[y * dw + x];
      }
      return out;
    }
    if (mode === 'stretch') return resampleRect(gray, sw, sh, 1, 0, 0, sw, sh, N, N);
    var s2 = Math.max(N / sw, N / sh);
    var rw = N / s2, rh = N / s2;
    return resampleRect(gray, sw, sh, 1, (sw - rw) / 2, (sh - rh) / 2, rw, rh, N, N);
  }

  /* 把任意通道数的源图适配成 N×N 的 RGB 浮点数组 */
  function fitToRgb(src, N, mode) {
    var ch = src.ch, data = src.data;
    if (ch !== 1 && ch !== 3) {
      data = ensureRgb(data, src.w, src.h, ch);
      ch = 3;
    }
    var sw = src.w, sh = src.h;
    var out = new Float32Array(N * N * 3);
    var i, y, x;
    if (mode === 'stretch') {
      var r = resampleRect(data, sw, sh, ch, 0, 0, sw, sh, N, N);
      if (ch === 3) return r;
      for (i = 0; i < N * N; i++) { out[i * 3] = r[i]; out[i * 3 + 1] = r[i]; out[i * 3 + 2] = r[i]; }
      return out;
    }
    if (mode === 'fit') {
      var scale = Math.min(N / sw, N / sh);
      var dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
      var small = resampleRect(data, sw, sh, ch, 0, 0, sw, sh, dw, dh);
      var ox = Math.floor((N - dw) / 2), oy = Math.floor((N - dh) / 2);
      for (y = 0; y < dh; y++) {
        for (x = 0; x < dw; x++) {
          var si2 = (y * dw + x) * ch;
          var di2 = ((y + oy) * N + (x + ox)) * 3;
          if (ch === 3) {
            out[di2] = small[si2]; out[di2 + 1] = small[si2 + 1]; out[di2 + 2] = small[si2 + 2];
          } else {
            out[di2] = small[si2]; out[di2 + 1] = small[si2]; out[di2 + 2] = small[si2];
          }
        }
      }
      return out;
    }
    var s2 = Math.max(N / sw, N / sh);
    var rw = N / s2, rh = N / s2;
    var res = resampleRect(data, sw, sh, ch, (sw - rw) / 2, (sh - rh) / 2, rw, rh, N, N);
    if (ch === 3) return res;
    for (var k2 = 0; k2 < N * N; k2++) { out[k2 * 3] = res[k2]; out[k2 * 3 + 1] = res[k2]; out[k2 * 3 + 2] = res[k2]; }
    return out;
  }

  /* ------------------------------------------------------------- PNG 读入 */

  function unfilter(raw, w, h, bpp) {
    var stride = w * bpp;
    var out = new Uint8Array(stride * h);
    var pos = 0;
    for (var y = 0; y < h; y++) {
      var ft = raw[pos++];
      var row = y * stride;
      var prev = row - stride;
      for (var i = 0; i < stride; i++) {
        var x = raw[pos + i];
        var a = i >= bpp ? out[row + i - bpp] : 0;
        var b = y > 0 ? out[prev + i] : 0;
        var c = (y > 0 && i >= bpp) ? out[prev + i - bpp] : 0;
        var v;
        if (ft === 0) v = x;
        else if (ft === 1) v = x + a;
        else if (ft === 2) v = x + b;
        else if (ft === 3) v = x + ((a + b) >> 1);
        else if (ft === 4) {
          var pp = a + b - c;
          var pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
        } else {
          throw new Error('不支持的 PNG 行滤波类型: ' + ft);
        }
        out[row + i] = v & 0xff;
      }
      pos += stride;
    }
    return out;
  }

  /*
   * 解析 PNG（支持 8/16 位、灰度/RGB/带 alpha，非隔行）。
   * 返回 { width, height, channels, bitDepth, data: Float32Array }
   */
  async function decodePng(buf) {
    var b = u8(buf);
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var s = 0; s < 8; s++) if (b[s] !== sig[s]) throw new Error('不是 PNG 文件');
    var pos = 8;
    var width = 0, height = 0, bitDepth = 8, colorType = 0, interlace = 0;
    var idat = [];
    var idatLen = 0;
    while (pos < b.length) {
      var dv = new DataView(b.buffer, b.byteOffset + pos);
      var len = dv.getUint32(0);
      var type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      var dataStart = pos + 8;
      if (type === 'IHDR') {
        width = dv.getUint32(8);
        height = dv.getUint32(12);
        bitDepth = b[pos + 16];
        colorType = b[pos + 17];
        interlace = b[pos + 20];
      } else if (type === 'IDAT') {
        idat.push(b.subarray(dataStart, dataStart + len));
        idatLen += len;
      } else if (type === 'IEND') {
        break;
      }
      pos = dataStart + len + 4;
    }
    if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
    var merged = new Uint8Array(idatLen);
    var o = 0;
    for (var i = 0; i < idat.length; i++) { merged.set(idat[i], o); o += idat[i].length; }
    var raw = await inflate(merged);
    var ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!ch) throw new Error('不支持的 PNG 颜色类型: ' + colorType);
    var bps = bitDepth / 8;
    var bpp = ch * bps;
    var px = unfilter(raw, width, height, bpp);
    var n = width * height * ch;
    var out = new Float32Array(n);
    var maxV = Math.pow(2, bitDepth) - 1;
    if (bitDepth === 16) {
      for (var k = 0; k < n; k++) out[k] = ((px[k * 2] << 8) | px[k * 2 + 1]) / 65535;
    } else if (bitDepth === 8) {
      for (var k2 = 0; k2 < n; k2++) out[k2] = px[k2] / 255;
    } else {
      throw new Error('不支持的位深: ' + bitDepth);
    }
    return { width: width, height: height, channels: ch, bitDepth: bitDepth, data: out };
  }

  /* ------------------------------------------------------- float32 TIFF */

  /*
   * 写出 32 位浮点 TIFF（小端、不压缩、planar=1）。
   * data: Float32Array 0..1，长度 w*h*ch（ch = 1 灰度 / 3 RGB / 4 RGBA）
   */
  function encodeTiff32f(data, w, h, ch) {
    var floatBytes = w * h * ch * 4;
    var multi = ch >= 3;
    var hasAlpha = ch === 4;
    var entryCount = hasAlpha ? 15 : 14; /* 256..296 + SampleFormat(339) [+ ExtraSamples(338)] */
    var ifdSize = 2 + entryCount * 12 + 4;
    var ifdOffset = 8;
    var extra = ifdOffset + ifdSize;
    if (extra % 2) extra++;
    var bpsArr = multi ? extra : -1;
    if (multi) extra += ch * 2;
    var sfArr = multi ? extra : -1;
    if (multi) extra += ch * 2;
    var xres = extra; extra += 8;
    var yres = extra; extra += 8;
    if (extra % 4) extra += 4 - (extra % 4);
    var dataOffset = extra;

    var buf = new ArrayBuffer(dataOffset + floatBytes);
    var dv = new DataView(buf);
    var bytes = new Uint8Array(buf);
    bytes[0] = 0x49; bytes[1] = 0x49;
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffset, true);

    var p = ifdOffset;
    dv.setUint16(p, entryCount, true);
    p += 2;

    function entry(tag, type, count, value) {
      dv.setUint16(p, tag, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      if (type === 3 && count === 1) {
        dv.setUint16(p + 8, value, true);
        dv.setUint16(p + 10, 0, true);
      } else if (type === 3 && count === 2) {
        dv.setUint16(p + 8, value, true);
        dv.setUint16(p + 10, 0, true);
      } else {
        dv.setUint32(p + 8, value, true);
      }
      p += 12;
    }

    /* 标签必须按升序写 */
    entry(256, 4, 1, w);
    entry(257, 4, 1, h);
    if (multi) entry(258, 3, ch, bpsArr); else entry(258, 3, 1, 32);
    entry(259, 3, 1, 1);
    entry(262, 3, 1, multi ? 2 : 1);
    entry(273, 4, 1, dataOffset);
    entry(277, 3, 1, ch);
    entry(278, 4, 1, h);
    entry(279, 4, 1, floatBytes);
    entry(282, 5, 1, xres);
    entry(283, 5, 1, yres);
    entry(284, 3, 1, 1);
    entry(296, 3, 1, 2);
    /* ExtraSamples = 2（非预乘 alpha），这是 RGBA 浮点 TIFF 必须的标签 */
    if (hasAlpha) entry(338, 3, 1, 2);
    if (multi) entry(339, 3, ch, sfArr); else entry(339, 3, 1, 3);
    dv.setUint32(p, 0, true);

    if (multi) {
      for (var i = 0; i < ch; i++) {
        dv.setUint16(bpsArr + i * 2, 32, true);
        dv.setUint16(sfArr + i * 2, 3, true);
      }
    }
    dv.setUint32(xres, 72, true); dv.setUint32(xres + 4, 1, true);
    dv.setUint32(yres, 72, true); dv.setUint32(yres + 4, 1, true);

    for (var k = 0; k < data.length; k++) dv.setFloat32(dataOffset + k * 4, data[k], true);
    return bytes;
  }

  /* 解析 32 位浮点 TIFF（也接受 8/16 位无符号） */
  function decodeTiff32f(buf) {
    var b = u8(buf);
    var dv = new DataView(b.buffer, b.byteOffset);
    var le = b[0] === 0x49 && b[1] === 0x49;
    var magic = dv.getUint16(2, le);
    if (magic !== 42) throw new Error('不是 TIFF 文件');
    var ifd = dv.getUint32(4, le);
    var count = dv.getUint16(ifd, le);
    var tags = {};
    for (var i = 0; i < count; i++) {
      var p = ifd + 2 + i * 12;
      var tag = dv.getUint16(p, le);
      var type = dv.getUint16(p + 2, le);
      var n = dv.getUint32(p + 4, le);
      var vals;
      var size = type === 3 ? 2 : (type === 4 ? 4 : (type === 5 ? 8 : 1));
      if (size * n <= 4) {
        vals = p + 8;
      } else {
        vals = dv.getUint32(p + 8, le);
      }
      tags[tag] = { type: type, count: n, off: vals, val0: type === 3 ? dv.getUint16(p + 8, le) : dv.getUint32(p + 8, le) };
    }
    function getOne(tag, dflt) {
      var t = tags[tag];
      if (!t) return dflt;
      return t.type === 3 ? dv.getUint16(t.off, le) : dv.getUint32(t.off, le);
    }
    var w = getOne(256, 0), h = getOne(257, 0);
    var spp = getOne(277, 1);
    var bpsTag = tags[258];
    var bits = bpsTag.type === 3 ? dv.getUint16(bpsTag.off, le) : dv.getUint32(bpsTag.off, le);
    var sfTag = tags[339];
    var sf = sfTag ? (sfTag.type === 3 ? dv.getUint16(sfTag.off, le) : 3) : 1;
    if (getOne(259, 1) !== 1) throw new Error('只支持未压缩 TIFF');
    if (getOne(284, 1) !== 1) throw new Error('只支持 PlanarConfiguration=1');
    var stripCount = tags[279] ? tags[279].count : 1;
    var n2 = w * h * spp;
    var out = new Float32Array(n2);
    var total = 0;
    for (var s = 0; s < stripCount; s++) {
      var so, sb;
      if (stripCount === 1) {
        so = getOne(273, 0); sb = getOne(279, 0);
      } else {
        so = dv.getUint32(tags[273].off + s * 4, le);
        sb = dv.getUint32(tags[279].off + s * 4, le);
      }
      var npx = sb / (spp * bits / 8);
      for (var j = 0; j < npx; j++) {
        for (var c = 0; c < spp; c++) {
          var idx = total + j * spp + c;
          if (idx >= n2) break;
          if (sf === 3 && bits === 32) out[idx] = dv.getFloat32(so + (j * spp + c) * 4, le);
          else if (bits === 16) out[idx] = dv.getUint16(so + (j * spp + c) * 2, le) / 65535;
          else out[idx] = dv.getUint8(so + (j * spp + c)) / 255;
        }
      }
      total += npx;
    }
    return { width: w, height: h, channels: spp, bitDepth: bits, data: out };
  }

  /* ------------------------------------------------- 位流 / 掩码 RLE */

  /* 掩码游程编码：从 0 值开始交替计数，变长 varint */
  function rleEncode(mask) {
    var out = [];
    var cur = 0, run = 0;
    for (var i = 0; i < mask.length; i++) {
      var v = mask[i] ? 1 : 0;
      if (v === cur) { run++; continue; }
      out.push(run);
      cur = v;
      run = 1;
    }
    out.push(run);
    var bytes = [];
    for (var k = 0; k < out.length; k++) {
      var n = out[k];
      while (n >= 0x80) { bytes.push((n & 0x7f) | 0x80); n = n >>> 7; }
      bytes.push(n);
    }
    return bytesToBase64(new Uint8Array(bytes));
  }

  function rleDecode(str, length) {
    var bytes = base64ToBytes(str);
    var mask = new Uint8Array(length);
    var pos = 0, cur = 0, i = 0;
    while (i < bytes.length) {
      var n = 0, shift = 0, byte;
      do {
        byte = bytes[i++];
        n |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      if (cur) mask.fill(1, pos, Math.min(length, pos + n));
      pos += n;
      cur = cur ? 0 : 1;
    }
    return mask;
  }

  /* --------------------------------------------------- 浮点 -> 显示字节 */

  function toGray(px, w, h, ch) {
    var out = new Float32Array(w * h);
    if (ch === 1) { out.set(px); return out; }
    for (var i = 0; i < w * h; i++) {
      var s = 0;
      for (var c = 0; c < ch; c++) s += px[i * ch + c];
      out[i] = s / ch;
    }
    return out;
  }

  var api = {
    deflate: deflate,
    inflate: inflate,
    crc32: crc32,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    sha256Hex: sha256Hex,
    encodePng: encodePng,
    decodePng: decodePng,
    pngAddText: pngAddText,
    pngReadText: pngReadText,
    encodeTiff32f: encodeTiff32f,
    decodeTiff32f: decodeTiff32f,
    rleEncode: rleEncode,
    rleDecode: rleDecode,
    toGray: toGray,
    ensureRgb: ensureRgb,
    ensureGray: ensureGray,
    ensureAlpha: ensureAlpha,
    rawRgb: rawRgb,
    resampleRect: resampleRect,
    fitToRgb: fitToRgb,
    fitToGray: fitToGray
  };

  root.FCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
