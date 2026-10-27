/* 回归测试：RGBA / 灰度+alpha PNG 的通道归一化 */
'use strict';
var C = require('../src/codec.js');

var fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

(async function () {
  var w = 8, h = 6, n = w * h;

  /* 构造一张 RGBA 图：RGB 有规律，alpha 1 和 0.5 混合 */
  var rgba = new Float32Array(n * 4);
  for (var i = 0; i < n; i++) {
    rgba[i * 4] = (i % 3) / 2;
    rgba[i * 4 + 1] = (i % 5) / 4;
    rgba[i * 4 + 2] = (i % 7) / 6;
    rgba[i * 4 + 3] = (i % 4 === 0) ? 0.5 : 1;
  }

  var png = await C.encodePng(rgba, w, h, 4, 8);
  var dec = await C.decodePng(png);
  ok('RGBA PNG 往返通道数', dec.channels === 4, 'channels=' + dec.channels);
  ok('RGBA 位深', dec.bitDepth === 8);

  /* 归一化 */
  var rgb = C.ensureRgb(dec.data, w, h, dec.channels);
  ok('归一化后长度 = w*h*3', rgb.length === n * 3, 'len=' + rgb.length);

  var maxErr = 0, alphaMismatch = 0;
  for (var j = 0; j < n; j++) {
    var a = Math.round(rgba[j * 4 + 3] * 255) / 255;
    for (var c = 0; c < 3; c++) {
      var src = Math.round(rgba[j * 4 + c] * 255) / 255;
      var expect = a >= 1 ? src : (src * a + 0.5 * (1 - a));
      maxErr = Math.max(maxErr, Math.abs(rgb[j * 3 + c] - expect));
    }
    if (a < 1) alphaMismatch++;
  }
  ok('RGB 值与 alpha 合成正确', maxErr <= 2 / 255, 'err=' + maxErr.toExponential(2) + ' 透明像素=' + alphaMismatch);

  /* 灰度图 */
  var g = new Float32Array(n);
  for (var k = 0; k < n; k++) g[k] = (k % 11) / 10;
  var gp = await C.encodePng(g, w, h, 1, 8);
  var gd = await C.decodePng(gp);
  var g3 = C.ensureRgb(gd.data, w, h, gd.channels);
  var gerr = 0;
  for (var m = 0; m < n; m++) {
    gerr = Math.max(gerr, Math.abs(g3[m * 3] - g3[m * 3 + 1]), Math.abs(g3[m * 3] - gd.data[m]));
  }
  ok('灰度图归一化后三通道一致', gerr <= 1 / 255, 'err=' + gerr.toExponential(2));

  var gray = C.ensureGray(gd.data, w, h, gd.channels);
  var gerr2 = 0;
  for (var q = 0; q < n; q++) gerr2 = Math.max(gerr2, Math.abs(gray[q] - gd.data[q]));
  ok('ensureGray 与源灰度一致', gerr2 <= 1 / 255);

  /* 关键回归：把 RGBA 数据按 3 通道读会明显错位 */
  var wrong = 0;
  for (var r = 0; r < n; r++) {
    var expect2 = Math.round(rgba[r * 4] * 255) / 255;
    if (Math.abs(dec.data[r * 3] - expect2) > 0.1) wrong++;
    if (r > 4) break;
  }
  ok('（对照）按 3 通道直读 RGBA 确实会错位', wrong > 0, '错位像素首批 ' + wrong + ' 个');

  console.log(fails === 0 ? '\nRGBA 归一化测试全部通过' : '\n失败 ' + fails + ' 项');
  process.exit(fails === 0 ? 0 : 1);
})();
