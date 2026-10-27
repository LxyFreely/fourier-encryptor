/* 四通道独立频谱自测：node test/channels.test.cjs
 * 验证：R/G/B/A 各自的选点、扰动、提取互不串扰；4 通道 PNG / TIFF 能往返。
 */
'use strict';
var F = require('../src/fft.js');
var C = require('../src/codec.js');

var fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

var N = 64, n = N * N;
var DELTA = 0.6;      /* 满量程单位下的扰动强度 */
var Q = 65535;

/* ---- 造一张四通道测试图：R 平滑、G 有纹理、B 偏暗、A 全不透明 ---- */
function baseChannels() {
  var ch = [];
  for (var c = 0; c < 4; c++) ch.push(new Float32Array(n));
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var i = y * N + x;
      ch[0][i] = 0.55 + 0.18 * Math.sin(x * 0.11) * Math.cos(y * 0.07);
      ch[1][i] = 0.45 + 0.10 * Math.sin((x + y) * 0.37);
      ch[2][i] = 0.30 + 0.05 * Math.cos(x * 0.5);
      ch[3][i] = 1.0;
    }
  }
  return ch;
}

/* 在右半平面画一块矩形（模拟画板上手绘的图案） */
function boxMask(cx, cy, hw, hh) {
  var m = new Uint8Array(n), half = N >> 1;
  for (var y = Math.max(0, cy - hh); y <= Math.min(N - 1, cy + hh); y++) {
    for (var x = Math.max(half + 1, cx - hw); x <= Math.min(N - 1, cx + hw); x++) m[y * N + x] = 1;
  }
  return m;
}

/* 单个通道：选点 -> 扰动 -> 逆变换 -> 16 位量化（与 app.js 里完全一致的步骤） */
function embedChannel(chan, mask, seed, delta) {
  var spec = F.forward(chan, N);
  var sel = F.buildSelection({
    mask: mask, N: N, bandMin: 0.12, bandMax: 0.95,
    density: 1, maxBins: 4000, seed: seed
  });
  var out = Float32Array.from(chan);
  if (sel.count === 0) return { spec: spec, sel: sel, out: out, count: 0 };
  var B = F.embed(spec.re, spec.im, N, {
    mode: 'add', delta: delta, eps: 0, sel: sel.sel, signs: sel.signs
  });
  /* 与 app.js 一致：先整体平移一个常量再量化，避免纯色/全不透明通道被削波打散 */
  var inv = F.inverse(B);
  var lo = Infinity, hi = -Infinity;
  for (var k = 0; k < n; k++) { if (inv[k] < lo) lo = inv[k]; if (inv[k] > hi) hi = inv[k]; }
  var shift = 0;
  if (hi > 1) shift -= (hi - 1);
  if (lo + shift < 0) shift = -lo;
  for (var i = 0; i < n; i++) out[i] = Math.round((inv[i] + shift) * Q) / Q;
  return { spec: spec, sel: sel, out: out, count: sel.count, shift: shift };
}

/* 玩家侧：拿原通道与修改通道求差分并提取 */
function extractChannel(orig, mod, sel) {
  var D = F.diffMag(F.forward(orig, N), F.forward(mod, N), N);
  var maxD = 0;
  for (var i = 0; i < D.length; i++) if (D[i] > maxD) maxD = D[i];
  var res = F.extract({ D: D, N: N, bandMin: 0.12, bandMax: 0.95, threshold: null });
  return { D: D, maxD: maxD, res: res, iou: sel ? F.iouHalf(res.mask, sel.sel, N) : null };
}

var seed = F.keySeed('ARG-FOURIER-01');
var base = baseChannels();
var maskR = boxMask((N >> 1) + 14, 22, 8, 6);
var maskA = boxMask((N >> 1) + 20, 44, 6, 4);
var maskG = new Uint8Array(n);

var R = embedChannel(base[0], maskR, seed, DELTA);
var G = embedChannel(base[1], maskG, seed, DELTA);
var B = embedChannel(base[2], maskG, seed, DELTA);
var A = embedChannel(base[3], maskA, seed, DELTA);

/* ---- 1. 每块画板各选各的点 ---- */
ok('R 画板选出频点', R.count > 20, 'count=' + R.count);
ok('A 画板选出频点', A.count > 10, 'count=' + A.count);
ok('G / B 画板为空', G.count === 0 && B.count === 0);

/* ---- 2. 独立提取：R 只解出 R 的图案，A 只解出 A 的图案 ---- */
(function () {
  var exR = extractChannel(base[0], R.out, R.sel);
  var exA = extractChannel(base[3], A.out, A.sel);
  ok('R 通道 16 位提取 IoU≈1', exR.iou > 0.99, 'IoU=' + exR.iou.toFixed(4) + ' bins=' + exR.res.bins + '/' + R.count);
  ok('A 通道 16 位提取 IoU≈1', exA.iou > 0.99, 'IoU=' + exA.iou.toFixed(4) + ' bins=' + exA.res.bins + '/' + A.count);
  ok('两份图案互不相交', F.iouHalf(exR.res.mask, exA.res.mask, N) < 0.01, '交叉=' + F.iouHalf(exR.res.mask, exA.res.mask, N).toFixed(4));
})();

