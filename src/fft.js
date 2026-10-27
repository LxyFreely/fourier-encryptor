/* =========================================================================
 * 频域核心：FFT / 选点 / 扰动 / 提取 / 质量度量
 * 纯计算，不依赖 DOM —— 浏览器与 Node 均可直接加载。
 * 所有像素值约定为 0..1 的浮点，满量程 = 1.0。
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- FFT */

  var planCache = Object.create(null);

  function plans(N) {
    var key = 'p' + N;
    var p = planCache[key];
    if (p) return p;
    var bits = 0;
    while ((1 << bits) < N) bits++;
    if ((1 << bits) !== N) throw new Error('FFT 尺寸必须是 2 的幂: ' + N);
    var rev = new Uint32Array(N);
    for (var i = 0; i < N; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      rev[i] = r;
    }
    var nh = N >> 1;
    var cosT = new Float64Array(nh);
    var sinT = new Float64Array(nh);
    for (var k = 0; k < nh; k++) {
      var a = 2 * Math.PI * k / N;
      cosT[k] = Math.cos(a);
      sinT[k] = Math.sin(a);
    }
    p = { N: N, rev: rev, cos: cosT, sin: sinT };
    planCache[key] = p;
    return p;
  }

  function fft1d(re, im, off, stride, plan, inv) {
    var N = plan.N, rev = plan.rev, cosT = plan.cos, sinT = plan.sin;
    var i, j, t, a, b;
    for (i = 0; i < N; i++) {
      j = rev[i];
      if (j > i) {
        a = off + i * stride; b = off + j * stride;
        t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    var sgn = inv ? 1 : -1;
    for (var len = 2; len <= N; len <<= 1) {
      var half = len >> 1, step = N / len;
      for (i = 0; i < N; i += len) {
        for (var k = 0; k < half; k++) {
          var idx = k * step;
          var c = cosT[idx], s = sgn * sinT[idx];
          var p1 = off + (i + k) * stride;
          var p2 = off + (i + k + half) * stride;
          var xr = re[p2] * c - im[p2] * s;
          var xi = re[p2] * s + im[p2] * c;
          re[p2] = re[p1] - xr;
          im[p2] = im[p1] - xi;
          re[p1] += xr;
          im[p1] += xi;
        }
      }
    }
  }

  /* 二维 FFT（原地）。inv=false 正向，inv=true 逆向并归一化 1/(N*N)。 */
  function fft2d(re, im, N, inv) {
    var plan = plans(N);
    for (var y = 0; y < N; y++) fft1d(re, im, y * N, 1, plan, inv);
    for (var x = 0; x < N; x++) fft1d(re, im, x, N, plan, inv);
    if (inv) {
      var s = 1 / (N * N);
      for (var i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  /* 实数图像 -> 复数频谱 */
  function forward(gray, N) {
    var re = new Float64Array(N * N);
    var im = new Float64Array(N * N);
    for (var i = 0; i < N * N; i++) re[i] = gray[i];
    fft2d(re, im, N, false);
    return { re: re, im: im, N: N };
  }

  /* 复数频谱 -> 实图像（取实部） */
  function inverse(spec) {
    var N = spec.N;
    var re = Float64Array.from(spec.re);
    var im = Float64Array.from(spec.im);
    fft2d(re, im, N, true);
    var out = new Float32Array(N * N);
    for (var i = 0; i < N * N; i++) out[i] = re[i];
    return out;
  }

  /* -------------------------------------------------- 坐标 / 频带 / 哈希 */

  /* 中心化显示坐标 (x,y) -> 标准 FFT 数组下标 */
  function cidx(x, y, N) {
    var h = N >> 1;
    return (((y + h) % N) * N) + ((x + h) % N);
  }

  /* 中心对称坐标：中心化坐标 (x,y) 的 180 度对径点 */
  function mirrorXY(x, y, N) {
    return [((N - x) % N), ((N - y) % N)];
  }

  /* 中心对称映射（返回中心化坐标下的数组下标，用于掩码 / 选点 / 显示） */
  function mirrorCell(x, y, N) {
    return (((N - y) % N) * N) + ((N - x) % N);
  }

  /* 中心对称映射（返回 FFT 数组下标，用于频谱读写） */
  function mirrorIdx(x, y, N) {
    return cidx((N - x) % N, (N - y) % N, N);
  }

  var bandCache = Object.create(null);

  /* 归一化半径表：0 = DC，1 = 奈奎斯特边缘 */
  function bandTable(N) {
    var key = 'b' + N;
    if (bandCache[key]) return bandCache[key];
    var t = new Float32Array(N * N);
    var h = N >> 1;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var u = x - h, v = y - h;
        t[y * N + x] = Math.sqrt(u * u + v * v) / h;
      }
    }
    bandCache[key] = t;
    return t;
  }

  function keySeed(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hash32(x, y, seed) {
    var h = seed ^ Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 1, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function h01(x, y, seed) {
    return hash32(x, y, seed) / 4294967296;
  }

  /* ------------------------------------------------------------ 选点掩码 */

  var HALF = 0x5bf03635;

  /* 双精度阶跃直方图求阈值，把候选集精确压到 maxBins 以内 */
  function hashThreshold(hashes, maxBins) {
    var BINS = 4096;
    var hist = new Uint32Array(BINS);
    var i, b;
    for (i = 0; i < hashes.length; i++) {
      b = (hashes[i] * BINS) | 0;
      if (b >= BINS) b = BINS - 1;
      hist[b]++;
    }
    var acc = 0;
    for (b = 0; b < BINS; b++) {
      if (acc + hist[b] > maxBins) {
        return (b + 1) / BINS;
      }
      acc += hist[b];
    }
    return 1;
  }

  /*
   * 由手绘掩码（中心化坐标，任意位置）生成实际嵌入的选点集合。
   * 每一对共轭频点只决策一次，然后成对写入，所以返回的 sel 永远中心对称。
   * opts: { mask, N, bandMin, bandMax, density, maxBins, seed }
   * 返回 { sel: Uint8Array, count, signs: Int8Array }
   */
  function buildSelection(opts) {
    var N = opts.N, mask = opts.mask;
    var band = bandTable(N);
    var rMin = opts.bandMin;
    /* outerLimited === false 表示不限外径：只受内径和 DC 约束 */
    var rMax = (opts.outerLimited === false) ? Infinity : opts.bandMax;
    var density = opts.density === undefined ? 1 : opts.density;
    var maxBins = opts.maxBins || 1e9;
    var seed = opts.seed >>> 0;
    var dci = (N >> 1) * N + (N >> 1);   /* 中心化坐标下的 DC 下标 */

    var sel = new Uint8Array(N * N);
    var signs = new Int8Array(N * N);
    var cand = [];
    var hashes = [];
    var x, y, i, r, m;

    /*
     * 掩码可以画在任意位置：每一对共轭频点只由它的"规范成员"（下标较小者）
     * 做一次抽样决策，然后把决策复制给镜像，保证选点集始终中心对称。
     */
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        i = y * N + x;
        if (!mask[i]) continue;
        if (i === dci) continue;                 /* DC 永远不动 */
        r = band[i];
        if (r < rMin || r > rMax) continue;
        m = mirrorCell(x, y, N);
        /* 只有"镜像也在掩码里、且它的下标更小"时才让给它，否则由本点代表这一对。
           这样无论掩码是对称的、只在左半边、还是只在右半边，都能正确成对。 */
        if (m !== i && mask[m] && m < i) continue;
        if (density < 1 && h01(x, y, seed ^ 0x9e3779b9) >= density) continue;
        cand.push(i);
        hashes.push(h01(x, y, seed ^ 0x51ed270b));
      }
    }

    var kept = [];
    if (cand.length > maxBins) {
      var t = hashThreshold(hashes, maxBins);
      for (i = 0; i < cand.length && kept.length < maxBins; i++) {
        if (hashes[i] < t) kept.push(cand[i]);
      }
      if (kept.length < maxBins) {
        for (i = 0; i < cand.length && kept.length < maxBins; i++) {
          if (hashes[i] === t) kept.push(cand[i]);
        }
      }
    } else {
      kept = cand;
    }

    /* 成对写入 + 同一对共用同一个符号（符号不同会破坏共轭） */
    for (var q = 0; q < kept.length; q++) {
      var idx = kept[q];
      var xx = idx % N, yy = (idx / N) | 0;
      var mm = mirrorCell(xx, yy, N);
      var sg = (hash32(xx, yy, seed ^ HALF) & 1) ? 1 : -1;
      sel[idx] = 1;
      signs[idx] = sg;
      if (mm !== idx) { sel[mm] = 1; signs[mm] = sg; }
    }
    return { sel: sel, count: kept.length, signs: signs };
  }

  /* ------------------------------------------------------- 嵌入 / 提取 */

  /*
   * 对选中的 bin 施加扰动。返回新的频谱副本（不修改入参）。
   * opts: { mode: 'add'|'mul', delta, eps, sel, signs, N }
   */
  function embed(re, im, N, opts) {
    var outR = Float64Array.from(re);
    var outI = Float64Array.from(im);
    var sel = opts.sel, signs = opts.signs;
    var mode = opts.mode || 'add';
    var delta = opts.delta, eps = opts.eps;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (!sel[i]) continue;
        var k = cidx(x, y, N);
        var m = mirrorIdx(x, y, N);
        /* 每一对只施加一次，否则 k 和它的镜像会各加一遍变成 2 倍 */
        if (m < k) continue;
        var s = signs[i] || 1;
        if (mode === 'mul') {
          var f = 1 + eps * s;
          outR[k] *= f; outI[k] *= f;
          if (m !== k) { outR[m] *= f; outI[m] *= f; }
        } else {
          var d = delta * s;
          outR[k] += d;          /* 实部加实数，共轭 bin 同步 -> 保持共轭对称 */
          if (m !== k) outR[m] += d;
        }
      }
    }
    return { re: outR, im: outI, N: N };
  }

  /* 频域差分幅度 |F(Ab) - F(A)|，输出为中心化坐标数组 */
  function diffMag(sa, sb, N) {
    var D = new Float32Array(N * N);
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var k = cidx(x, y, N);
        var dr = sb.re[k] - sa.re[k];
        var di = sb.im[k] - sa.im[k];
        D[y * N + x] = Math.sqrt(dr * dr + di * di);
      }
    }
    return D;
  }

  /* Otsu 阈值 */
  function otsu(values, minV, maxV) {
    var BINS = 512;
    if (minV === undefined) {
      minV = Infinity; maxV = -Infinity;
      for (var i = 0; i < values.length; i++) {
        var v0 = values[i];
        if (v0 < minV) minV = v0;
        if (v0 > maxV) maxV = v0;
      }
    }
    if (!(maxV > minV)) return maxV;
    var hist = new Float64Array(BINS);
    var scale = (BINS - 1) / (maxV - minV);
    var total = 0;
    for (var j = 0; j < values.length; j++) {
      var b = Math.round((values[j] - minV) * scale);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      hist[b]++;
      total++;
    }
    var sum = 0;
    for (var b2 = 0; b2 < BINS; b2++) sum += b2 * hist[b2];
    var between = new Float64Array(BINS);
    var sumB = 0, wB = 0, best = -1;
    for (var t = 0; t < BINS; t++) {
      wB += hist[t];
      if (wB === 0) { between[t] = -1; continue; }
      var wF = total - wB;
      if (wF === 0) { between[t] = -1; break; }
      sumB += t * hist[t];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      between[t] = wB * wF * (mB - mF) * (mB - mF);
      if (between[t] > best) best = between[t];
    }
    if (best <= 0) return minV + 0.5 * (maxV - minV);
    /* 取最优平台的中点，避免阈值贴着噪声簇边缘 */
    var lo = 0, hi = BINS - 1, eps = best * (1 - 1e-6);
    while (lo < BINS && between[lo] < eps) lo++;
    while (hi > 0 && between[hi] < eps) hi--;
    var mid = (lo + hi) / 2;
    return minV + (mid + 0.5) / scale;
  }

  /*
   * 恢复选点掩码。
   * opts: { D, N, bandMin, bandMax, threshold (null=自动 Otsu) }
   * 返回 { mask, threshold, bins }
   */
  function extract(opts) {
    var D = opts.D, N = opts.N;
    var band = bandTable(N);
    var rMin = opts.bandMin, rMax = opts.bandMax;
    var vals = [];
    var x, y, i;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        i = y * N + x;
        var r = band[i];
        if (r < rMin || r > rMax) continue;
        vals.push(D[i]);
      }
    }
    var t = (opts.threshold === null || opts.threshold === undefined) ? otsu(vals) : opts.threshold;
    var mask = new Uint8Array(N * N);
    var bins = 0;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        i = y * N + x;
        if (band[i] < rMin || band[i] > rMax) continue;
        if (D[i] > t) { mask[i] = 1; bins++; }
      }
    }
    return { mask: mask, threshold: t, bins: bins };
  }

  /* --------------------------------------------- 度量：PSNR / IoU / 统计 */

  function mse(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) {
      var d = a[i] - b[i];
      s += d * d;
    }
    return s / a.length;
  }

  function psnr(a, b) {
    var m = mse(a, b);
    if (m <= 0) return Infinity;
    return 10 * Math.log(1 / m) / Math.LN10;
  }

  function maxAbsDiff(a, b) {
    var m = 0;
    for (var i = 0; i < a.length; i++) {
      var d = Math.abs(a[i] - b[i]);
      if (d > m) m = d;
    }
    return m;
  }

  /* 只比较半平面：选点集本身对称，比一半即可，避免重复计数 */
  function iouHalf(a, b, N) {
    var half = N >> 1;
    var inter = 0, uni = 0;
    for (var y = 0; y < N; y++) {
      for (var x = half + 1; x < N; x++) {
        var i = y * N + x;
        var av = a[i] ? 1 : 0, bv = b[i] ? 1 : 0;
        if (av && bv) inter++;
        if (av || bv) uni++;
      }
    }
    return uni === 0 ? 1 : inter / uni;
  }

  /* 8 位量化噪声在频域的等效标准差（0..1 满量程） */
  function quantNoiseStd(N, bits) {
    var step = 1 / Math.pow(2, bits);
    return N * step / Math.sqrt(12);
  }

  /* ------------------------------------------------------------ 可视化 */

  /* log 幅度谱，用于画板底图 */
  function logMag(re, im, N) {
    var m = new Float32Array(N * N);
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var k = cidx(x, y, N);
        m[y * N + x] = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      }
    }
    return m;
  }

  /* 把幅度谱映射到 0..255，跳过中心 5x5（DC 极亮）后做 99.5 分位归一 */
  function spectrumToBytes(m, N) {
    var h = N >> 1;
    var samp = [];
    for (var y = 0; y < N; y += 2) {
      for (var x = 0; x < N; x += 2) {
        if (Math.abs(x - h) <= 2 && Math.abs(y - h) <= 2) continue;
        samp.push(m[y * N + x]);
      }
    }
    samp.sort(function (a, b) { return a - b; });
    var hi = samp.length ? samp[Math.min(samp.length - 1, Math.floor(samp.length * 0.995))] : 1;
    if (!(hi > 0)) hi = 1;
    var out = new Uint8Array(N * N);
    for (var i = 0; i < N * N; i++) {
      var v = m[i] / hi;
      if (v > 1) v = 1;
      if (v < 0) v = 0;
      out[i] = Math.round(255 * Math.pow(v, 0.75));
    }
    return out;
  }

  /*
   * 差分图（玩家视角）归一化到 0..255。
   * 求最大值时跳过 DC 及其相邻两格：直流分量天然比信号大几个数量级
   * （四通道模式的"防削波"平移甚至会把它推到几十倍），一旦让它参与归一化，
   * 整张差分图都会被压成黑片。
   */
  function diffToBytes(D, N, gain) {
    var hi = 0, i, x, y, h = N >> 1;
    if (N) {
      for (y = 0; y < N; y++) {
        for (x = 0; x < N; x++) {
          if (Math.abs(x - h) <= 1 && Math.abs(y - h) <= 1) continue;
          if (D[y * N + x] > hi) hi = D[y * N + x];
        }
      }
    } else {
      for (i = 0; i < D.length; i++) if (D[i] > hi) hi = D[i];
    }
    if (!(hi > 0)) hi = 1;
    var out = new Uint8Array(N * N);
    var g = gain === undefined ? 1 : gain;
    for (var j = 0; j < N * N; j++) {
      var v = Math.pow(Math.min(1, (D[j] / hi) * g), 0.45);
      out[j] = Math.round(255 * v);
    }
    return out;
  }

  /* ------------------------------------------------------------ 导出 */

  var api = {
    plans: plans,
    fft2d: fft2d,
    forward: forward,
    inverse: inverse,
    cidx: cidx,
    mirrorXY: mirrorXY,
    mirrorCell: mirrorCell,
    mirrorIdx: mirrorIdx,
    bandTable: bandTable,
    keySeed: keySeed,
    hash32: hash32,
    h01: h01,
    buildSelection: buildSelection,
    embed: embed,
    diffMag: diffMag,
    otsu: otsu,
    extract: extract,
    mse: mse,
    psnr: psnr,
    maxAbsDiff: maxAbsDiff,
    iouHalf: iouHalf,
    quantNoiseStd: quantNoiseStd,
    logMag: logMag,
    spectrumToBytes: spectrumToBytes,
    diffToBytes: diffToBytes
  };

  root.FCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
