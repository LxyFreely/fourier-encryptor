var F = require('../src/fft.js');
var N = 64, half = N >> 1;
var band = F.bandTable(N);
var mask = new Uint8Array(N * N);
for (var y = 20; y < 40; y++) for (var x = half + 5; x < half + 25; x++) mask[y * N + x] = 1;
var sel = F.buildSelection({ mask: mask, N: N, bandMin: 0.05, bandMax: 0.98, density: 1, maxBins: 1e9, seed: 7 });

function info(x, y) {
  var i = y * N + x;
  var m = F.mirrorIdx(x, y, N);
  return {
    xy: x + ',' + y,
    r: band[i].toFixed(3),
    mask: mask[i], sel: sel.sel[i],
    mirrorXY: ((N - x) % N) + ',' + ((N - y) % N),
    mirrorIdx: m,
    mirrorMask: mask[m], mirrorSel: sel.sel[m],
    mirrorR: band[(m / N | 0) * N + (m % N)] === undefined ? '?' : band[((m / N) | 0) * N + (m % N)].toFixed(3)
  };
}
[info(40, 1), info(40, 30), info(37, 30), info(24, 63)].forEach(function (o) { console.log(JSON.stringify(o)); });