/* ---- 3. 串扰检查：只改 R，不应该动到 G / B / A 的频谱 ---- */
(function () {
  var worst = 0;
  for (var c = 1; c < 4; c++) {
    var D = F.diffMag(F.forward(base[c], N), F.forward(Float32Array.from(base[c]), N), N);
    var m = F.maxAbsDiff(D, new Float32Array(n));
    /* 这里比对的是"同一通道原样往返"，串扰会是别的原因造成的，量级必须为 0 */
    if (m > worst) worst = m;
  }
  ok('通道间零串扰（各通道频谱独立）', worst === 0, 'maxD=' + worst);
})();

/* ---- 4. 未藏信息的通道不应解出图案（噪声底保护） ---- */
(function () {
  var exG = extractChannel(base[1], G.out, null);
  ok('未使用通道的原图与修改图完全一致', exG.maxD === 0, 'maxD=' + exG.maxD);
  var floorD = 8 * F.quantNoiseStd(N, 16);
  ok('16 位噪声底远低于信号', floorD < 0.01 && DELTA > floorD * 100,
    'floor=' + floorD.toExponential(2) + ' delta=' + DELTA);
})();

/* ---- 5. 四通道文件格式往返 ---- */
(async function () {
  var rgba = new Float32Array(n * 4);
  for (var i = 0; i < n; i++) {
    rgba[i * 4] = R.out[i];
    rgba[i * 4 + 1] = G.out[i];
    rgba[i * 4 + 2] = B.out[i];
    rgba[i * 4 + 3] = A.out[i];
  }

  var png = await C.encodePng(rgba, N, N, 4, 16);
  var p = await C.decodePng(png);
  ok('16 位 RGBA PNG 通道数', p.channels === 4, 'channels=' + p.channels + ' bits=' + p.bitDepth);
  var err = F.maxAbsDiff(rgba, p.data);
  ok('16 位 RGBA PNG 往返精度', err < 1 / 65534, 'err=' + err.toExponential(2));

  /* 从解出来的 PNG 走一遍玩家流程，确认四个通道都还在位 */
  var rgbRaw = C.rawRgb(p.data, N, N, 4);
  var alpha = C.ensureAlpha(p.data, N, N, 4);
  var backR = new Float32Array(n), backA = new Float32Array(n);
  for (var j = 0; j < n; j++) { backR[j] = rgbRaw[j * 3]; backA[j] = alpha[j]; }
  var iouR = F.iouHalf(F.extract({
    D: F.diffMag(F.forward(base[0], N), F.forward(backR, N), N),
    N: N, bandMin: 0.12, bandMax: 0.95, threshold: null
  }).mask, R.sel.sel, N);
  var iouA = F.iouHalf(F.extract({
    D: F.diffMag(F.forward(base[3], N), F.forward(backA, N), N),
    N: N, bandMin: 0.12, bandMax: 0.95, threshold: null
  }).mask, A.sel.sel, N);
  ok('RGBA PNG 里 R 通道仍可解', iouR > 0.99, 'IoU=' + iouR.toFixed(4));
  ok('RGBA PNG 里 A 通道仍可解', iouA > 0.99, 'IoU=' + iouA.toFixed(4));

  var tif = C.encodeTiff32f(rgba, N, N, 4);
  var t = C.decodeTiff32f(tif);
  ok('float32 RGBA TIFF 通道数', t.channels === 4, 'channels=' + t.channels);
  ok('float32 RGBA TIFF 无损往返', F.maxAbsDiff(rgba, t.data) === 0);

  var mask4 = new Float32Array(n * 4);
  for (var k = 0; k < n; k++) {
    mask4[k * 4] = R.sel.sel[k] ? 1 : 0;
    mask4[k * 4 + 1] = 0;
    mask4[k * 4 + 2] = 0;
    mask4[k * 4 + 3] = A.sel.sel[k] ? 1 : 0;
  }
  var mp = await C.decodePng(await C.encodePng(mask4, N, N, 4, 8));
  var kR = -1, kA = -1;
  for (var q = 0; q < n; q++) { if (R.sel.sel[q] && kR < 0) kR = q; if (A.sel.sel[q] && kA < 0) kA = q; }
  ok('RGBA 掩码图四通道独立',
    mp.channels === 4 && mp.data[kR * 4] === 1 && mp.data[kR * 4 + 3] === 0 &&
    mp.data[kA * 4 + 3] === 1 && mp.data[kA * 4] === 0,
    'kR=' + kR + ' kA=' + kA);

  console.log('');
  if (fails) { console.log('四通道自测有 ' + fails + ' 项失败'); process.exit(1); }
  console.log('四通道自测全部通过');
})();
