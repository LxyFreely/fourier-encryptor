/* 端到端：生成一套真实可分发文件 + 谜题包，供 demo/ 与 Python 交叉验证
 * node test/e2e.cjs
 */
'use strict';
var fs = require('fs');
var path = require('path');
var F = require('../src/fft.js');
var C = require('../src/codec.js');

var DEMO = path.join(__dirname, '..', 'demo');
fs.mkdirSync(DEMO, { recursive: true });

var N = 512;
var half = N >> 1;

function synth(w, h) {
  var d = new Float32Array(w * h * 3);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var u = x / w, v = y / h;
      var i = (y * w + x) * 3;
      d[i] = 0.32 + 0.28 * Math.sin(u * 8.5) * Math.cos(v * 6.2);
      d[i + 1] = 0.30 + 0.30 * Math.cos(u * 4.4 + v * 2.8);
      d[i + 2] = 0.28 + 0.26 * Math.sin((u + v) * 9.7);
      var r = Math.hypot(u - 0.6, v - 0.45);
      if (r < 0.16) { d[i] += 0.26; d[i + 1] += 0.14; d[i + 2] -= 0.08; }
      if (Math.abs(u - 0.25) < 0.035 && v > 0.2 && v < 0.8) { d[i] += 0.28; d[i + 1] += 0.28; d[i + 2] += 0.28; }
      for (var c = 0; c < 3; c++) d[i + c] = Math.min(1, Math.max(0, d[i + c]));
    }
  }
  return d;
}

var KEY = 'DEMO-FOURIER-01';
var BAND_MIN = 0.12, BAND_MAX = 0.95, DELTA = 3.0, MAXBINS = 8000;

var rgb = synth(N, N);
var gray = new Float32Array(N * N);
for (var i = 0; i < N * N; i++) gray[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;

var specA = F.forward(gray, N);

/* 右半平面画一个箭头 + 方框图案 */
var mask = new Uint8Array(N * N);
for (var yy = 0; yy < N; yy++) {
  for (var xx = half + 1; xx < N; xx++) {
    var cx = xx - half - 30, cy = yy - half;
    if (cx < 0 || cx > 250) continue;
    var onCross = (Math.abs(cy - cx * 0.55) < 9) || (Math.abs(cy + cx * 0.55) < 9);
    var onFrame = (cx > 150 && cx < 240 && Math.abs(Math.abs(cy) - 70) < 10);
    if (onCross || onFrame) mask[yy * N + xx] = 1;
  }
}

var seed = F.keySeed(KEY);
var sel = F.buildSelection({
  mask: mask, N: N, bandMin: BAND_MIN, bandMax: BAND_MAX,
  density: 1, maxBins: MAXBINS, seed: seed
});

var B = F.embed(specA.re, specA.im, N, { mode: 'add', delta: DELTA, sel: sel.sel, signs: sel.signs });
var ab = F.inverse(B);

var outRgb = new Float32Array(N * N * 3);
var outGray = new Float32Array(N * N);
for (var j = 0; j < N * N; j++) {
  var dd = ab[j] - gray[j];
  var s = 0;
  for (var c = 0; c < 3; c++) {
    var v = Math.min(1, Math.max(0, rgb[j * 3 + c] + dd));
    v = Math.round(v * 65535) / 65535;
    outRgb[j * 3 + c] = v;
    s += v;
  }
  outGray[j] = s / 3;
}

var psnr = F.psnr(outRgb, rgb);
var maxd = F.maxAbsDiff(outRgb, rgb);

/* 自检：本地重新提取 */
var D = F.diffMag(specA, F.forward(outGray, N), N);
var ex = F.extract({ D: D, N: N, bandMin: BAND_MIN, bandMax: BAND_MAX, threshold: null });
var iou = F.iouHalf(ex.mask, sel.sel, N);

(async function () {
  var comment = 'fourier-mask-arg v1 | ' + N + 'x' + N + ' | band=' +
    BAND_MIN.toFixed(2) + ',' + BAND_MAX.toFixed(2) + ' | bins=' + sel.count +
    ' | mode=add | hint: compare spectra of original and this file';

  var pngA = await C.encodePng(rgb, N, N, 3, 16);
  var pngB = C.pngAddText(await C.encodePng(outRgb, N, N, 3, 16), 'Comment', comment);
  var png8 = await C.encodePng(outRgb, N, N, 3, 8);
  var tifA = C.encodeTiff32f(rgb, N, N, 3);
  var tifB = C.encodeTiff32f(outRgb, N, N, 3);

  var truth = new Float32Array(N * N);
  for (var k = 0; k < N * N; k++) truth[k] = sel.sel[k] ? 1 : 0;
  var truthPng = await C.encodePng(truth, N, N, 1, 8);

  fs.writeFileSync(path.join(DEMO, 'demo_A_original_16bit.png'), pngA);
  fs.writeFileSync(path.join(DEMO, 'demo_B_modified_16bit.png'), pngB);
  fs.writeFileSync(path.join(DEMO, 'demo_B_modified_8bit.png'), png8);
  fs.writeFileSync(path.join(DEMO, 'demo_A_original_f32.tif'), tifA);
  fs.writeFileSync(path.join(DEMO, 'demo_B_modified_f32.tif'), tifB);
  fs.writeFileSync(path.join(DEMO, 'demo_truth_mask.png'), truthPng);

  var pack = {
    format: 'fourier-mask-arg',
    version: 1,
    createdAt: new Date().toISOString(),
    image: { name: 'demo_A_original_16bit.png', size: N, fit: 'cover' },
    band: { min: BAND_MIN, max: BAND_MAX },
    selection: { density: 1, maxBins: MAXBINS, count: sel.count, key: KEY, seed: seed },
    embed: { mode: 'add', delta: DELTA, eps: 0 },
    output: {
      format: 'png16', color: 'color',
      psnr: +psnr.toFixed(3),
      maxLsb: +(maxd * 255).toFixed(4),
      iou16: +iou.toFixed(5),
      sha256: await C.sha256Hex(pngB)
    },
    maskRle: C.rleEncode(sel.sel)
  };
  fs.writeFileSync(path.join(DEMO, 'demo_puzzle.json'), JSON.stringify(pack, null, 2));

  console.log('demo/ 已生成:');
  fs.readdirSync(DEMO).sort().forEach(function (f) {
    console.log('  ' + f.padEnd(30) + (fs.statSync(path.join(DEMO, f)).size / 1024).toFixed(1) + ' KB');
  });
  console.log('选点 ' + sel.count + ' | PSNR ' + psnr.toFixed(2) + ' dB | 最大像素差 ' +
    (maxd * 255).toFixed(2) + '/255 | 本地提取 IoU ' + (iou * 100).toFixed(2) + '%');
})();
