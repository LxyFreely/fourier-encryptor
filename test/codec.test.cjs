/* 编解码层自测：node test/codec.test.cjs */
'use strict';
var F = require('../src/fft.js');
var C = require('../src/codec.js');
var fs = require('fs');
var path = require('path');
var FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

var fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); fails++; }
}

function makeImage(w, h, ch, seed) {
  var d = new Float32Array(w * h * ch);
  var s = seed || 1;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      for (var c = 0; c < ch; c++) {
        var v = 0.5 + 0.3 * Math.sin((x + c * 7) * 0.11) * Math.cos(y * 0.09) + 0.04 * rnd();
        d[(y * w + x) * ch + c] = Math.min(1, Math.max(0, v));
      }
    }
  }
  return d;
}

(async function () {
  var w = 37, h = 23; /* 非 2 的幂，故意刁难 */

  /* --- 16 位灰度 PNG --- */
  var g = makeImage(w, h, 1, 7);
  var png16 = await C.encodePng(g, w, h, 1, 16);
  var back = await C.decodePng(png16);
  var err16 = 0;
  for (var i = 0; i < g.length; i++) {
    var q = Math.round(g[i] * 65535) / 65535;
    err16 = Math.max(err16, Math.abs(q - back.data[i]));
  }
  ok('16 位灰度 PNG 往返 (bits=' + back.bitDepth + ')', err16 <= 1 / 65535 && back.width === w && back.channels === 1, 'err=' + err16.toExponential(2));
  fs.writeFileSync(path.join(FIX, 'out_gray16.png'), png16);

  /* --- 16 位 RGB PNG --- */
  var rgb = makeImage(w, h, 3, 11);
  var pngRgb = await C.encodePng(rgb, w, h, 3, 16);
  var backRgb = await C.decodePng(pngRgb);
  var err3 = 0;
  for (var j = 0; j < rgb.length; j++) {
    var q3 = Math.round(rgb[j] * 65535) / 65535;
    err3 = Math.max(err3, Math.abs(q3 - backRgb.data[j]));
  }
  ok('16 位 RGB PNG 往返 (ch=' + backRgb.channels + ')', err3 <= 1 / 65535, 'err=' + err3.toExponential(2));
  fs.writeFileSync(path.join(FIX, 'out_rgb16.png'), pngRgb);

  /* --- 8 位 PNG --- */
  var png8 = await C.encodePng(g, w, h, 1, 8);
  fs.writeFileSync(path.join(FIX, 'out_gray8.png'), png8);
  var back8 = await C.decodePng(png8);
  var err8 = 0;
  for (var k = 0; k < g.length; k++) err8 = Math.max(err8, Math.abs(Math.round(g[k] * 255) / 255 - back8.data[k]));
  ok('8 位灰度 PNG 往返', err8 <= 1 / 255, 'err=' + err8.toExponential(2));

  /* --- float32 TIFF --- */
  var tif = C.encodeTiff32f(rgb, w, h, 3);
  var bt = C.decodeTiff32f(tif);
  var errT = 0;
  for (var m = 0; m < rgb.length; m++) errT = Math.max(errT, Math.abs(rgb[m] - bt.data[m]));
  ok('float32 RGB TIFF 往返', errT === 0 && bt.channels === 3, 'err=' + errT.toExponential(2) + ' bits=' + bt.bitDepth);
  fs.writeFileSync(path.join(FIX, 'out_rgb_f32.tif'), tif);

  var tifG = C.encodeTiff32f(g, w, h, 1);
  var btG = C.decodeTiff32f(tifG);
  var errTG = 0;
  for (var n = 0; n < g.length; n++) errTG = Math.max(errTG, Math.abs(g[n] - btG.data[n]));
  ok('float32 灰度 TIFF 往返', errTG === 0 && btG.channels === 1, 'err=' + errTG.toExponential(2));
  fs.writeFileSync(path.join(FIX, 'out_gray_f32.tif'), tifG);

  /* --- RLE --- */
  var mask = new Uint8Array(10000);
  for (var p = 3000; p < 3050; p++) mask[p] = 1;
  for (var p2 = 7000; p2 < 7007; p2++) mask[p2] = 1;
  var r = C.rleEncode(mask);
  var br = C.rleDecode(r, mask.length);
  var same = true;
  for (var q4 = 0; q4 < mask.length; q4++) if (mask[q4] !== br[q4]) { same = false; break; }
  ok('掩码 RLE 往返', same, 'base64 长度=' + r.length);

  /* --- SHA-256 --- */
  var h264 = await C.sha256Hex(new Uint8Array([0x61, 0x62, 0x63]));
  ok('SHA-256 正确', h264 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', h264.slice(0, 16) + '...');

  console.log(fails === 0 ? '\n编解码自测全部通过' : '\n失败 ' + fails + ' 项');
  process.exit(fails === 0 ? 0 : 1);
})();
