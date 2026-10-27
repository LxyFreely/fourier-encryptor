/* 用真实图标在多个尺寸下走完整流程，验证扰动强度随尺寸缩放后观感一致 */
'use strict';
var fs = require('fs');
var path = require('path');
var F = require('../src/fft.js');
var C = require('../src/codec.js');

var ICON = process.argv[2] || path.join(__dirname, '..', 'demo', 'demo_A_original_16bit.png');
var OUT = path.join(__dirname, 'check');
fs.mkdirSync(OUT, { recursive: true });

/* 与 app.js 的 scaledDelta 一致：滑块值 3.0 对应 512 */
function scaledDelta(v, N) { return v * (N / 512); }

async function run(N, dump) {
  var dec = await C.decodePng(new Uint8Array(fs.readFileSync(ICON)));
  var rgb = C.ensureRgb(dec.data, 64, 64, dec.channels);
  var fitRgb = C.fitToRgb({ w: 64, h: 64, ch: 3, data: rgb }, N, 'cover');
  var fitGray = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) fitGray[i] = (fitRgb[i * 3] + fitRgb[i * 3 + 1] + fitRgb[i * 3 + 2]) / 3;

  /* 同一块相对图案：右半平面一个箭头，按比例放 */
  var half = N >> 1, k = N / 64;
  var mask = new Uint8Array(N * N);
  for (var y = 0; y < N; y++) {
    for (var x = half + 1; x < N; x++) {
      var cx = (x - half) / k, cy = (y - half) / k;
      if (Math.abs(cy) < 2 && cx > 8 && cx < 24) mask[y * N + x] = 1;
      if (Math.abs(cx - 24) < 2 && Math.abs(cy) > 4 && Math.abs(cy) < 10) mask[y * N + x] = 1;
      if (Math.abs(cx - 20) < 2 && Math.abs(cy) > 1 && Math.abs(cy) < 4) mask[y * N + x] = 1;
      if (Math.abs(cx - 16) < 2 && Math.abs(cy) > 1 && Math.abs(cy) < 3) mask[y * N + x] = 1;
    }
  }

  var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.12, bandMax: 0.95, density: 1, maxBins: 8000, seed: F.keySeed('ICON-DEMO') });
  var delta = scaledDelta(3.0, N);
  var spec = F.forward(fitGray, N);
  var B = F.embed(spec.re, spec.im, N, { mode: 'add', delta: delta, sel: sel.sel, signs: sel.signs });
  var ab = F.inverse(B);

  var outRgb = new Float32Array(N * N * 3);
  var outGray = new Float32Array(N * N);
  for (var j = 0; j < N * N; j++) {
    var dd = ab[j] - fitGray[j];
    var s = 0;
    for (var c = 0; c < 3; c++) {
      var vv = Math.min(1, Math.max(0, fitRgb[j * 3 + c] + dd));
      vv = Math.round(vv * 65535) / 65535;
      outRgb[j * 3 + c] = vv; s += vv;
    }
    outGray[j] = s / 3;
  }

  var D = F.diffMag(spec, F.forward(outGray, N), N);
  var ex = F.extract({ D: D, N: N, bandMin: 0.12, bandMax: 0.95, threshold: null });
  var iou = F.iouHalf(ex.mask, sel.sel, N);
  var psnr = F.psnr(outRgb, fitRgb);
  var maxLsb = F.maxAbsDiff(outRgb, fitRgb) * 255;

  /* 8 位量化后 */
  var g8 = new Float32Array(N * N);
  for (var q = 0; q < N * N; q++) {
    g8[q] = (Math.round(Math.min(1, Math.max(0, outRgb[q * 3])) * 255) / 255 +
             Math.round(Math.min(1, Math.max(0, outRgb[q * 3 + 1])) * 255) / 255 +
             Math.round(Math.min(1, Math.max(0, outRgb[q * 3 + 2])) * 255) / 255) / 3;
  }
  var D8 = F.diffMag(spec, F.forward(g8, N), N);
  var ex8 = F.extract({ D: D8, N: N, bandMin: 0.12, bandMax: 0.95, threshold: null });
  var iou8 = F.iouHalf(ex8.mask, sel.sel, N);

  console.log(('N=' + N).padEnd(7) + ' δ=' + delta.toFixed(3).padEnd(7) +
    ' 选点 ' + String(sel.count).padEnd(6) +
    ' PSNR ' + psnr.toFixed(1).padEnd(6) + 'dB' +
    ' 最大差 ' + maxLsb.toFixed(2).padEnd(6) + '/255' +
    ' IoU16 ' + (iou * 100).toFixed(1) + '%' +
    ' IoU8 ' + (iou8 * 100).toFixed(1) + '%');

  if (dump) {
    fs.writeFileSync(path.join(OUT, 'out_' + N + '.png'), await C.encodePng(outRgb, N, N, 3, 16));
    var dif = F.diffToBytes(D, N, 1);
    var dimg = new Float32Array(N * N);
    for (var m = 0; m < N * N; m++) dimg[m] = dif[m] / 255;
    fs.writeFileSync(path.join(OUT, 'diff_' + N + '.png'), await C.encodePng(dimg, N, N, 1, 8));
  }
}

(async function () {
  for (var N of [64, 128, 256, 512]) await run(N, N === 64);
})();
