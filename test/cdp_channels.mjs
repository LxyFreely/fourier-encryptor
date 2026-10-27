/* 四通道模式的浏览器端实跑：node test/cdp_channels.mjs <port> <url>
 * 需要先手动起一个带 --remote-debugging-port 的 Edge / Chrome。
 */
import fs from 'node:fs';

const port = process.argv[2] || '9333';
const pageUrl = process.argv[3] || 'file:///C:/Users/11952/Desktop/JAVAppt/.tmp_fourier/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list;
for (let i = 0; i < 60; i++) {
  try {
    list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    if (list.length) break;
  } catch (e) { /* retry */ }
  await sleep(250);
}
if (!list || !list.length) { console.log('CDP_NOT_READY'); process.exit(2); }

const target = list.find((t) => t.type === 'page') || list[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' '));
  }
};
function send(method, params) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pageUrl });
await sleep(1800);

const script = String.raw`
(async function () {
  var App = window.__App, C = window.FCodec, F = window.FCore;
  if (!App) return { fatal: 'no __App' };
  var N = 128;

  /* 1. 造一张"照片"：渐变 + 细节，写进 16 位 RGBA PNG 再当文件读入 */
  var src = new Float32Array(N * N * 4);
  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var i = y * N + x;
      src[i * 4] = 0.5 + 0.3 * Math.sin(x * 0.13) * Math.cos(y * 0.09);
      src[i * 4 + 1] = 0.45 + 0.25 * Math.cos((x + y) * 0.07);
      src[i * 4 + 2] = 0.4 + 0.2 * Math.sin(x * 0.31 + y * 0.17);
      src[i * 4 + 3] = 1.0;
    }
  }
  var srcBytes = await C.encodePng(src, N, N, 4, 16);
  var srcFile = new File([srcBytes], 'demo_src.png', { type: 'image/png' });

  await App.compute; /* noop */
  await App.loadSource(srcFile);
  if (App.S.N !== N) return { fatal: 'work size ' + App.S.N };

  /* 2. 切到四通道模式 */
  var sel = document.getElementById('selColor');
  sel.value = 'channels';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  if (App.S.color !== 'channels') return { fatal: 'colorMode did not switch' };
  if (!App.S.masks || App.S.masks.length !== 4) return { fatal: 'masks not created' };

  /* 3. 在 R 板和 A 板上各画一块不同的图案 */
  function paint(chan, cx, cy, hw, hh) {
    var half = N >> 1, m = App.S.masks[chan], added = 0;
    for (var yy = cy - hh; yy <= cy + hh; yy++) {
      for (var xx = cx - hw; xx <= cx + hw; xx++) {
        if (xx <= half || xx >= N || yy < 0 || yy >= N) continue;
        var k = yy * N + xx;
        if (!m[k]) { m[k] = 1; added++; }
      }
    }
    return added;
  }
  var aR = paint(0, (N >> 1) + 22, 40, 14, 10);
  var aA = paint(3, (N >> 1) + 20, 92, 12, 8);
  App.setChan(0);
  App.renderMask();

  /* 4. 计算 */
  await App.compute();
  var o = App.S.out;
  if (!o || !o.chans) return { fatal: 'no channel output' };

  var res = {
    color: App.S.color,
    countsPainted: [aR, aA],
    counts: o.chans.map(function (c) { return c.count; }),
    iou16: o.chans.map(function (c) { return c.iou16 === null ? null : +(c.iou16 * 100).toFixed(1); }),
    iou8: o.chans.map(function (c) { return c.iou8 === null ? null : +(c.iou8 * 100).toFixed(1); }),
    psnr: +o.psnr.toFixed(2),
    maxLsb: +(o.maxd * 255).toFixed(2),
    total: o.count
  };

  /* 5. 走一遍玩家端：原图与修改图都是 16 位 RGBA PNG */
  var fitRgba = new Float32Array(N * N * 4);
  for (var j = 0; j < N * N; j++) {
    for (var c0 = 0; c0 < 4; c0++) fitRgba[j * 4 + c0] = App.S.chanFit[c0][j];
  }
  var aBytes = await C.encodePng(fitRgba, N, N, 4, 16);
  var bBytes = await C.encodePng(o.rgba, N, N, 4, 16);

  var dm = document.getElementById('decMode');
  dm.value = 'channels';
  dm.dispatchEvent(new Event('change', { bubbles: true }));

  await App.decLoad('a', new File([aBytes], 'a.png', { type: 'image/png' }));
  await App.decLoad('b', new File([bBytes], 'b.png', { type: 'image/png' }));

  var D = App.S.dec;
  if (!D.results) return { fatal: 'no decode results', res: res };
  res.decBins = D.results.map(function (r) { return r.empty ? 'empty' : r.bins; });
  res.decPackIoU = null;

  /* 6. 谜题包往返：载入后应该自动切到四通道模式并给出 IoU */
  var pack = App.buildPack();
  res.packChannels = pack.output.channels;
  res.packMaskCounts = pack.channelCounts;
  res.packRleCount = pack.channelMasks ? pack.channelMasks.length : 0;
  return res;
})()
`;

const run = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
const val = run.result && run.result.result && run.result.result.value;
console.log('RESULT ' + JSON.stringify(val, null, 1));
if (run.result && run.result.exceptionDetails) console.log('EXC ' + JSON.stringify(run.result.exceptionDetails).slice(0, 600));

/* 可选：截图前切到「差分图」页签，看四通道合成效果 */
if (process.argv[5] === 'diff') {
  await send('Runtime.evaluate', { expression: "document.getElementById('outTabDiff').click()" });
  await sleep(400);
}

await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (shot.result && shot.result.data) {
  fs.writeFileSync(process.argv[4] || 'test/shot_channels.png', Buffer.from(shot.result.data, 'base64'));
  console.log('SCREENSHOT ' + (process.argv[4] || 'test/shot_channels.png'));
}
console.log('ERRORS ' + errors.length);
if (errors.length) console.log(errors.slice(0, 6).join('\n'));
ws.close();
process.exit(0);
