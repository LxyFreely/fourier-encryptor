/* PNG 文本块往返 + 第三方可读性 */
'use strict';
var fs = require('fs');
var C = require('../src/codec.js');

(async function () {
  var w = 64, h = 64;
  var d = new Float32Array(w * h * 3);
  for (var i = 0; i < w * h * 3; i++) d[i] = (i % 97) / 96;
  var png = await C.encodePng(d, w, h, 3, 16);
  var withText = C.pngAddText(png, 'Comment', 'fourier-mask-arg v1 | band=0.12,0.95 | bins=8000');
  var texts = C.pngReadText(withText);
  console.log('tEXt 数量:', texts.length, JSON.stringify(texts[0]));

  var back = await C.decodePng(withText);
  var err = 0;
  for (var j = 0; j < d.length; j++) err = Math.max(err, Math.abs(Math.round(d[j] * 65535) / 65535 - back.data[j]));
  console.log('插入文本块后仍可正常解码:', err <= 1 / 65535, 'err=' + err.toExponential(2));
  fs.mkdirSync(__dirname + '/fixtures', { recursive: true });
  fs.writeFileSync(__dirname + '/fixtures/textchunk.png', withText);
})();
