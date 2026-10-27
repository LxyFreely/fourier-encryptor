/* 核心数学自测：node test/core.test.cjs */
'use strict';
var F = require('../src/fft.js');

var fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

/* ---- 1. 二维 FFT 对拍朴素 DFT ---- */
(function () {
  var N = 8;
  var img = new Float32Array(N * N);
  for (var j = 0; j < N * N; j++) img[j] = Math.sin(j * 1.3) + 0.2 * Math.cos(j * 1.7);
  var f = F.forward(img, N);
  var maxErr = 0;
  for (var v = 0; v < N; v++) {
    for (var u = 0; u < N; u++) {
      var sr = 0, si = 0;
      for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
          var a = -2 * Math.PI * (u * x + v * y) / N;
          var p = img[y * N + x];
          sr += p * Math.cos(a);
          si += p * Math.sin(a);
        }
      }
      var k = v * N + u;
      maxErr = Math.max(maxErr, Math.abs(f.re[k] - sr), Math.abs(f.im[k] - si));
    }
  }
  ok('二维 FFT 与朴素 DFT 一致', maxErr < 1e-12, 'maxErr=' + maxErr.toExponential(2));
})();

/* ---- 2. 正逆变换往返 ---- */
(function () {
  var N = 32;
  var img = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) img[i] = Math.random();
  var back = F.inverse(F.forward(img, N));
  var e = F.maxAbsDiff(img, back);
  ok('FFT 正逆往返', e < 1e-12, 'err=' + e.toExponential(2));
})();

/* ---- 3. 实图频谱共轭对称 ---- */
(function () {
  var N = 32;
  var img = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) img[i] = Math.random();
  var s = F.forward(img, N);
  var e = 0;
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var k = F.cidx(x, y, N), m = F.mirrorIdx(x, y, N);
      e = Math.max(e, Math.abs(s.re[k] - s.re[m]), Math.abs(s.im[k] + s.im[m]));
    }
  }
  ok('mirrorIdx 精确对应共轭 bin', e < 1e-9, 'err=' + e.toExponential(2));
})();

/* ---- 4. 半平面编辑后逆变换虚部必须为 0 ---- */
(function () {
  var N = 64, half = N >> 1;
  var img = new Float32Array(N * N);
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) img[y * N + x] = 0.4 + 0.3 * Math.sin(x * 0.2) * Math.cos(y * 0.15);
  }
  var A = F.forward(img, N);
  var mask = new Uint8Array(N * N);
  for (var yy = 0; yy < N; yy++) {
    for (var xx = half + 1; xx < N; xx++) if (Math.random() < 0.2) mask[yy * N + xx] = 1;
  }
  var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.15, bandMax: 0.9, density: 1, maxBins: 500, seed: 12345 });
  var B = F.embed(A.re, A.im, N, { mode: 'add', delta: 0.01, sel: sel.sel, signs: sel.signs });
  var br = Float64Array.from(B.re), bi = Float64Array.from(B.im);
  F.fft2d(br, bi, N, true);
  var maxImag = 0;
  for (var i = 0; i < N * N; i++) maxImag = Math.max(maxImag, Math.abs(bi[i]));
  ok('实部加实数 + 共轭同步 -> 逆变换虚部为 0', maxImag < 1e-12, 'maxImag=' + maxImag.toExponential(2));
  ok('乘性扰动同样保持共轭', (function () {
    var B2 = F.embed(A.re, A.im, N, { mode: 'mul', eps: 0.05, sel: sel.sel, signs: sel.signs });
    var r2 = Float64Array.from(B2.re), i2 = Float64Array.from(B2.im);
    F.fft2d(r2, i2, N, true);
    var mx = 0;
    for (var i = 0; i < N * N; i++) mx = Math.max(mx, Math.abs(i2[i]));
    return mx < 1e-12;
  })());
  ok('选点数受上限约束', sel.count <= 500 && sel.count > 0, 'count=' + sel.count);
})();

