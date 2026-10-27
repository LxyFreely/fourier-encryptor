var F = require('../src/fft.js');
var N = 64, half = N >> 1;
var mask = new Uint8Array(N * N);
for (var y = 20; y < 40; y++) for (var x = half + 5; x < half + 25; x++) mask[y * N + x] = 1;
var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.05, bandMax: 0.98, density: 1, maxBins: 1e9, seed: 7 });
console.log('count(pairs) =', sel.count);
var bits = 0, asym = 0;
for (var y2 = 0; y2 < N; y2++) for (var x2 = 0; x2 < N; x2++) {
  var i = y2 * N + x2;
  if (!sel.sel[i]) continue;
  bits++;
  var mi = F.mirrorIdx(x2, y2, N);
  if (!sel.sel[mi]) asym++;
}
console.log('sel bits =', bits, 'asymmetric =', asym);

// 嵌入并检查差分的分布
var img = new Float32Array(N * N);
for (var k = 0; k < N * N; k++) img[k] = 0.3 + 0.1 * Math.random();
var A = F.forward(img, N);
var B = F.embed(A.re, A.im, N, { mode: 'add', delta: 1, sel: sel.sel, signs: sel.signs });
var D = F.diffMag(A, B, N);
var strong = 0, weakSel = 0, weakAt = [];
for (var yy = 0; yy < N; yy++) for (var xx = 0; xx < N; xx++) {
  var idx = yy * N + xx;
  if (D[idx] > 0.5) strong++;
  if (sel.sel[idx] && D[idx] <= 0.5) { weakSel++; if (weakAt.length < 6) weakAt.push([xx, yy, D[idx].toFixed(3)]); }
}
console.log('D>0.5 bins =', strong, ' selected-but-weak =', weakSel, JSON.stringify(weakAt));
