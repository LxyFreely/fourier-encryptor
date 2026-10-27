/* =========================================================================
 * 页内自测：open index.html?selftest=1
 * 用合成图跑完整链路（嵌入 -> 解码 -> 提取 -> 比对），结果写入 DOM。
 * 用于开发验证，不影响正常使用。
 * ========================================================================= */
(function () {
  'use strict';

  var LINES = [];
  var FAILS = 0;

  function log(ok, msg) {
    if (!ok) FAILS++;
    LINES.push((ok ? 'ok   ' : 'FAIL ') + msg);
    flush();
  }

  var QUIET = /quiet/.test(location.search);

  function flush() {
    if (QUIET) {
      document.title = (FAILS ? 'SELFTEST-FAIL' : 'SELFTEST-PASS') + ' | ' + LINES.length;
      window.__selftestResult = LINES.join(String.fromCharCode(10));
      return;
    }
    var el = document.getElementById('selftest');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'selftest';
      el.style.cssText = 'position:fixed;left:0;bottom:0;z-index:999;max-height:45vh;overflow:auto;' +
        'background:#0a0d13ee;color:#9fe;font:11px/1.5 Consolas,monospace;padding:8px;' +
        'margin:0;border-top:1px solid #35e0d0;width:100%;white-space:pre-wrap';
      document.body.appendChild(el);
    }
    el.textContent = 'SELFTEST ' + (FAILS ? 'FAIL(' + FAILS + ')' : 'PASS') + '\n' + LINES.join('\n');
    document.title = (FAILS ? 'SELFTEST-FAIL' : 'SELFTEST-PASS') + ' | ' + LINES.length;
  }

  /* 合成一张有纹理的测试图（避免外部文件依赖） */
  function synthImage(w, h) {
    var d = new Float32Array(w * h * 3);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var u = x / w, v = y / h;
        var r = 0.30 + 0.30 * Math.sin(u * 9.0) * Math.cos(v * 7.0);
        var g = 0.28 + 0.32 * Math.cos(u * 5.0 + v * 3.0);
        var b = 0.26 + 0.30 * Math.sin((u + v) * 11.0);
        var ring = Math.hypot(u - 0.62, v - 0.42);
        if (ring < 0.18) { r += 0.25; g += 0.15; b -= 0.10; }
        var bar = (Math.abs(u - 0.22) < 0.03 && v > 0.2 && v < 0.8);
        if (bar) { r += 0.3; g += 0.3; b += 0.3; }
        var i = (y * w + x) * 3;
        d[i] = Math.min(1, Math.max(0, r));
        d[i + 1] = Math.min(1, Math.max(0, g));
        d[i + 2] = Math.min(1, Math.max(0, b));
      }
    }
    return d;
  }

  function waitFor(pred, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (pred()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(poll, 30);
      })();
    });
  }

  function stampText(text, size) {
    var App = window.__App, S = App.S, N = S.N, half = N >> 1;
    var cv = document.createElement('canvas');
    cv.width = N;
    cv.height = N;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, N, N);
    ctx.fillStyle = '#fff';
    ctx.font = '700 ' + size + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, N * 0.72, N * 0.52);
    var d = ctx.getImageData(0, 0, N, N).data;
    var added = 0;
    var band = App.F.bandTable(N);
    var bandMin = +document.getElementById('bandMin').value;
    var bandMax = +document.getElementById('bandMax').value;
    for (var y = 0; y < N; y++) {
      for (var x = half + 1; x < N; x++) {
        var i = y * N + x;
        if (d[i * 4] < 110) continue;
        var b = band[i];
        if (b < bandMin || b > bandMax) continue;
        if (!S.mask[i]) added++;
        S.mask[i] = 1;
      }
    }
    return added;
  }

  var RAN = false;
  window.__runSelfTest = async function () {
    if (RAN) return window.__selftestResult || '';
    RAN = true;
    var App = window.__App, S = App.S, F = App.F, C = App.C;
    log(!!F && !!C, '模块加载 FCore/FCodec');
    log(typeof CompressionStream === 'function', 'CompressionStream 可用（16 位 PNG 依赖）');

    try {
      /* ---- 1. 载入合成图 ---- */
      var W = 600, H = 400;
      var rgb = synthImage(W, H);
      var png8 = await C.encodePng(rgb, W, H, 3, 8);
      var fileA = new File([png8], 'selftest-src.png', { type: 'image/png' });
      await App.loadSource(fileA);
      log(S.src && S.src.w === W && S.src.h === H, '读入源图 ' + W + 'x' + H + ' -> 工作尺寸 ' + S.N);
      log(!!S.specA, '源图频谱已计算');

      /* ---- 2. 画板落字 ---- */
      var added = stampText('ARG', 110);
      App.renderMask();
      log(added > 200, '文字写入画板 ' + added + ' 个频点');
      await App.compute();

      var o = S.out;
      log(!!o && o.count > 100, '生成选点 ' + (o ? o.count : 0) + ' 个');
      log(o && o.psnr > 40, 'PSNR ' + (o ? o.psnr.toFixed(2) : '-') + ' dB');
      log(o && o.maxd * 255 < 5, '最大像素差 ' + (o ? (o.maxd * 255).toFixed(2) : '-') + ' / 255');
      log(o && o.iou16 > 0.98, '16 位提取 IoU ' + (o ? (o.iou16 * 100).toFixed(1) : '-') + '%');
      log(o && o.iou8 > 0.9, '8 位提取 IoU ' + (o ? (o.iou8 * 100).toFixed(1) : '-') + '%');
      log(o && o.margin > 3, '8 位检测余量 ' + (o ? o.margin.toFixed(1) : '-') + ' sigma');

      /* ---- 3. 导出 -> 重新读入 -> 独立解码 ---- */
      var ch = o.color === 'color' ? 3 : 1;
      var outData = o.color === 'color' ? o.rgb : o.gray;
      var png16 = await C.encodePng(outData, S.N, S.N, ch, 16);
      var backB = await C.decodePng(png16);
      var maxErr = 0;
      for (var i = 0; i < backB.data.length; i++) {
        var q = Math.round(outData[i] * 65535) / 65535;
        maxErr = Math.max(maxErr, Math.abs(q - backB.data[i]));
      }
      log(maxErr <= 1 / 65535, '16 位 PNG 往返误差 ' + maxErr.toExponential(2));
      log(backB.bitDepth === 16, '重新读回的位深 = ' + backB.bitDepth);

      var tif = C.encodeTiff32f(outData, S.N, S.N, ch);
      var backT = C.decodeTiff32f(tif);
      var e2 = 0;
      for (var j = 0; j < backT.data.length; j++) e2 = Math.max(e2, Math.abs(backT.data[j] - outData[j]));
      log(e2 === 0, 'float32 TIFF 往返误差 ' + e2.toExponential(2));

      /* ---- 4. 解码端：拿两份文件做玩家流程 ---- */
      var srcPng16 = await C.encodePng(S.fitRgb, S.N, S.N, 3, 16);
      var fileA2 = new File([srcPng16], 'dec-A.png', { type: 'image/png' });
      var fileB2 = new File([png16], 'dec-B.png', { type: 'image/png' });

      var r1 = await App.readImageFile(fileA2);
      var r2 = await App.readImageFile(fileB2);
      log(r1.bitDepth === 16 && r2.bitDepth === 16, '解码端读入两张 16 位图');

      /* 走一遍真实的解码 UI 流程 */
      var inpA = document.getElementById('decInputA');
      var inpB = document.getElementById('decInputB');
      var dtA = new DataTransfer(); dtA.items.add(fileA2);
      var dtB = new DataTransfer(); dtB.items.add(fileB2);
      inpA.files = dtA.files;
      inpB.files = dtB.files;
      inpA.dispatchEvent(new Event('change'));
      await waitFor(function () { return !!S.dec.a; }, 4000);
      inpB.dispatchEvent(new Event('change'));
      var done = await waitFor(function () { return !!S.dec.result; }, 8000);
      log(done, '解码端完成提取');

      var got = S.dec.result;
      var iou = got ? F.iouHalf(got.mask, S.out.sel.sel, S.dec.N) : 0;
      log(iou > 0.98, '玩家流程回读 IoU ' + (iou * 100).toFixed(1) + '%（' + (got ? got.bins : 0) + ' 点）');
      log(got && got.bins > 0, '提取到频点 ' + (got ? got.bins : 0) + ' 个');

      /* ---- 5. 谜题包 ---- */
      var pack = App.buildPack();
      log(pack.format === 'fourier-mask-arg' && pack.maskRle.length > 10, '谜题包字段完整（maskRle ' + pack.maskRle.length + ' 字符）');
      var pm = C.rleDecode(pack.maskRle, S.N * S.N);
      var iouPack = F.iouHalf(pm, S.out.sel.sel, S.N);
      log(iouPack > 0.999, '谜题包掩码往返 IoU ' + (iouPack * 100).toFixed(1) + '%');

      /* ---- 6. 参数敏感性：8 位存不活的例子 ---- */
      document.getElementById('strength').value = String(200);
      document.getElementById('selMode').value = 'add';
      await App.compute();
      log(S.out.count > 0, '低强度重算正常（δ=' + S.out.params.delta.toFixed(4) + ', 8 位 IoU ' + (S.out.iou8 * 100).toFixed(1) + '%）');

      document.getElementById('strength').value = String(656);
      await App.compute();
      log(S.out.iou8 > 0.9, '恢复默认强度后 8 位 IoU ' + (S.out.iou8 * 100).toFixed(1) + '%');

      log(true, '绘图画布检查: ' + ['cvSpec', 'cvMask', 'cvHud'].map(function (id) {
        var c = document.getElementById(id);
        return id + '=' + c.width + 'x' + c.height;
      }).join(' '));
    } catch (e) {
      console.error(e);
      log(false, '异常: ' + (e && e.message ? e.message : e));
      if (e && e.stack) LINES.push(e.stack.split('\n').slice(0, 4).join('\n'));
    }

    flush();
    if (!QUIET) {
      var box = document.getElementById('selftest');
      if (box) box.scrollIntoView();
    }
    return window.__selftestResult || '';
  };
})();
