/* 新语义：任意位置绘制、自动共轭、可关闭外径限制 */
'use strict';
var F = require('../src/fft.js');

var fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

function iouAll(a, b, N) {
  var inter = 0, uni = 0;
  for (var i = 0; i < N * N; i++) {
    var av = a[i] ? 1 : 0, bv = b[i] ? 1 : 0;
    if (av && bv) inter++;
    if (av || bv) uni++;
  }
  return uni === 0 ? 1 : inter / uni;
}

function isSymmetric(sel, N) {
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var i = y * N + x;
      if (!!sel[i] !== !!sel[F.mirrorCell(x, y, N)]) return false;
    }
  }
  return true;
}

function makeImage(N, seed) {
  var img = new Float32Array(N * N);
  var s = seed || 3;
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      var r = s / 0x7fffffff;
      img[y * N + x] = 0.35 + 0.2 * Math.sin(x * 0.3) * Math.cos(y * 0.21) + 0.06 * r;
    }
  }
  return img;
}

function run(N, mask, opts, label) {
  var img = makeImage(N, 11);
  var A = F.forward(img, N);
  var sel = F.buildSelection({
    mask: mask, N: N,
    bandMin: opts.bandMin, bandMax: opts.bandMax, outerLimited: opts.outerLimited,
    density: 1, maxBins: 1e9, seed: F.keySeed('free')
  });
  var B = F.embed(A.re, A.im, N, { mode: 'add', delta: 1, sel: sel.sel, signs: sel.signs });

  /* 逆变换虚部必须为 0：说明共轭对称没被破坏 */
  var br = Float64Array.from(B.re), bi = Float64Array.from(B.im);
  F.fft2d(br, bi, N, true);
  var maxImag = 0;
  for (var i = 0; i < N * N; i++) maxImag = Math.max(maxImag, Math.abs(bi[i]));

  var ab = F.inverse(B);
  var abq = new Float32Array(N * N);
  for (var j = 0; j < N * N; j++) abq[j] = Math.round(Math.min(1, Math.max(0, ab[j])) * 65535) / 65535;

  var bandMax = opts.outerLimited === false ? 2 : opts.bandMax;
  var D = F.diffMag(A, F.forward(abq, N), N);
  var ex = F.extract({ D: D, N: N, bandMin: opts.bandMin, bandMax: bandMax, threshold: null });

  return {
    sel: sel, iou: iouAll(ex.mask, sel.sel, N), maxImag: maxImag,
    symmetric: isSymmetric(sel.sel, N), bins: ex.bins
  };
}

var N = 64, h = N >> 1;

/* ---- 1. 只在左半边画（以前画不了） ---- */
(function () {
  var mask = new Uint8Array(N * N);
  for (var y = 12; y < 40; y++) for (var x = 4; x < 26; x++) mask[y * N + x] = 1;
  var r = run(N, mask, { bandMin: 0.05, bandMax: 0.95, outerLimited: true }, 'left');
  ok('左半边绘制也能选出频点', r.sel.count > 20, 'count=' + r.sel.count);
  ok('选点集中心对称', r.symmetric);
  ok('逆变换虚部为 0（共轭没破）', r.maxImag < 1e-12, r.maxImag.toExponential(2));
  ok('左半边绘制可完整提取', r.iou > 0.98, 'IoU=' + (r.iou * 100).toFixed(1) + '%');
})();

/* ---- 2. 跨中心线的笔画 ---- */
(function () {
  var mask = new Uint8Array(N * N);
  for (var y = 20; y < 44; y++) for (var x = 24; x < 40; x++) mask[y * N + x] = 1;
  var r = run(N, mask, { bandMin: 0.05, bandMax: 0.95, outerLimited: true }, 'cross');
  ok('跨中心线绘制正常', r.sel.count > 20 && r.symmetric, 'count=' + r.sel.count);
  ok('跨中心线可完整提取', r.iou > 0.98, 'IoU=' + (r.iou * 100).toFixed(1) + '%');
})();

/* ---- 3. 不限外径：能画到角落（半径 > 1） ---- */
(function () {
  var mask = new Uint8Array(N * N);
  var band = F.bandTable(N);
  var corner = 0;
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var i = y * N + x;
      if (band[i] > 1.05 && ((x < 12 && y < 12) || (x > N - 13 && y > N - 13))) {
        mask[i] = 1;
        corner++;
      }
    }
  }
  ok('掩码里确有半径 > 1 的角落频点', corner > 40, 'cornerBins=' + corner);

  var limited = run(N, mask, { bandMin: 0.05, bandMax: 0.95, outerLimited: true }, 'lim');
  ok('限制外径时角落被挡掉', limited.sel.count === 0, 'count=' + limited.sel.count);

  var free = run(N, mask, { bandMin: 0.05, bandMax: 0.95, outerLimited: false }, 'free');
  ok('关闭外径限制后角落可选', free.sel.count > 20, 'count=' + free.sel.count);
  ok('不限外径时同样能完整提取', free.iou > 0.98, 'IoU=' + (free.iou * 100).toFixed(1) + '%');
  ok('不限外径时仍保持共轭', free.maxImag < 1e-12, free.maxImag.toExponential(2));
})();

/* ---- 4. DC 永远不被选中 ---- */
(function () {
  var mask = new Uint8Array(N * N).fill(1);
  var r = run(N, mask, { bandMin: 0, bandMax: 0.95, outerLimited: true }, 'all');
  var dc = h * N + h;
  ok('整张画板涂满时 DC 仍被排除', !r.sel.sel[dc]);
  ok('内径为 0 时 DC 邻近点可选', r.sel.count > 100, 'count=' + r.sel.count);
})();

console.log(fails === 0 ? '\n自由绘制 / 共轭 / 外径测试全部通过' : '\n失败 ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
