/* CDP 驱动：跑页内自测 + 截图 + 收集控制台错误
 * 用法: node test/cdp.mjs <port> <url> <outPng>
 */
import fs from 'node:fs';

const port = process.argv[2] || '9333';
const pageUrl = process.argv[3] || ('file:///C:/Users/11952/Desktop/fourier%20encryptor/index.html?selftest=1');
const outPng = process.argv[4] || 'test/shot.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list;
for (let i = 0; i < 40; i++) {
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
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
    logs.push(m.params.type + ': ' + txt);
    if (m.params.type === 'error') errors.push(txt);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(m.params.entry.text);
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
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pageUrl });
await sleep(2500);

const probe = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({ready: !!window.__App, test: !!window.__runSelfTest, w: innerWidth, h: innerHeight})',
  returnByValue: true
});
console.log('PROBE ' + (probe.result && probe.result.result && probe.result.result.value));

const run = await send('Runtime.evaluate', {
  expression: '(async function(){ try { await window.__runSelfTest(); } catch(e) { return "THROW " + e.message; } return document.getElementById("selftest").textContent; })()',
  awaitPromise: true,
  returnByValue: true
});
const txt = run.result && run.result.result && run.result.result.value;
console.log('---- SELFTEST ----');
console.log(txt || ('(empty) ' + JSON.stringify(run).slice(0, 400)));

await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (shot.result && shot.result.data) {
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
  console.log('SCREENSHOT ' + outPng + ' ' + fs.statSync(outPng).size + ' bytes');
}

console.log('---- CONSOLE (' + logs.length + ') ----');
console.log(logs.slice(0, 20).join('\n'));
console.log('---- ERRORS (' + errors.length + ') ----');
console.log(errors.slice(0, 10).join('\n').slice(0, 2000));

ws.close();
process.exit(0);
