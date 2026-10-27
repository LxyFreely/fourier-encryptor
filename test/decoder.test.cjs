/* 玩家流程测试：原图与修改图尺寸不同（64x64 -> 512x512）也必须能解出来
 * 这是真实场景：ARG 作者拿一个服务器图标藏在 512 的输出里。
 */
'use strict';
var F = require('../src/fft.js');
var C = require('../src/codec.js');

var fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

/* 造一张 64x64 的 RGBA 像素图（带透明像素） */
function makeIcon(w, h) {
  var d = new Float32Array(w * h * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var band = Math.floor(y / 8) % 4;
      var c = [[0.60, 0.85, 0.92], [1, 1, 1], [1, 0.49, 0], [0.30, 0.43, 0.95]][band];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      d[i + 3] = (x + y > 90) ? 0.5 : 1; /* 一部分半透明 */
    }
  }
  return d;
}

(async function () {
  var W = 64, H = 64, N = 512;
  var rgba = makeIcon(W, H);
  var iconPng = await C.encodePng(rgba, W, H, 4, 8);

  /* ---- 编码端：与 app.js readImageFile 一致 ---- */
  var dec = await C.decodePng(iconPng);
  var rgb = C.ensureRgb(dec.data, W, H, dec.channels);
  ok('源图归一化为 3 通道', rgb.length === W * H * 3);

  var fitRgb = C.fitToRgb({ w: W, h: H, ch: 3, data: rgb }, N, 'cover');
  var fitGray = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) fitGray[i] = (fitRgb[i * 3] + fitRgb[i * 3 + 1] + fitRgb[i * 3 + 2]) / 3;

  /* 右半平面画一个十字 */
  var half = N >> 1;
  var mask = new Uint8Array(N * N);
  for (var y = 0; y < N; y++) {
    for (var x = half + 1; x < N; x++) {
      var cx = x - half, cy = y - half;
      if (Math.abs(cx - 120) < 70 && Math.abs(cy) < 7) mask[y * N + x] = 1;
      if (Math.abs(cy) < 70 && Math.abs(cx - 120) < 7) mask[y * N + x] = 1;
    }
  }

  var seed = F.keySeed('ICON-TEST');
  var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.12, bandMax: 0.95, density: 1, maxBins: 8000, seed: seed });
  ok('选点生成', sel.count > 500, 'count=' + sel.count);

  var specA = F.forward(fitGray, N);
  var B = F.embed(specA.re, specA.im, N, { mode: 'add', delta: 3, sel: sel.sel, signs: sel.signs });
  var ab = F.inverse(B);

  var outRgb = new Float32Array(N * N * 3);
  var outGray = new Float32Array(N * N);
  for (var j = 0; j < N * N; j++) {
    var dd = ab[j] - fitGray[j];
    var s = 0;
    for (var c = 0; c < 3; c++) {
      var v = Math.min(1, Math.max(0, fitRgb[j * 3 + c] + dd));
      v = Math.round(v * 65535) / 65535;
      outRgb[j * 3 + c] = v;
      s += v;
    }
    outGray[j] = s / 3;
  }
  ok('视觉无损', F.psnr(outRgb, fitRgb) > 50, 'psnr=' + F.psnr(outRgb, fitRgb).toFixed(2) + ' dB');

  var bPng = await C.encodePng(outRgb, N, N, 3, 16);

  /* ---- 玩家端：只有 64x64 的原图 + 512x512 的修改图 ---- */
  var aDec = await C.decodePng(iconPng);
  var bDec = await C.decodePng(bPng);
  ok('两张图尺寸确实不同', aDec.width === 64 && bDec.width === 512, aDec.width + ' vs ' + bDec.width);

  var aGray = C.ensureGray(aDec.data, aDec.width, aDec.height, aDec.channels);
  var bGray = C.ensureGray(bDec.data, bDec.width, bDec.height, bDec.channels);

  /* 解码端：以修改图为准定 N，再把原图按 cover 适配过去 */
  var Ndec = bDec.width;
  var gA = C.fitToGray(aGray, 64, 64, Ndec, 'cover');
  var D = F.diffMag(F.forward(gA, Ndec), F.forward(bGray, Ndec), Ndec);
  var ex = F.extract({ D: D, N: Ndec, bandMin: 0.12, bandMax: 0.95, threshold: null });
  var iou = F.iouHalf(ex.mask, sel.sel, Ndec);
  ok('尺寸不一致也能提取', iou > 0.98, 'IoU=' + (iou * 100).toFixed(1) + '% bins=' + ex.bins + '/' + (sel.count * 2));

  /* ---- 同尺寸（64x64 工作尺寸）也能走通 ---- */
  var N2 = 64;
  var fitGray2 = C.fitToGray(aGray, 64, 64, N2, 'cover');
  var fitRgb2 = C.fitToRgb({ w: 64, h: 64, ch: 3, data: rgb }, N2, 'cover');
  var spec2 = F.forward(fitGray2, N2);
  /* 为 64x64 单独画掩码：右半平面只有 31 列可用 */
  var half2 = N2 >> 1;
  var mask2 = new Uint8Array(N2 * N2);
  for (var y3 = 0; y3 < N2; y3++) {
    for (var x3 = half2 + 1; x3 < N2; x3++) {
      var cx3 = x3 - half2, cy3 = y3 - half2;
      if (Math.abs(cx3 - 16) < 2 && Math.abs(cy3) < 14) mask2[y3 * N2 + x3] = 1;
      if (Math.abs(cy3) < 2 && Math.abs(cx3 - 16) < 12) mask2[y3 * N2 + x3] = 1;
    }
  }
  var sel2 = F.buildSelection({ mask: mask2, N: N2, bandMin: 0.12, bandMax: 0.95, density: 1, maxBins: 8000, seed: seed });
  var B2 = F.embed(spec2.re, spec2.im, N2, { mode: 'add', delta: 3, sel: sel2.sel, signs: sel2.signs });
  var ab2 = F.inverse(B2);
  var og2 = new Float32Array(N2 * N2);
  var or2 = new Float32Array(N2 * N2 * 3);
  for (var k = 0; k < N2 * N2; k++) {
    var d2 = ab2[k] - fitGray2[k];
    var s2 = 0;
    for (var c2 = 0; c2 < 3; c2++) {
      var v2 = Math.min(1, Math.max(0, fitRgb2[k * 3 + c2] + d2));
      v2 = Math.round(v2 * 65535) / 65535;
      or2[k * 3 + c2] = v2; s2 += v2;
    }
    og2[k] = s2 / 3;
  }
  var png64 = await C.encodePng(or2, N2, N2, 3, 16);
  var b64 = await C.decodePng(png64);
  var bg64 = C.ensureGray(b64.data, N2, N2, b64.channels);
  var D2 = F.diffMag(F.forward(fitGray2, N2), F.forward(bg64, N2), N2);
  var ex2 = F.extract({ D: D2, N: N2, bandMin: 0.12, bandMax: 0.95, threshold: null });
  var iou2 = F.iouHalf(ex2.mask, sel2.sel, N2);
  ok('64x64 工作尺寸同样可解', iou2 > 0.98, 'IoU=' + (iou2 * 100).toFixed(1) + '% count=' + sel2.count);

  console.log(fails === 0 ? '\n玩家流程测试全部通过' : '\n失败 ' + fails + ' 项');
  process.exit(fails === 0 ? 0 : 1);
})();