/* ---- 5. 完整链路：嵌入 -> 量化 -> 提取 ---- */
function pipeline(N, delta, bits, densMask) {
  var half = N >> 1;
  var img = new Float32Array(N * N);
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      img[y * N + x] = 0.35 + 0.25 * Math.sin(x * 0.11 + y * 0.07) * Math.cos(y * 0.05) + 0.08 * Math.random();
    }
  }
  var A = F.forward(img, N);
  var mask = new Uint8Array(N * N);
  for (var my = half - 20; my < half + 20; my++) {
    for (var mx = half + 15; mx < half + 70; mx++) {
      if (mx > half && mx < N && my > 0 && my < N) mask[my * N + mx] = 1;
    }
  }
  var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.1, bandMax: 0.95, density: densMask || 1, maxBins: 1e9, seed: 777 });
  var B = F.embed(A.re, A.im, N, { mode: 'add', delta: delta, sel: sel.sel, signs: sel.signs });
  var ab = F.inverse(B);
  var step = Math.pow(2, bits) - 1;
  var abq = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) {
    var q = Math.round(ab[i] * step) / step;
    abq[i] = q < 0 ? 0 : (q > 1 ? 1 : q);
  }
  var D = F.diffMag(A, F.forward(abq, N), N);
  var r = F.extract({ D: D, N: N, bandMin: 0.1, bandMax: 0.95, threshold: null });
  return {
    iou: F.iouHalf(r.mask, sel.sel, N),
    psnr: F.psnr(img, abq),
    maxLsb: F.maxAbsDiff(img, abq) * Math.pow(2, bits),
    bins: r.bins,
    count: sel.count,
    fp: (function () {
      var fp = 0;
      for (var k = 0; k < N * N; k++) {
        var x = k % N;
        if (x <= half) continue;
        if (r.mask[k] && !sel.sel[k]) fp++;
      }
      return fp;
    })(),
    t: r.threshold
  };
}

(function () {
  var N = 128;
  var noise16 = F.quantNoiseStd(N, 16);
  var r16 = pipeline(N, noise16 * 8, 16);
  ok('16 位保存后提取 IoU≈1', r16.iou > 0.99, 'IoU=' + r16.iou.toFixed(4) + ' bins=' + r16.bins + '/' + r16.count + ' t=' + r16.t.toExponential(2));
  ok('16 位无误检', r16.fp === 0, 'fp=' + r16.fp);
  ok('16 位视觉无损', r16.psnr > 55, 'psnr=' + r16.psnr.toFixed(1) + 'dB maxDiff=' + r16.maxLsb.toFixed(2) + '/65535');

  var noise8 = F.quantNoiseStd(N, 8);
  var r8ok = pipeline(N, noise8 * 8, 8);
  ok('8 位(扰动 > 8σ)仍可提取', r8ok.iou > 0.95, 'IoU=' + r8ok.iou.toFixed(4) + ' psnr=' + r8ok.psnr.toFixed(1) + 'dB');
  var r8bad = pipeline(N, noise8 * 0.25, 8);
  console.log('  参考: 扰动 < 噪声时 8 位提取 IoU=' + r8bad.iou.toFixed(3) + '（按预期失败）');
})();

/* ---- 6. 密钥确定性 ---- */
(function () {
  var N = 64, half = N >> 1;
  var mask = new Uint8Array(N * N);
  for (var y = 10; y < 40; y++) for (var x = half + 5; x < half + 20; x++) mask[y * N + x] = 1;
  function pick(key) {
    return F.buildSelection({ mask: mask, N: N, bandMin: 0.05, bandMax: 0.98, density: 0.5, maxBins: 1e9, seed: F.keySeed(key) });
  }
  var a = pick('alpha'), b = pick('alpha'), c = pick('beta');
  var same = true, diff = 0;
  for (var i = 0; i < N * N; i++) {
    if (a.sel[i] !== b.sel[i]) same = false;
    if (a.sel[i] !== c.sel[i]) diff++;
  }
  ok('同密钥选点可复现', same);
  ok('不同密钥选点不同', diff > 0, 'diffBins=' + diff);
  ok('稀疏度生效', a.count > 0 && a.count < 300, 'count=' + a.count);
})();

/* ---- 7. Otsu ---- */
(function () {
  var v = [];
  for (var i = 0; i < 900; i++) v.push(Math.random() * 0.01);
  for (var j = 0; j < 100; j++) v.push(0.5 + Math.random() * 0.01);
  var t = F.otsu(v);
  ok('Otsu 阈值落在双峰之间', t > 0.012 && t < 0.5, 't=' + t.toFixed(4));
})();

console.log(fails === 0 ? '\n核心自测全部通过' : '\n失败 ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
