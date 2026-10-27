/* =========================================================================
 * 频域隐写工作台 —— 应用逻辑
 * 依赖 src/fft.js (FCore) 与 src/codec.js (FCodec)
 * ========================================================================= */
(function () {
  'use strict';

  var F = window.FCore;
  var C = window.FCodec;

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function tick() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function fmt(n, d) {
    if (!isFinite(n)) return '∞';
    return n.toFixed(d === undefined ? 2 : d);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function download(bytes, name, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  function downloadText(text, name, mime) {
    download(new TextEncoder().encode(text), name, mime || 'text/plain;charset=utf-8');
  }

  var statusTimer = null;
  function setStatus(txt, cls) {
    var el = $('status');
    el.textContent = txt;
    el.className = 'status' + (cls ? ' ' + cls : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (cls === 'ok') statusTimer = setTimeout(function () { el.className = 'status'; }, 2500);
  }

  function boardHint(txt, warn) {
    var el = $('boardHint');
    el.textContent = txt || '';
    el.className = 'board-hint' + (warn ? ' warn' : '');
  }

  /* ===================================================================
   * 状态
   * =================================================================== */

  /* 四通道模式：R / G / B / A 各有一块独立的傅里叶画板，互不干扰 */
  var CH_KEYS = ['R', 'G', 'B', 'A'];
  var CH_NAMES = ['红 R', '绿 G', '蓝 B', '透明 A'];
  var CH_COLORS = [[255, 92, 110], [86, 226, 138], [96, 170, 255], [232, 232, 232]];

  var S = {
    N: 512,
    fit: 'cover',
    src: null,
    fitGray: null,
    fitRgb: null,
    specA: null,
    band: null,
    color: 'color',                  /* 'color' | 'gray' | 'channels' */
    mask: new Uint8Array(512 * 512),  /* 永远指向"当前这块画板"，绘制代码只认它 */
    singleMask: new Uint8Array(512 * 512),
    masks: null,                     /* 四通道模式：4 块画板 */
    chan: 0,                         /* 当前画板通道 0..3 */
    chanFit: null,                   /* 四通道工作图：4 × (N×N) */
    chanSpec: null,                  /* 四通道频谱：4 × { re, im, N } */
    undo: [],
    redo: [],
    tool: 'brush',
    brush: 14,
    out: null,
    view: 'img',
    auto: true,
    running: false,
    pending: false,
    calcId: 0,
    dec: {
      a: null, b: null, pack: null, N: 0, D: null, result: null,
      mode: 'gray', Ds: null, results: null, viewChan: 'all'
    }
  };

  /* --------------------------------------------------- 掩码 / 画板绑定 */

  function chanMode() { return S.color === 'channels'; }

  function ensureMasks() {
    var n = S.N * S.N;
    if (!S.masks || S.masks[0].length !== n) {
      S.masks = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
      if (S.chan < 0 || S.chan > 3) S.chan = 0;
    }
    return S.masks;
  }

  /* 灰度模式用 singleMask，四通道模式用 masks[chan]；S.mask 始终指向其中一个 */
  function bindMask() {
    if (chanMode()) { ensureMasks(); S.mask = S.masks[S.chan]; }
    else { S.mask = S.singleMask; }
  }

  function setMaskArray(arr) {
    if (chanMode()) { ensureMasks(); S.masks[S.chan] = arr; }
    else S.singleMask = arr;
    bindMask();
  }

  /* 工作尺寸变化：把灰度板和四块通道板一起缩放，别把已经画好的东西丢掉 */
  function resizeMasks(N, oldN) {
    function scale(arr) {
      var next = new Uint8Array(N * N);
      if (!arr || !oldN || arr.length !== oldN * oldN) return next;
      var s = N / oldN;
      for (var y = 0; y < oldN; y++) {
        for (var x = 0; x < oldN; x++) {
          if (!arr[y * oldN + x]) continue;
          var nx = Math.min(N - 1, Math.floor(x * s));
          var ny = Math.min(N - 1, Math.floor(y * s));
          next[ny * N + nx] = 1;
        }
      }
      return next;
    }
    S.singleMask = scale(S.singleMask);
    if (S.masks) S.masks = S.masks.map(scale);
    bindMask();
  }

  /*
   * 切换色彩处理方式。
   * 从灰度/彩色切到四通道时，把原来那块单板子搬进 R 通道，
   * 这样已经画好的图案不会凭空消失；四块板子之后各管各的信息。
   */
  function setColorMode(v) {
    var was = S.color;
    S.color = v;
    var rowChan = $('chanRow');
    if (rowChan) rowChan.classList.toggle('hidden', v !== 'channels');
    if (v === 'channels') {
      ensureMasks();
      if (was !== 'channels' && S.singleMask && S.singleMask.length === S.N * S.N) {
        S.masks[0] = Uint8Array.from(S.singleMask);
      }
      bindMask();
      updateChanTabs();
      if (S.src) {
        rebuildFit();
        renderSource();
        renderSpec();
        renderMask();
        renderHud();
        boardHint('四通道模式：R / G / B / A 各有一块画板，各自藏一份信息。A 通道（透明）的频谱底色偏黑是正常的。');
      }
      updateParamsMeta();
    } else {
      bindMask();
      if (S.src) {
        rebuildFit();
        renderSource();
        renderSpec();
        renderMask();
        renderHud();
      }
      updateParamsMeta();
      if (was === 'channels') boardHint('已切回单幅频谱：' + (v === 'color' ? '彩色 RGB（等量扰动三通道）' : '灰度输出'));
    }
    scheduleCompute(60);
  }

  var CHAN_HINTS = [
    '红 R 通道画板',
    '绿 G 通道画板',
    '蓝 B 通道画板',
    '透明 A 通道画板（频谱基本只有直流分量，底色发黑属正常）'
  ];

  /* 切到某一块通道画板 */
  function setChan(c) {
    if (!chanMode()) return;
    S.chan = ((c % 4) + 4) % 4;
    bindMask();
    renderSpec();
    renderMask();
    renderHud();
    updateChanTabs();
    boardHint('当前画板：' + CHAN_HINTS[S.chan]);
  }

  /* 通道切换条上的高亮与每块板子的选点数 */
  function updateChanTabs() {
    var counts = chanCounts();
    for (var c = 0; c < 4; c++) {
      var btn = $('chan' + c);
      if (!btn) continue;
      btn.classList.toggle('active', c === S.chan);
      var badge = btn.querySelector('.chan-count');
      if (badge) badge.textContent = counts[c] ? counts[c] : '';
      btn.title = CH_NAMES[c] + '：' + counts[c] + ' 个频点';
    }
  }

  /* 每块画板上画了多少个频点（不含密度/上限筛选，纯手绘面积） */
  function chanCounts() {
    var out = [0, 0, 0, 0], n = S.N * S.N;
    if (!chanMode() || !S.masks) {
      var c0 = 0;
      for (var i = 0; i < n; i++) if (S.singleMask[i]) c0++;
      out[0] = c0;
      return out;
    }
    for (var c = 0; c < 4; c++) {
      var m = S.masks[c], k = 0;
      for (var j = 0; j < n; j++) if (m[j]) k++;
      out[c] = k;
    }
    return out;
  }

  function updateParamsMeta() {
    var el = $('colorMeta');
    if (!el) return;
    var map = { color: '保留彩色（等量扰动 RGB）', gray: '灰度输出', channels: '四通道独立（R/G/B/A）' };
    el.textContent = map[S.color] || '';
  }

  var ctxSpec, ctxMask, ctxHud, ctxSrc, ctxOut;
  var specImg, maskImg, outImg, srcImg;

  /* ===================================================================
   * 参数
   * =================================================================== */

  var LOG_LO = Math.log(0.001), LOG_HI = Math.log(200);

  function strengthFromSlider(s) {
    return Math.exp(LOG_LO + (s / 1000) * (LOG_HI - LOG_LO));
  }

  /*
   * 扰动强度按工作尺寸缩放。
   * 理由：像素上的改动量约为 δ·√M/N²，8 位量化在频域的等效噪声约为 N/255/√12，
   * 两者对 N 的依赖一致，所以令 δ ∝ N 就能让"视觉冲击"和"8 位存活余量"在
   * 64 / 128 / 256 / 512 / 1024 之间保持恒定。滑块数值对应 512 尺寸下的 δ。
   */
  function scaledDelta(v, N) {
    return v * (N / 512);
  }

  function readParams() {
    var v = strengthFromSlider(+$('strength').value);
    var N = +$('selN').value;
    return {
      N: N,
      fit: $('selFit').value,
      bandMin: +$('bandMin').value,
      bandMax: +$('bandMax').value,
      outerLimited: $('chkOuter') ? $('chkOuter').checked : true,
      density: +$('density').value / 100,
      maxBins: +$('maxBins').value,
      mode: $('selMode').value,
      delta: scaledDelta(v, N),
      eps: v / 100,
      key: $('keyInput').value,
      color: $('selColor').value
    };
  }

  /* 频点是否可编辑：只受内径约束；外径只在"限制外径"打开时生效 */
  function inBand(r, p) {
    if (r < p.bandMin) return false;
    return p.outerLimited ? (r <= p.bandMax) : true;
  }

  /* 传给提取器的外径上限：不限制时给一个大于最大半径（√2）的值 */
  function bandMaxEff(p) {
    return p.outerLimited ? p.bandMax : 2;
  }

  function strengthLabel() {
    var v = strengthFromSlider(+$('strength').value);
    if ($('selMode').value === 'mul') return 'ε=' + v.toFixed(4);
    var d = scaledDelta(v, +$('selN').value);
    return 'δ=' + (d >= 0.1 ? d.toFixed(2) : d.toFixed(3));
  }

  /* ===================================================================
   * 画布
   * =================================================================== */

  function initCanvases() {
    ctxSpec = $('cvSpec').getContext('2d');
    ctxMask = $('cvMask').getContext('2d');
    ctxHud = $('cvHud').getContext('2d');
    ctxSrc = $('cvSrc').getContext('2d');
    ctxOut = $('cvOut').getContext('2d');
    resizeCanvases(S.N);
  }

  function resizeCanvases(N) {
    ['cvSpec', 'cvMask', 'cvHud', 'cvSrc', 'cvOut'].forEach(function (id) {
      var c = $(id);
      c.width = N;
      c.height = N;
    });
    /* HUD 是纯装饰层，用较高分辨率绘制，N 很小时标注才不会糊 */
    var H = Math.max(N, 512);
    $('cvHud').width = H;
    $('cvHud').height = H;
    specImg = ctxSpec.createImageData(N, N);
    maskImg = ctxMask.createImageData(N, N);
    outImg = ctxOut.createImageData(N, N);
    srcImg = ctxSrc.createImageData(N, N);
    $('boardSizeLabel').textContent = N + ' × ' + N + ' · 频域';
  }

  /* ===================================================================
   * 调色板
   * =================================================================== */

  var LUT = null;
  function buildLut() {
    var stops = [
      [0.00, 4, 6, 10],
      [0.30, 26, 40, 96],
      [0.55, 44, 132, 168],
      [0.78, 120, 216, 208],
      [0.92, 224, 255, 250],
      [1.00, 255, 255, 255]
    ];
    LUT = new Uint8Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      var v = i / 255;
      var k = 0;
      while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
      var a = stops[k], b = stops[k + 1];
      var t = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      LUT[i * 3] = Math.round(a[1] + (b[1] - a[1]) * t);
      LUT[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * t);
      LUT[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * t);
    }
  }

  /* ===================================================================
   * 图像读入
   * =================================================================== */

  /*
   * 统一成三种视图：
   *   data  —— 已按 alpha 合成到中灰的 RGB（单幅频谱 / 灰度模式用，保持原有行为）
   *   raw   —— 未合成的原始 RGB（四通道模式的 R/G/B 画板用）
   *   alpha —— alpha 通道（没有就是全 1）
   */
  function imageView(w, h, srcData, srcCh, bitDepth, format) {
    return {
      w: w, h: h, ch: 3,
      data: C.ensureRgb(srcData, w, h, srcCh),
      raw: C.rawRgb(srcData, w, h, srcCh),
      alpha: C.ensureAlpha(srcData, w, h, srcCh),
      hasAlpha: srcCh === 4 || srcCh === 2,
      bitDepth: bitDepth,
      format: format
    };
  }

  async function readImageFile(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var name = (file.name || '').toLowerCase();
    var isTiff = /\.tiff?$/.test(name) || (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 42 && buf[3] === 0);

    if (isTiff) {
      var t = C.decodeTiff32f(buf);
      return imageView(t.width, t.height, t.data, t.channels, t.bitDepth, 'TIFF 浮点');
    }
    if (/\.png$/.test(name) || (buf[0] === 137 && buf[1] === 80)) {
      try {
        var p = await C.decodePng(buf);
        /* 灰度 / 灰度+alpha / RGB / RGBA 都在 imageView 里拆好，
           下游按 ch=3 读不会再把 RGBA 数据切错位 */
        return imageView(p.width, p.height, p.data, p.channels, p.bitDepth,
          'PNG ' + p.bitDepth + 'bit ' + ['', 'Gray', 'GrayA', 'RGB', 'RGBA'][p.channels]);
      } catch (e) { /* 回退到浏览器解码 */ }
    }
    var bmp = await createImageBitmap(new Blob([buf]));
    var cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    var cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    var d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    var n = bmp.width * bmp.height;
    var rgba = new Float32Array(n * 4);
    for (var i = 0; i < n; i++) {
      rgba[i * 4] = d[i * 4] / 255;
      rgba[i * 4 + 1] = d[i * 4 + 1] / 255;
      rgba[i * 4 + 2] = d[i * 4 + 2] / 255;
      rgba[i * 4 + 3] = d[i * 4 + 3] / 255;
    }
    var w0 = bmp.width, h0 = bmp.height;
    if (bmp.close) bmp.close();
    return imageView(w0, h0, rgba, 4, 8, '浏览器解码');
  }

  /* 重采样与适配逻辑已下沉到 codec.js，这里只做别名，
     保证网页端与测试脚本用的是同一份实现 */
  var resampleRect = C.resampleRect;

  function fitToSquare(src, N, mode) {
    return C.fitToRgb(src, N, mode);
  }

  function rebuildFit() {
    if (!S.src) return;
    var N = S.N, i;
    S.fitRgb = fitToSquare(S.src, N, S.fit);
    S.fitGray = new Float32Array(N * N);
    for (i = 0; i < N * N; i++) {
      S.fitGray[i] = (S.fitRgb[i * 3] + S.fitRgb[i * 3 + 1] + S.fitRgb[i * 3 + 2]) / 3;
    }
    S.specA = F.forward(S.fitGray, N);
    S.band = F.bandTable(N);
    S.chanFit = null;
    S.chanSpec = null;
    if (S.color === 'channels') buildChanFit();
  }

  /*
   * 四通道工作图：R/G/B 取未经 alpha 合成的原始值，A 单独按同一套适配方式缩放。
   * 不合成是故意的——否则 A 通道被改动的部分会串进 R/G/B 的频谱里，
   * 四份信息就不再互相独立了。没有 alpha 的源图用全 1 补齐。
   */
  function buildChanFit() {
    var N = S.N, n = N * N, i;
    var raw = C.fitToRgb({ w: S.src.w, h: S.src.h, ch: 3, data: S.src.raw }, N, S.fit);
    var alphaSrc = S.src.alpha;
    if (!alphaSrc || alphaSrc.length !== S.src.w * S.src.h) {
      alphaSrc = new Float32Array(S.src.w * S.src.h);
      alphaSrc.fill(1);
    }
    var a = C.fitToGray(alphaSrc, S.src.w, S.src.h, N, S.fit);
    var c0 = new Float32Array(n), c1 = new Float32Array(n), c2 = new Float32Array(n);
    for (i = 0; i < n; i++) {
      c0[i] = raw[i * 3];
      c1[i] = raw[i * 3 + 1];
      c2[i] = raw[i * 3 + 2];
    }
    S.chanFit = [c0, c1, c2, a];
    S.chanSpec = [F.forward(c0, N), F.forward(c1, N), F.forward(c2, N), F.forward(a, N)];
  }

  async function loadSource(file) {
    setStatus('读取图片…', 'busy');
    try {
      var img = await readImageFile(file);
      S.src = {
        w: img.w, h: img.h, ch: img.ch, data: img.data, raw: img.raw,
        alpha: img.alpha, hasAlpha: img.hasAlpha,
        name: file.name || 'image',
        base: (file.name || 'image').replace(/\.[^.]+$/, ''),
        bitDepth: img.bitDepth, format: img.format
      };
      S.fit = $('selFit').value;

      /*
       * 源图比工作尺寸小太多时，放大只会得到整片被复制的频谱（块状上采样），
       * 画板上看到的是 8x8 平铺的假结构。这时把工作尺寸降到接近源图，
       * 只在"源图放不满当前尺寸"时才自动改，不会覆盖用户主动选的更大尺寸。
       */
      var minSide = Math.min(img.w, img.h);
      if (minSide * 2 <= S.N) {
        var target = Math.pow(2, Math.round(Math.log(minSide) / Math.LN2));
        target = Math.max(64, Math.min(1024, target));
        if (target !== S.N) {
          var oldN = S.N;
          S.N = target;
          $('selN').value = String(target);
          resizeCanvases(target);
          syncParamLabels();
          resizeMasks(target, oldN);
          boardHint('源图只有 ' + minSide + 'px，工作尺寸已自动设为 ' + target + ' × ' + target +
            '（放大到更大尺寸会让频谱变成平铺的方格；确需更大画布可在「图像尺寸」里改）');
        }
      } else {
        boardHint('');
      }
      if (S.singleMask.length !== S.N * S.N || (S.masks && S.masks[0].length !== S.N * S.N)) {
        resizeMasks(S.N, S.N);
      }
      rebuildFit();
      renderSource();
      renderSpec();
      renderMask();
      renderHud();
      $('srcEmpty').classList.add('hidden');
      $('cvSrc').classList.remove('hidden');
      $('boardEmpty').classList.add('hidden');
      updateSrcMeta();
      updateChanTabs();
      await compute();
    } catch (e) {
      console.error(e);
      setStatus('读取失败: ' + e.message, 'err');
    }
  }

  function updateSrcMeta() {
    if (!S.src) { $('srcMeta').innerHTML = ''; return; }
    var rows = [
      ['文件', S.src.name],
      ['原始尺寸', S.src.w + ' × ' + S.src.h],
      ['位深 / 格式', S.src.bitDepth + ' 位 · ' + S.src.format],
      ['工作尺寸', S.N + ' × ' + S.N],
      ['适配', { cover: '裁切填满', stretch: '拉伸', fit: '留黑边' }[S.fit]]
    ];
    $('srcMeta').innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v" title="' + esc(r[1]) + '">' + esc(r[1]) + '</span>';
    }).join('');
  }

  function renderSource() {
    if (!S.fitRgb || !srcImg) return;
    var N = S.N, d = srcImg.data;
    for (var i = 0; i < N * N; i++) {
      d[i * 4] = Math.round(clamp01(S.fitRgb[i * 3]) * 255);
      d[i * 4 + 1] = Math.round(clamp01(S.fitRgb[i * 3 + 1]) * 255);
      d[i * 4 + 2] = Math.round(clamp01(S.fitRgb[i * 3 + 2]) * 255);
      d[i * 4 + 3] = 255;
    }
    ctxSrc.putImageData(srcImg, 0, 0);
  }

  /* ===================================================================
   * 画板渲染
   * =================================================================== */

  /* 当前画板对应的频谱：四通道模式下是被选中那个通道的频谱 */
  function currentSpectrum() {
    if (chanMode() && S.chanSpec) return S.chanSpec[S.chan];
    return S.specA;
  }

  function renderSpec() {
    var spec = currentSpectrum();
    if (!spec || !S.band) return;
    var N = S.N, band = S.band, p = readParams();
    var bytes = F.spectrumToBytes(F.logMag(spec.re, spec.im, N), N);
    var d = specImg.data;
    var tint = chanMode() ? CH_COLORS[S.chan] : null;
    for (var i = 0; i < N * N; i++) {
      var v = bytes[i];
      if (!inBand(band[i], p)) v = v * 0.45;
      var c = v | 0;
      if (tint) {
        /* 淡淡染上通道色：一眼看出自己在哪块画板上 */
        d[i * 4] = Math.round(LUT[c * 3] * 0.82 + tint[0] * 0.18);
        d[i * 4 + 1] = Math.round(LUT[c * 3 + 1] * 0.82 + tint[1] * 0.18);
        d[i * 4 + 2] = Math.round(LUT[c * 3 + 2] * 0.82 + tint[2] * 0.18);
      } else {
        d[i * 4] = LUT[c * 3];
        d[i * 4 + 1] = LUT[c * 3 + 1];
        d[i * 4 + 2] = LUT[c * 3 + 2];
      }
      d[i * 4 + 3] = 255;
    }
    ctxSpec.putImageData(specImg, 0, 0);
    var lbl = $('boardSizeLabel');
    if (lbl) {
      lbl.textContent = N + ' × ' + N + (chanMode() ? ' · ' + CH_KEYS[S.chan] + ' 通道频谱' : ' · 频域');
    }
  }

  function renderMask() {
    if (!maskImg) return;
    var N = S.N, d = maskImg.data;
    var col = chanMode() ? CH_COLORS[S.chan] : [53, 224, 208];
    var mcol = chanMode() ? CH_COLORS[S.chan] : [255, 91, 208];
    d.fill(0);
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (!S.mask[i]) continue;
        var di = i * 4;
        d[di] = col[0]; d[di + 1] = col[1]; d[di + 2] = col[2]; d[di + 3] = 150;
        /* 掩码永远成对存在，顺手把镜像也点亮，保证显示也是对称的 */
        var j = ((N - y) % N) * N * 4 + ((N - x) % N) * 4;
        d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 150;
      }
    }
    ctxMask.putImageData(maskImg, 0, 0);
  }

  var cursor = null;

  function renderHud() {
    if (!ctxHud) return;
    var N = S.N, c = ctxHud, h = N >> 1, p = readParams();
    /* HUD 画布可能比数据分辨率大（小图时），统一按 s 倍缩放绘制 */
    var H = c.width;
    var s = H / N;
    c.clearRect(0, 0, H, H);
    c.save();

    c.lineWidth = Math.max(1, H / 512);

    /* 内径环：外面都能画 */
    c.strokeStyle = 'rgba(53,224,208,0.34)';
    c.beginPath(); c.arc((h + 0.5) * s, (h + 0.5) * s, Math.max(1, p.bandMin * h * s), 0, Math.PI * 2); c.stroke();

    /* 外径环：只在"限制外径"打开时存在 */
    if (p.outerLimited) {
      c.strokeStyle = 'rgba(53,224,208,0.20)';
      c.beginPath(); c.arc((h + 0.5) * s, (h + 0.5) * s, p.bandMax * h * s, 0, Math.PI * 2); c.stroke();
    }

    c.fillStyle = 'rgba(255,200,87,0.95)';
    c.beginPath(); c.arc((h + 0.5) * s, (h + 0.5) * s, Math.max(1.6, H / 220), 0, Math.PI * 2); c.fill();

    var fs = Math.max(11, Math.round(H / 42));
    c.font = '600 ' + fs + 'px "Microsoft YaHei", sans-serif';
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.fillStyle = 'rgba(53,224,208,0.8)';
    c.fillText('内径以外任意绘制', H * 0.025, H * 0.025);
    c.textAlign = 'right';
    c.fillStyle = 'rgba(255,91,208,0.8)';
    c.fillText('共轭对自动补全 · DC 不动', H * 0.975, H * 0.025);

    if (cursor) {
      c.strokeStyle = 'rgba(255,255,255,0.75)';
      c.lineWidth = Math.max(1, H / 512 * 1.2);
      c.beginPath();
      c.arc(cursor.x * s, cursor.y * s, Math.max(2, S.brush * s), 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  /* ===================================================================
   * 绘制
   * =================================================================== */

  var drawing = false, lastPt = null;

  function pointerBin(e) {
    var r = $('boardStack').getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * S.N,
      y: (e.clientY - r.top) / r.height * S.N
    };
  }

  /* 撤销栈记录"哪一块画板 + 那块板子的快照"，
     这样四通道模式下撤销不会把别的通道一起回滚 */
  function pushUndo() {
    S.undo.push({ chan: chanMode() ? S.chan : -1, mask: Uint8Array.from(S.mask) });
    if (S.undo.length > 24) S.undo.shift();
    S.redo.length = 0;
  }

  function applySnapshot(snap) {
    if (!snap) return;
    if (snap.chan >= 0 && chanMode()) {
      ensureMasks();
      S.masks[snap.chan] = snap.mask;
      S.chan = snap.chan;
      bindMask();
    } else {
      S.singleMask = snap.mask;
      bindMask();
    }
    updateChanTabs();
    renderSpec();
    renderMask();
    renderHud();
  }

  function stamp(x, y, r, value) {
    var N = S.N, band = S.band, p = readParams();
    var h = N >> 1;
    var dc = h * N + h;                       /* 中心化坐标下的直流点 */
    var x0 = Math.max(0, Math.floor(x - r));
    var x1 = Math.min(N - 1, Math.ceil(x + r));
    var y0 = Math.max(0, Math.floor(y - r));
    var y1 = Math.min(N - 1, Math.ceil(y + r));
    var r2 = r * r, touched = 0;
    for (var yy = y0; yy <= y1; yy++) {
      for (var xx = x0; xx <= x1; xx++) {
        var dx = xx - x, dy = yy - y;
        if (dx * dx + dy * dy > r2) continue;
        var i = yy * N + xx;
        if (i === dc) continue;               /* DC 永远不碰 */
        if (!inBand(band[i], p)) continue;
        if (S.mask[i] !== value) { S.mask[i] = value; touched++; }
        /* 自动共轭：这一笔的镜像点一起改 */
        var mi = F.mirrorCell(xx, yy, N);
        if (mi !== i && S.mask[mi] !== value) { S.mask[mi] = value; touched++; }
      }
    }
    return touched;
  }

  function strokeSegment(a, b) {
    var r = S.brush;
    var value = S.tool === 'erase' ? 0 : 1;
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.35)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      stamp(a.x + dx * t, a.y + dy * t, r, value);
    }
  }

  function applyText(pt) {
    var text = ($('textValue').value || '').trim();
    if (!text) { boardHint('先输入要藏进频谱的文字', true); return; }
    var size = +$('textSize').value;
    var N = S.N, half = N >> 1;
    var off = document.createElement('canvas');
    off.width = N;
    off.height = N;
    var cx = off.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, N, N);
    cx.font = '700 ' + size + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    var w = cx.measureText(text).width;
    var px = pt.x, py = pt.y;

    var minX = 2 + w / 2;
    var maxX = N - 2 - w / 2;
    if (minX > maxX) {
      boardHint('字太大，画布放不下，请调小字号', true);
      return;
    }
    var moved = false;
    if (px < minX) { px = minX; moved = true; }
    if (px > maxX) { px = maxX; moved = true; }
    if (py < size * 0.7) { py = size * 0.7; moved = true; }
    if (py > N - size * 0.4) { py = N - size * 0.4; moved = true; }

    cx.fillStyle = '#fff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, px, py);

    var d = cx.getImageData(0, 0, N, N).data;
    var p = readParams();
    var h = half, dc = h * N + h;
    pushUndo();
    var added = 0;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (d[i * 4] < 110) continue;
        if (i === dc) continue;
        if (!inBand(S.band[i], p)) continue;
        if (!S.mask[i]) added++;
        S.mask[i] = 1;
        var mi = F.mirrorCell(x, y, N);
        if (mi !== i) S.mask[mi] = 1;      /* 共轭对自动补全 */
      }
    }
    updateChanTabs();
    renderMask();
    renderHud();
    boardHint('已写入「' + text + '」：' + added + ' 个频点（镜像已自动补全）' + (moved ? '（已贴到画布边缘）' : ''));
    scheduleCompute(60);
  }

  /* ===================================================================
   * 核心计算
   * =================================================================== */

  var computeTimer = null;
  function scheduleCompute(delay) {
    if (!S.auto) return;
    if (computeTimer) clearTimeout(computeTimer);
    computeTimer = setTimeout(function () { compute(); }, delay === undefined ? 140 : delay);
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    var a = Float64Array.from(arr);
    a.sort();
    return a[a.length >> 1];
  }

  /* 计算入口：按色彩处理方式分派到"单幅频谱"或"四通道独立频谱" */
  async function compute() {
    if (!S.src || !S.fitGray) return;
    if (S.color === 'channels') return computeChannels();
    return computeSingle();
  }

  async function computeSingle() {
    if (!S.src || !S.fitGray) return;
    if (S.running) { S.pending = true; return; }
    S.running = true;
    ++S.calcId;
    setStatus('计算中…', 'busy');
    await tick();

    try {
      var N = S.N, p = readParams();
      if (!S.specA || S.specA.N !== N) rebuildFit();
      S.band = F.bandTable(N);
      var seed = F.keySeed(p.key);
      var t0 = performance.now();

      var sel = F.buildSelection({
        mask: S.mask, N: N,
        bandMin: p.bandMin, bandMax: p.bandMax, outerLimited: p.outerLimited,
        density: p.density, maxBins: p.maxBins, seed: seed
      });

      var B = F.embed(S.specA.re, S.specA.im, N, {
        mode: p.mode, delta: p.delta, eps: p.eps, sel: sel.sel, signs: sel.signs
      });
      var ab = F.inverse(B);

      var q = 65535;
      var outGray = new Float32Array(N * N);
      var outRgb = new Float32Array(N * N * 3);
      var i, c, v;

      if (p.color === 'color') {
        for (i = 0; i < N * N; i++) {
          var dd = ab[i] - S.fitGray[i];
          var s = 0;
          for (c = 0; c < 3; c++) {
            v = clamp01(S.fitRgb[i * 3 + c] + dd);
            v = Math.round(v * q) / q;
            outRgb[i * 3 + c] = v;
            s += v;
          }
          outGray[i] = s / 3;
        }
      } else {
        for (i = 0; i < N * N; i++) {
          v = clamp01(ab[i]);
          v = Math.round(v * q) / q;
          outGray[i] = v;
          outRgb[i * 3] = v;
          outRgb[i * 3 + 1] = v;
          outRgb[i * 3 + 2] = v;
        }
      }

      var psnr, maxd;
      if (p.color === 'color') {
        psnr = F.psnr(outRgb, S.fitRgb);
        maxd = F.maxAbsDiff(outRgb, S.fitRgb);
      } else {
        psnr = F.psnr(outGray, S.fitGray);
        maxd = F.maxAbsDiff(outGray, S.fitGray);
      }

      var D = F.diffMag(S.specA, F.forward(outGray, N), N);
      var ex = F.extract({ D: D, N: N, bandMin: p.bandMin, bandMax: bandMaxEff(p), threshold: null });
      var iou16 = F.iouHalf(ex.mask, sel.sel, N);

      var selVals = [];
      for (var y2 = 0; y2 < N; y2++) {
        for (var x2 = (N >> 1) + 1; x2 < N; x2++) {
          var idx = y2 * N + x2;
          if (sel.sel[idx]) selVals.push(D[idx]);
        }
      }
      var medD = medianOf(selVals);
      var noise8 = F.quantNoiseStd(N, 8);
      var margin = noise8 > 0 ? medD / noise8 : 0;

      var g8 = new Float32Array(N * N);
      if (p.color === 'color') {
        for (i = 0; i < N * N; i++) {
          g8[i] = (Math.round(clamp01(outRgb[i * 3]) * 255) / 255 +
                   Math.round(clamp01(outRgb[i * 3 + 1]) * 255) / 255 +
                   Math.round(clamp01(outRgb[i * 3 + 2]) * 255) / 255) / 3;
        }
      } else {
        for (i = 0; i < N * N; i++) g8[i] = Math.round(clamp01(outGray[i]) * 255) / 255;
      }
      var ex8 = F.extract({
        D: F.diffMag(S.specA, F.forward(g8, N), N),
        N: N, bandMin: p.bandMin, bandMax: bandMaxEff(p), threshold: null
      });
      var iou8 = F.iouHalf(ex8.mask, sel.sel, N);

      S.out = {
        N: N, sel: sel, gray: outGray, rgb: outRgb, D: D,
        psnr: psnr, maxd: maxd, margin: margin, medD: medD,
        iou16: iou16, iou8: iou8, count: sel.count,
        bins16: ex.bins, bins8: ex8.bins, threshold: ex.threshold,
        color: p.color, params: p, ms: performance.now() - t0,
        key: p.key, hash: null
      };
      S.dec.N = N;

      renderOut();
      updateMetrics();
      setStatus('已生成 · ' + sel.count + ' 点 · ' + fmt(psnr, 1) + ' dB', 'ok');
    } catch (e) {
      console.error(e);
      setStatus('计算失败: ' + e.message, 'err');
    } finally {
      S.running = false;
      if (S.pending) { S.pending = false; compute(); }
    }
  }

  /*
   * 四通道独立频谱。
   * 对 R / G / B / A 各自的画板分别选点、分别扰动、各自逆变换，
   * 四个通道互不干涉，所以一张图里能同时藏四份信息，谁也读不出别人的。
   */
  async function computeChannels() {
    if (!S.src || !S.chanFit) return;
    if (S.running) { S.pending = true; return; }
    S.running = true;
    ++S.calcId;
    setStatus('计算中…（四通道）', 'busy');
    await tick();

    try {
      var N = S.N, p = readParams();
      if (!S.chanSpec || S.chanSpec[0].N !== N) rebuildFit();
      S.band = F.bandTable(N);
      var seed = F.keySeed(p.key);
      var t0 = performance.now();
      var n = N * N, i, c, q = 65535;
      var noise8 = F.quantNoiseStd(N, 8);
      var outCh = [], chans = [];
      var totalBins = 0, active = 0, minIou16 = 1, minIou8 = 1, minMargin = Infinity, worstMed = 0;

      for (c = 0; c < 4; c++) {
        var mask = (S.masks && S.masks[c]) || new Uint8Array(n);
        var sel = F.buildSelection({
          mask: mask, N: N,
          bandMin: p.bandMin, bandMax: p.bandMax, outerLimited: p.outerLimited,
          density: p.density, maxBins: p.maxBins, seed: seed
        });
        var outC = Float32Array.from(S.chanFit[c]);
        var rec = {
          key: CH_KEYS[c], name: CH_NAMES[c], sel: sel, count: sel.count,
          D: null, iou16: null, iou8: null, bins: 0, bins8: 0,
          threshold: 0, medD: 0, margin: 0
        };

        if (sel.count > 0) {
          var B = F.embed(S.chanSpec[c].re, S.chanSpec[c].im, N, {
            mode: p.mode, delta: p.delta, eps: p.eps, sel: sel.sel, signs: sel.signs
          });
          var inv = F.inverse(B);
          /*
           * 防削波：先整体平移一个常量，让逆变换结果落进 [0,1]。
           * 加常量只改直流分量，提取用的频带（内径 > 0）里看不见它；
           * 但能避免 alpha = 1.0 的整片不透明像素、或纯白像素被 clamp 夹断——
           * 夹断会把图案打散成宽带泄漏，A 通道尤其致命。
           */
          var lo = Infinity, hi = -Infinity, sv;
          for (i = 0; i < n; i++) {
            sv = inv[i];
            if (sv < lo) lo = sv;
            if (sv > hi) hi = sv;
          }
          var shift = 0;
          if (hi > 1) shift -= (hi - 1);
          if (lo + shift < 0) shift = -lo;
          for (i = 0; i < n; i++) outC[i] = Math.round((inv[i] + shift) * q) / q;

          rec.D = F.diffMag(S.chanSpec[c], F.forward(outC, N), N);
          var ex = F.extract({ D: rec.D, N: N, bandMin: p.bandMin, bandMax: bandMaxEff(p), threshold: null });
          rec.iou16 = F.iouHalf(ex.mask, sel.sel, N);
          rec.bins = ex.bins;
          rec.threshold = ex.threshold;

          /* 把这一通道单独降到 8 位再解一次：只看它自己能不能活 */
          var g8 = new Float32Array(n);
          for (i = 0; i < n; i++) g8[i] = Math.round(clamp01(outC[i]) * 255) / 255;
          var ex8 = F.extract({
            D: F.diffMag(S.chanSpec[c], F.forward(g8, N), N),
            N: N, bandMin: p.bandMin, bandMax: bandMaxEff(p), threshold: null
          });
          rec.iou8 = F.iouHalf(ex8.mask, sel.sel, N);
          rec.bins8 = ex8.bins;

          var vals = [];
          for (var y2 = 0; y2 < N; y2++) {
            for (var x2 = (N >> 1) + 1; x2 < N; x2++) {
              var idx = y2 * N + x2;
              if (sel.sel[idx]) vals.push(rec.D[idx]);
            }
          }
          rec.medD = medianOf(vals);
          rec.margin = noise8 > 0 ? rec.medD / noise8 : 0;

          totalBins += sel.count;
          active++;
          if (rec.iou16 < minIou16) minIou16 = rec.iou16;
          if (rec.iou8 < minIou8) minIou8 = rec.iou8;
          if (rec.margin < minMargin) minMargin = rec.margin;
          if (rec.medD > worstMed) worstMed = rec.medD;
        }
        outCh.push(outC);
        chans.push(rec);
      }

      /* 四通道合成 RGBA；预览时把 alpha 合成一次，画布上才是"看起来的样子" */
      var rgba = new Float32Array(n * 4);
      var srcRgba = new Float32Array(n * 4);
      var rgbPrev = new Float32Array(n * 3);
      for (i = 0; i < n; i++) {
        for (c = 0; c < 4; c++) {
          rgba[i * 4 + c] = outCh[c][i];
          srcRgba[i * 4 + c] = S.chanFit[c][i];
        }
        var a = clamp01(outCh[3][i]);
        for (c = 0; c < 3; c++) {
          rgbPrev[i * 3 + c] = clamp01(outCh[c][i]) * a + 0.5 * (1 - a);
        }
      }

      S.out = {
        N: N, chans: chans, chOut: outCh, rgba: rgba,
        rgb: rgbPrev, gray: null, D: active ? chans[0].D : null,
        count: totalBins, activeChans: active,
        psnr: F.psnr(rgba, srcRgba), maxd: F.maxAbsDiff(rgba, srcRgba),
        margin: active ? minMargin : 0, medD: worstMed,
        iou16: active ? minIou16 : 1, iou8: active ? minIou8 : 1,
        bins16: 0, bins8: 0, threshold: 0,
        color: 'channels', params: p, ms: performance.now() - t0,
        key: p.key, hash: null, sel: chans[0].sel
      };
      for (c = 0; c < 4; c++) {
        S.out.bins16 += chans[c].bins;
        S.out.bins8 += chans[c].bins8;
      }
      S.dec.N = N;

      renderOut();
      updateMetrics();
      updateChanTabs();
      setStatus('已生成 · 四通道合计 ' + totalBins + ' 点 · ' + fmt(S.out.psnr, 1) + ' dB', 'ok');
    } catch (e) {
      console.error(e);
      setStatus('计算失败: ' + e.message, 'err');
    } finally {
      S.running = false;
      if (S.pending) { S.pending = false; compute(); }
    }
  }

  /* ===================================================================
   * 输出与指标
   * =================================================================== */

  function renderOut() {
    if (!S.out || !outImg) return;
    var N = S.N, d = outImg.data, i;
    if (S.view === 'img') {
      if (S.out.rgba) {
        /* 四通道模式：预览不带透明度，免得和页面背景混色看不出差别 */
        var rgba = S.out.rgba;
        for (i = 0; i < N * N; i++) {
          d[i * 4] = Math.round(clamp01(rgba[i * 4]) * 255);
          d[i * 4 + 1] = Math.round(clamp01(rgba[i * 4 + 1]) * 255);
          d[i * 4 + 2] = Math.round(clamp01(rgba[i * 4 + 2]) * 255);
          d[i * 4 + 3] = 255;
        }
      } else {
        var rgb = S.out.rgb;
        for (i = 0; i < N * N; i++) {
          d[i * 4] = Math.round(clamp01(rgb[i * 3]) * 255);
          d[i * 4 + 1] = Math.round(clamp01(rgb[i * 3 + 1]) * 255);
          d[i * 4 + 2] = Math.round(clamp01(rgb[i * 3 + 2]) * 255);
          d[i * 4 + 3] = 255;
        }
      }
    } else if (S.out.chans) {
      /* 四通道差分：每份图案用自己的通道色显示，A 通道叠加为白色 */
      var gv = +$('diffGain').value;
      var gain = gv === 0 ? 1 : gv / 50;
      var parts = S.out.chans.map(function (ch) {
        return ch.D ? F.diffToBytes(ch.D, N, gain) : null;
      });
      for (i = 0; i < N * N; i++) {
        var r = parts[0] ? parts[0][i] : 0;
        var gg = parts[1] ? parts[1][i] : 0;
        var b = parts[2] ? parts[2][i] : 0;
        var al = parts[3] ? Math.round(parts[3][i] * 0.8) : 0;
        d[i * 4] = Math.min(255, r + al);
        d[i * 4 + 1] = Math.min(255, gg + al);
        d[i * 4 + 2] = Math.min(255, b + al);
        d[i * 4 + 3] = 255;
      }
    } else {
      var g = diffBytes();
      for (i = 0; i < N * N; i++) {
        d[i * 4] = g[i]; d[i * 4 + 1] = g[i]; d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255;
      }
    }
    ctxOut.putImageData(outImg, 0, 0);
    $('outEmpty').classList.add('hidden');
  }

  function diffBytes() {
    var gv = +$('diffGain').value;
    return F.diffToBytes(S.out.D, S.N, gv === 0 ? 1 : gv / 50);
  }

  function setMetric(id, txt, cls) {
    var el = $(id);
    el.textContent = txt;
    el.className = 'metric-value' + (cls ? ' ' + cls : '');
  }

  /* 四通道 16 位字节流，仅用于算输出指纹 */
  function rgba16Bytes(rgba) {
    var bytes = new Uint8Array(rgba.length * 2);
    var dv = new DataView(bytes.buffer);
    for (var i = 0; i < rgba.length; i++) dv.setUint16(i * 2, Math.round(clamp01(rgba[i]) * 65535));
    return bytes;
  }

  function gray16Bytes(gray) {
    var bytes = new Uint8Array(gray.length * 2);
    var dv = new DataView(bytes.buffer);
    for (var i = 0; i < gray.length; i++) dv.setUint16(i * 2, Math.round(clamp01(gray[i]) * 65535));
    return bytes;
  }

  function updateMetrics() {
    var o = S.out;
    if (!o) return;
    var N = S.N, h = N >> 1, p = o.params;

    /* 可编辑区：内径以外整圈（外径可关），扣掉 DC 本身 */
    var editable = 0;
    var dcCell = h * N + h;
    for (var ei = 0; ei < N * N; ei++) {
      if (ei === dcCell) continue;
      if (inBand(S.band[ei], p)) editable++;
    }
    /* 四通道模式的可编辑区是"每通道一份"，分母要乘上实际用到的通道数 */
    var slots = editable * (o.chans ? Math.max(1, o.activeChans) : 1);
    var cover = slots > 0 ? o.count / slots : 0;

    setMetric('mBins', String(o.count));
    setMetric('mCover', (cover * 100).toFixed(1) + '%');
    setMetric('mPsnr', fmt(o.psnr, 2) + ' dB', o.psnr > 55 ? 'good' : (o.psnr > 42 ? 'warn' : 'bad'));
    setMetric('mMaxDiff', (o.maxd * 255).toFixed(2) + ' / 255', o.maxd * 255 < 2 ? 'good' : (o.maxd * 255 < 8 ? 'warn' : 'bad'));
    setMetric('mMargin', fmt(o.margin, 1) + ' × σ8', o.margin > 4 ? 'good' : (o.margin > 2 ? 'warn' : 'bad'));
    setMetric('mIou16', o.count === 0 ? '—' : (o.iou16 * 100).toFixed(1) + '%', o.iou16 > 0.98 ? 'good' : (o.iou16 > 0.9 ? 'warn' : 'bad'));
    setMetric('mIou8', o.count === 0 ? '—' : (o.iou8 * 100).toFixed(1) + '%', o.iou8 > 0.98 ? 'good' : (o.iou8 > 0.9 ? 'warn' : 'bad'));

    /* 四通道模式下把每块画板的结果单独列出来，一眼看出哪份信息没藏好 */
    var chanBox = $('mChans');
    if (chanBox) {
      if (o.chans) {
        chanBox.classList.remove('hidden');
        chanBox.innerHTML = o.chans.map(function (ch, k) {
          var sw = CH_COLORS[k];
          var iou = ch.count ? (ch.iou16 * 100).toFixed(1) + '%' : '—';
          return '<span class="k"><i class="chan-swatch" style="background:rgb(' +
            sw[0] + ',' + sw[1] + ',' + sw[2] + ')"></i>' + ch.name + '</span>' +
            '<span class="v">' + (ch.count ? ch.count + ' 点 · IoU ' + iou : '未使用') + '</span>';
        }).join('');
      } else {
        chanBox.classList.add('hidden');
        chanBox.innerHTML = '';
      }
    }

    var badge = $('metricsBadge'), note;
    if (o.count === 0) {
      badge.textContent = '画板为空';
      badge.className = 'pill pill-warn';
      note = '在傅里叶画板上画出图案（或用文字工具落字），才会产生频域选点。';
    } else if (o.iou16 > 0.98 && o.margin > 4) {
      badge.textContent = o.iou8 > 0.95 ? '可用' : '可用（仅 16 位）';
      badge.className = 'pill pill-ok';
      if (o.iou8 > 0.95) {
        note = '选点 ' + o.count + ' 个，16 位 IoU ' + (o.iou16 * 100).toFixed(1) +
          '%，8 位也扛得住。耗时 ' + Math.round(o.ms) + ' ms。';
      } else {
        note = '16 位 IoU ' + (o.iou16 * 100).toFixed(1) + '%，但 8 位只有 ' +
          (o.iou8 * 100).toFixed(1) + '%。图像里大块纯色的区域，微小扰动跨不过 8 位舍入边界会被抹平；' +
          '请用 16 位 PNG / float32 TIFF 分发，或把扰动强度调大。';
      }
    } else if (o.iou16 > 0.9) {
      badge.textContent = '勉强';
      badge.className = 'pill pill-warn';
      note = '检测余量偏低：调大扰动强度，或坚持用 16 位 PNG / float32 TIFF 分发。';
    } else {
      badge.textContent = '不可靠';
      badge.className = 'pill pill-bad';
      note = '差分读不出来：选点太少、频带太窄或扰动太弱。';
    }
    $('mNote').textContent = note;

    if (o.chans) {
      var used = o.chans.filter(function (c) { return c.count > 0; })
        .map(function (c) { return c.key; });
      $('mNote').textContent = '四通道独立频谱：' +
        (used.length ? used.join(' / ') + ' 各藏一份，合计 ' + o.count + ' 个频点' : '四块画板都还是空的') +
        '。' + note;
    }

    if (!o.hash) {
      C.sha256Hex(o.rgba ? rgba16Bytes(o.rgba) : gray16Bytes(o.gray)).then(function (hex) {
        o.hash = hex;
        $('mHash').textContent = hex.slice(0, 8) + '…';
        $('mHash').title = hex;
      });
    } else {
      $('mHash').textContent = o.hash.slice(0, 8) + '…';
    }

    updateOutMeta();
    $('btnSaveOut').disabled = o.count === 0;
  }

  function updateOutMeta() {
    var o = S.out;
    if (!o) { $('outMeta').innerHTML = ''; return; }
    var rows = [
      ['输出尺寸', o.N + ' × ' + o.N],
      ['色彩', o.color === 'channels' ? '四通道独立 R/G/B/A' : (o.color === 'color' ? '彩色 RGB' : '灰度')],
      ['选点', String(o.count)],
      ['扰动', o.params.mode === 'mul' ? ('ε ' + o.params.eps.toFixed(4)) : ('δ ' + o.params.delta.toFixed(2))]
    ];
    $('outMeta').innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span>';
    }).join('');
  }

  /* ===================================================================
   * 导出
   * =================================================================== */

  function baseName() {
    return (S.src && S.src.base ? S.src.base : 'fourier') + '_ab';
  }

  function needOut() {
    if (!S.out || S.out.count === 0) {
      setStatus('画板为空，先画出图案', 'err');
      return false;
    }
    return true;
  }

  /* 当前输出的通道数与数据：灰度 1 / 彩色 3 / 四通道 4 */
  function outChannels(o) {
    if (o.chans) return { ch: 4, data: o.rgba };
    if (o.color === 'color') return { ch: 3, data: o.rgb };
    return { ch: 1, data: o.gray };
  }

  async function exportPng16() {
    if (!needOut()) return;
    setStatus('编码 16 位 PNG…', 'busy');
    var o = S.out, N = o.N;
    var oc = outChannels(o);
    var png = await C.encodePng(oc.data, N, N, oc.ch, 16);
    /* 写入第一层线索：标准 PNG 文本块 */
    var bandTag = o.params.outerLimited
      ? (o.params.bandMin.toFixed(2) + '-' + o.params.bandMax.toFixed(2))
      : (o.params.bandMin.toFixed(2) + '+');
    var meta = 'fourier-mask-arg v1 | ' + N + 'x' + N + ' | band=' + bandTag +
      ' | bins=' + o.count + ' | mode=' + o.params.mode +
      (o.chans ? ' | channels=rgba(4)' : '') +
      ' | hint: compare spectra of original and this file';
    png = C.pngAddText(png, 'Comment', meta);
    var hex = await C.sha256Hex(png);
    o.hash = hex;
    download(png, baseName() + '_16bit.png', 'image/png');
    $('mHash').textContent = hex.slice(0, 8) + '…';
    $('mHash').title = hex;
    setStatus('已导出 16 位 PNG · SHA256 ' + hex.slice(0, 12), 'ok');
  }

  function exportTiff() {
    if (!needOut()) return;
    var o = S.out, N = o.N;
    var oc = outChannels(o);
    download(C.encodeTiff32f(oc.data, N, N, oc.ch), baseName() + '_f32.tif', 'image/tiff');
    setStatus('已导出 float32 TIFF' + (oc.ch === 4 ? '（RGBA 四通道）' : ''), 'ok');
  }

  async function exportPng8() {
    if (!needOut()) return;
    var o = S.out, N = o.N;
    var oc = outChannels(o);
    download(await C.encodePng(oc.data, N, N, oc.ch, 8), baseName() + '_8bit.png', 'image/png');
    setStatus('已导出 8 位 PNG', 'ok');
  }

  async function exportMask() {
    if (!S.out) { setStatus('还没有生成结果', 'err'); return; }
    var o = S.out, N = o.N;
    if (o.chans) {
      /* 四份答案各占一个通道，一张 RGBA 掩码图就装全了 */
      var img4 = new Float32Array(N * N * 4);
      for (var k = 0; k < 4; k++) {
        var s4 = o.chans[k].sel;
        for (var y4 = 0; y4 < N; y4++) {
          for (var x4 = 0; x4 < N; x4++) {
            var i4 = y4 * N + x4;
            if (s4.sel[i4]) img4[i4 * 4 + k] = 1;
            else if (s4.sel[((N - y4) % N) * N + ((N - x4) % N)]) img4[i4 * 4 + k] = 0.55;
          }
        }
      }
      download(await C.encodePng(img4, N, N, 4, 8), baseName() + '_mask_rgba.png', 'image/png');
      setStatus('已导出四通道掩码图（R/G/B/A 各一份答案）', 'ok');
      return;
    }
    var img = new Float32Array(N * N);
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (o.sel.sel[i]) img[i] = 1;
        else if (o.sel.sel[((N - y) % N) * N + ((N - x) % N)]) img[i] = 0.55;
      }
    }
    download(await C.encodePng(img, N, N, 1, 8), baseName() + '_mask.png', 'image/png');
    setStatus('已导出掩码图（答案）', 'ok');
  }

  async function exportDiff() {
    if (!S.out) { setStatus('还没有生成结果', 'err'); return; }
    var o = S.out, N = o.N, i;
    if (o.chans) {
      var parts = o.chans.map(function (c) { return c.D ? F.diffToBytes(c.D, N, 1) : null; });
      var img3 = new Float32Array(N * N * 3);
      for (i = 0; i < N * N; i++) {
        var al = parts[3] ? parts[3][i] * 0.8 : 0;
        img3[i * 3] = Math.min(1, ((parts[0] ? parts[0][i] : 0) + al) / 255);
        img3[i * 3 + 1] = Math.min(1, ((parts[1] ? parts[1][i] : 0) + al) / 255);
        img3[i * 3 + 2] = Math.min(1, ((parts[2] ? parts[2][i] : 0) + al) / 255);
      }
      download(await C.encodePng(img3, N, N, 3, 8), baseName() + '_diff_rgba.png', 'image/png');
      setStatus('已导出四通道差分图（红/绿/蓝=RGB 通道，白=A 通道）', 'ok');
      return;
    }
    var bytes = F.diffToBytes(o.D, N, 1);
    var img = new Float32Array(N * N);
    for (var j = 0; j < N * N; j++) img[j] = bytes[j] / 255;
    download(await C.encodePng(img, N, N, 1, 8), baseName() + '_diff.png', 'image/png');
    setStatus('已导出差分图', 'ok');
  }

  function buildPack() {
    var o = S.out, N = o.N, p = o.params;
    return {
      format: 'fourier-mask-arg',
      version: 1,
      createdAt: new Date().toISOString(),
      image: { name: S.src ? S.src.name : '', size: N, fit: p.fit },
      band: { min: p.bandMin, max: p.bandMax, outerLimited: !!p.outerLimited },
      selection: {
        density: p.density, maxBins: p.maxBins, count: o.count,
        key: p.key, seed: F.keySeed(p.key)
      },
      embed: { mode: p.mode, delta: p.delta, eps: p.eps },
      output: {
        format: 'png16', color: p.color,
        channels: o.chans ? 4 : (p.color === 'color' ? 3 : 1),
        channelMode: !!o.chans,
        psnr: +o.psnr.toFixed(3),
        maxLsb: +(o.maxd * 255).toFixed(4),
        iou16: +o.iou16.toFixed(5),
        sha256: o.hash || null
      },
      maskRle: C.rleEncode(o.sel.sel),
      /* 四通道模式：四份答案分别存，channelMasks[k] 对应 R/G/B/A */
      channelMasks: o.chans ? o.chans.map(function (c) { return C.rleEncode(c.sel.sel); }) : null,
      channelCounts: o.chans ? o.chans.map(function (c) { return c.count; }) : null
    };
  }

  async function exportPack() {
    if (!S.out) { setStatus('还没有生成结果', 'err'); return; }
    if (!S.out.hash) {
      S.out.hash = await C.sha256Hex(S.out.rgba ? rgba16Bytes(S.out.rgba) : gray16Bytes(S.out.gray));
    }
    downloadText(JSON.stringify(buildPack(), null, 2), baseName() + '_puzzle.json', 'application/json');
    setStatus('已导出谜题包', 'ok');
  }

  function exportReadme() {
    if (!S.out) { setStatus('还没有生成结果', 'err'); return; }
    var o = S.out, p = o.params, L = [];
    var bandTxt = p.outerLimited
      ? ('半径 ' + p.bandMin.toFixed(2) + ' 到 ' + p.bandMax.toFixed(2) + ' 的环带')
      : ('半径 ' + p.bandMin.toFixed(2) + ' 以外（不限外径）');
    var B = baseName() + '_16bit.png';
    L.push('# 频域谜题 · 玩家说明');
    L.push('');
    L.push('你手上应该有两份图片文件：');
    L.push('');
    L.push('1. 「原图」—— 没有任何改动的照片；');
    L.push('2. 「' + B + '」—— 修改图，秘密就藏在它的频谱里。');
    L.push('');
    L.push('## 规则');
    L.push('');
    L.push('- 两份文件必须都是原始文件。截图、转发、压缩、缩放、转格式都会把秘密抹掉。');
    L.push('- 秘密不在像素里，而在频率域。直接用眼睛看修改图，什么都不会发生。');
    L.push('');
    L.push('## 解法');
    L.push('');
    if (o.chans) {
      L.push('这张图有**四份**秘密，分别藏在 R / G / B / A 四个通道里，需要逐个通道解：');
      L.push('');
      L.push('1. 把两份图分别拆成 R、G、B、A 四个单通道灰度图（**不要**先把 alpha 合成进颜色）。');
      L.push('2. 对每一个通道，各自做二维傅里叶变换（频谱已中心化，低频在正中）。');
      L.push('3. 该通道的频谱之差：D = |F(修改图通道) − F(原图通道)|。');
      L.push('4. 只看 ' + bandTxt + '，对 D 做 Otsu 二值化。');
      L.push('5. 四个通道各得一张图案，四份内容互不相同。');
      L.push('');
      L.push('各通道的期望选点数：R ' + (o.chans[0].count || 0) + ' / G ' + (o.chans[1].count || 0) +
        ' / B ' + (o.chans[2].count || 0) + ' / A ' + (o.chans[3].count || 0) + '。');
      L.push('');
      L.push('> A（透明）通道多数情况下是一整片不透明，它的频谱几乎只有直流分量，');
      L.push('> 所以它的差分图看起来最"平"。这不代表没有信息——阈值化之后照样能读出图案。');
      L.push('');
      L.push('以下步骤对每个通道都适用：');
      L.push('');
    }
    L.push('1. 对两份图分别做二维傅里叶变换（频谱已中心化，低频在正中）。');
    L.push('2. 计算频谱之差：D = |F(修改图) − F(原图)|。');
    L.push('3. 只看 ' + bandTxt + '（以图像半宽为 1）。');
    L.push('4. 对 D 做阈值二值化（Otsu 即可），被改过的频点会连成图案。');
    L.push('5. 图案会自带一份旋转 180° 的镜像，两个都算对。');
    L.push('');
    L.push('## 工具');
    L.push('');
    L.push('用本项目的 index.html 打开「解码 / 玩家端」标签页，把两张图拖进去即可。');
    L.push('命令行版本：python tools/extract.py 原图 修改图 -o 结果.png');
    L.push('');
    L.push('## 校验');
    L.push('');
    L.push('- 修改图 SHA-256：' + (o.hash || '（导出 16 位 PNG 后写入）'));
    L.push('- 期望选点数：' + o.count);
    L.push('- 频带：' + bandTxt);
    L.push('');
    L.push('拿到图案却看不出内容？先确认没截图没压缩，再检查是不是漏看了右半边。');
    downloadText(L.join('\n'), baseName() + '_README.md', 'text/markdown;charset=utf-8');
    setStatus('已导出玩家说明', 'ok');
  }

  /* ===================================================================
   * 解码端
   * =================================================================== */

  function decPreview(canvasId, emptyId, gray, w, h) {
    var cv = $(canvasId);
    var R = 240;
    cv.width = R;
    cv.height = R;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(R, R);
    for (var y = 0; y < R; y++) {
      for (var x = 0; x < R; x++) {
        var sx = Math.min(w - 1, Math.floor(x / R * w));
        var sy = Math.min(h - 1, Math.floor(y / R * h));
        var v = Math.round(clamp01(gray[sy * w + sx]) * 255);
        var i = (y * R + x) * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    cv.classList.remove('hidden');
    $(emptyId).classList.add('hidden');
  }

  async function decLoad(which, file) {
    setStatus('读取' + (which === 'a' ? '原图' : '修改图') + '…', 'busy');
    try {
      var img = await readImageFile(file);
      var n = img.w * img.h;
      var gray = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        gray[i] = (img.data[i * 3] + img.data[i * 3 + 1] + img.data[i * 3 + 2]) / 3;
      }
      S.dec[which] = {
        w: img.w, h: img.h, gray: gray, rgb: img.raw, alpha: img.alpha,
        hasAlpha: img.hasAlpha, format: img.format, bitDepth: img.bitDepth, name: file.name
      };
      decPreview(which === 'a' ? 'decCvA' : 'decCvB', which === 'a' ? 'decEmptyA' : 'decEmptyB', gray, img.w, img.h);
      $('decMeta' + which.toUpperCase()).innerHTML = [
        ['文件', file.name || ''],
        ['尺寸', img.w + ' × ' + img.h],
        ['格式', img.bitDepth + ' 位 · ' + img.format]
      ].map(function (r) {
        return '<span class="k">' + r[0] + '</span><span class="v" title="' + esc(r[1]) + '">' + esc(r[1]) + '</span>';
      }).join('');
      if (S.dec.a && S.dec.b) decRun();
      else setStatus('还差一张', 'busy');
    } catch (e) {
      console.error(e);
      setStatus('读取失败: ' + e.message, 'err');
    }
  }

  function nearestPow2(n) {
    var p = 1;
    while (p * 2 <= n) p *= 2;
    var up = p * 2;
    return (n / p > (up / n)) ? up : p;
  }

  function isPow2(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  function decRun() {
    var A = S.dec.a, B = S.dec.b;
    if (!A || !B) { setStatus('两张图都要先载入', 'err'); return; }

    /*
     * 以修改图为准确定工作尺寸：它通常是工具的输出（正方形、边长 2 的幂）。
     * 玩家手上的原图常常是另一个尺寸（比如 64x64 的服务器图标被导出成 512），
     * 这时把原图按编码时同样的适配方式缩放过去，而不是直接报"尺寸不一致"。
     */
    var N;
    if (B.w === B.h && isPow2(B.w) && B.w >= 64 && B.w <= 2048) {
      N = B.w;
    } else {
      N = nearestPow2(Math.min(B.w, B.h, A.w, A.h));
      if (N < 64) { setStatus('图像太小，无法可靠提取', 'err'); return; }
      if (N > 2048) N = 2048;
    }

    var mode = (S.dec.pack && S.dec.pack.image && S.dec.pack.image.fit) || 'cover';

    /* 四通道模式：四个通道各自独立求差分，互不干扰 */
    if (S.dec.mode === 'channels') {
      S.dec.fitNote = (A.w !== N || A.h !== N)
        ? (A.w + '×' + A.h + ' → ' + N + '×' + N + ' / ' + mode)
        : (N + '×' + N + ' / 原尺寸');
      setStatus('按四通道提取中…', 'busy');
      var Ds = [], c;
      for (c = 0; c < 4; c++) {
        var aC = decChannel(A, c), bC = decChannel(B, c);
        var fa = C.fitToGray(aC, A.w, A.h, N, mode);
        var fb = (B.w === N && B.h === N) ? Float32Array.from(bC) : C.fitToGray(bC, B.w, B.h, N, mode);
        Ds.push(F.diffMag(F.forward(fa, N), F.forward(fb, N), N));
      }
      S.dec.N = N;
      S.dec.Ds = Ds;
      S.dec.D = Ds[0];
      decExtract();
      return;
    }

    S.dec.Ds = null;
    S.dec.results = null;
    var gA = C.fitToGray(A.gray, A.w, A.h, N, mode);
    var gB = (B.w === N && B.h === N) ? Float32Array.from(B.gray) : C.fitToGray(B.gray, B.w, B.h, N, mode);

    S.dec.fitNote = (A.w !== N || A.h !== N)
      ? (A.w + '×' + A.h + ' → ' + N + '×' + N + ' / ' + mode)
      : (N + '×' + N + ' / 原尺寸');

    setStatus('提取中…', 'busy');
    var D = F.diffMag(F.forward(gA, N), F.forward(gB, N), N);
    S.dec.N = N;
    S.dec.D = D;
    decExtract();
  }

  /* 取出某张待检图的第 c 个通道（0..3 = R,G,B,A），不做任何合成 */
  function decChannel(img, c) {
    var n = img.w * img.h, out = new Float32Array(n), i;
    if (c === 3) {
      out.set(img.alpha);
      return out;
    }
    for (i = 0; i < n; i++) out[i] = img.rgb[i * 3 + c];
    return out;
  }

  function decExtract() {
    if (S.dec.mode === 'channels' && S.dec.Ds) return decExtractChannels();
    var N = S.dec.N, D = S.dec.D;
    if (!N || !D) return;
    var bandMin = +$('decBandMin').value, bandMax = +$('decBandMax').value;
    if ($('decOuter') && !$('decOuter').checked) bandMax = 2;
    var auto = $('decAuto').checked;
    var maxD = 0;
    for (var i = 0; i < D.length; i++) if (D[i] > maxD) maxD = D[i];
    var threshold = null;
    if (!auto) {
      threshold = (+$('decThresh').value / 1000) * maxD;
      $('decThreshVal').textContent = threshold.toExponential(2);
    } else {
      $('decThreshVal').textContent = '自动';
    }
    var res = F.extract({ D: D, N: N, bandMin: bandMin, bandMax: bandMax, threshold: threshold });
    S.dec.result = res;

    var cv = $('decCvOut');
    cv.width = N;
    cv.height = N;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(N, N);
    for (var k = 0; k < N * N; k++) {
      var v = res.mask[k] ? 255 : 0;
      img.data[k * 4] = v; img.data[k * 4 + 1] = v; img.data[k * 4 + 2] = v; img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    $('decEmptyOut').classList.add('hidden');
    $('btnDecSave').disabled = false;

    var rows = [
      ['工作尺寸', N + ' × ' + N],
      ['原图适配', S.dec.fitNote || '—'],
      ['阈值', res.threshold.toExponential(2)],
      ['判定为选点', String(res.bins)]
    ];
    var iou = null;
    if (S.dec.pack && S.dec.pack.maskRle) {
      try {
        var packMask = C.rleDecode(S.dec.pack.maskRle, N * N);
        iou = F.iouHalf(res.mask, packMask, N);
        rows.push(['谜题包 IoU', (iou * 100).toFixed(1) + '%']);
      } catch (e) { /* 尺寸不符则忽略 */ }
    }
    $('decStats').innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span>';
    }).join('');
    if (iou !== null) setStatus(iou > 0.95 ? '校验通过 ' + (iou * 100).toFixed(1) + '%' : '与谜题包不符 ' + (iou * 100).toFixed(1) + '%', iou > 0.95 ? 'ok' : 'err');
    else setStatus('提取完成 · ' + res.bins + ' 点', 'ok');
  }

  /*
   * 四通道提取：每个通道独立走一遍 Otsu + 阈值。
   * 「全部」视图把四张掩码合成一张彩色图（R 红 / G 绿 / B 蓝 / A 白）。
   */
  function decExtractChannels() {
    var N = S.dec.N, Ds = S.dec.Ds;
    if (!N || !Ds) return;
    var bandMin = +$('decBandMin').value, bandMax = +$('decBandMax').value;
    if ($('decOuter') && !$('decOuter').checked) bandMax = 2;
    var auto = $('decAuto').checked;
    var results = [], c, i;
    var floorD = 8 * F.quantNoiseStd(N, 16);
    for (c = 0; c < 4; c++) {
      var D = Ds[c], maxD = 0;
      for (i = 0; i < D.length; i++) if (D[i] > maxD) maxD = D[i];
      if (maxD < floorD) {
        /*
         * 这个通道根本没藏东西：差分全在 16 位量化噪声里。
         * 交给 Otsu 只会把噪声劈成两半、解出一片麻点，所以直接判空。
         */
        results.push({ mask: new Uint8Array(N * N), threshold: 0, bins: 0, empty: true });
        continue;
      }
      var th = auto ? null : (+$('decThresh').value / 1000) * maxD;
      results.push(F.extract({ D: D, N: N, bandMin: bandMin, bandMax: bandMax, threshold: th }));
    }
    S.dec.results = results;
    $('decThreshVal').textContent = auto ? '自动 / 各通道' : '手动（按各通道峰值）';

    renderDecChanView();

    var rows = [
      ['工作尺寸', N + ' × ' + N],
      ['频谱模式', '四通道独立'],
      ['原图适配', S.dec.fitNote || '—']
    ];
    var packMasks = null;
    if (S.dec.pack && S.dec.pack.channelMasks) {
      try {
        packMasks = S.dec.pack.channelMasks.map(function (r) { return C.rleDecode(r, N * N); });
      } catch (e2) { packMasks = null; }
    }
    var ious = [];
    for (c = 0; c < 4; c++) {
      var extra = '';
      if (packMasks) {
        var iou = F.iouHalf(results[c].mask, packMasks[c], N);
        ious.push(iou);
        extra = ' · IoU ' + (iou * 100).toFixed(1) + '%';
      }
      rows.push([CH_KEYS[c] + ' 通道',
        (results[c].empty ? '无信号（没藏东西）' : results[c].bins + ' 点') + extra]);
    }
    $('decStats').innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v" title="' + esc(r[1]) + '">' + esc(r[1]) + '</span>';
    }).join('');
    $('btnDecSave').disabled = false;

    if (ious.length) {
      var worst = Math.min.apply(null, ious);
      setStatus(worst > 0.95
        ? '四通道校验通过 · 最差 ' + (worst * 100).toFixed(1) + '%'
        : '与谜题包不符 · 最差 ' + (worst * 100).toFixed(1) + '%',
        worst > 0.95 ? 'ok' : 'err');
    } else {
      var sum = 0;
      for (c = 0; c < 4; c++) sum += results[c].bins;
      setStatus('四通道提取完成 · 合计 ' + sum + ' 点', 'ok');
    }
  }

  function renderDecChanView() {
    var N = S.dec.N, results = S.dec.results;
    if (!N || !results) return;
    var cv = $('decCvOut');
    cv.width = N;
    cv.height = N;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(N, N);
    var view = S.dec.viewChan;
    for (var k = 0; k < N * N; k++) {
      var r = 0, g = 0, b = 0;
      if (view === 'all') {
        r = results[0].mask[k] ? 255 : 0;
        g = results[1].mask[k] ? 255 : 0;
        b = results[2].mask[k] ? 255 : 0;
        if (results[3].mask[k]) {
          r = Math.min(255, r + 235); g = Math.min(255, g + 235); b = Math.min(255, b + 235);
        }
      } else {
        r = g = b = results[view].mask[k] ? 255 : 0;
      }
      img.data[k * 4] = r;
      img.data[k * 4 + 1] = g;
      img.data[k * 4 + 2] = b;
      img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    $('decEmptyOut').classList.add('hidden');
  }

  function setDecChan(v) {
    S.dec.viewChan = v;
    for (var c = 0; c < 4; c++) {
      var el = $('decChan' + c);
      if (el) el.classList.toggle('active', v === c);
    }
    var all = $('decChanAll');
    if (all) all.classList.toggle('active', v === 'all');
    if (S.dec.results) renderDecChanView();
  }

  /* ===================================================================
   * 事件
   * =================================================================== */

  function showView(name) {
    ['encode', 'decode', 'help'].forEach(function (v) {
      $('view' + v[0].toUpperCase() + v.slice(1)).classList.toggle('hidden', v !== name);
      $('tab' + v[0].toUpperCase() + v.slice(1)).classList.toggle('active', v === name);
    });
  }

  function setTool(t) {
    S.tool = t;
    ['brush', 'erase', 'text'].forEach(function (k) {
      $('tool' + k[0].toUpperCase() + k.slice(1)).classList.toggle('active', k === t);
    });
    $('textRow').classList.toggle('hidden', t !== 'text');
    $('boardStack').style.cursor = t === 'text' ? 'text' : 'crosshair';
    boardHint(t === 'text' ? '点击画板放置文字；镜像会自动补全' : '');
  }

  function syncParamLabels() {
    $('bandMinVal').textContent = (+$('bandMin').value).toFixed(2);
    var outerChk = $('chkOuter');
    $('bandMaxVal').textContent = (outerChk && !outerChk.checked) ? '不限' : (+$('bandMax').value).toFixed(2);
    $('densityVal').textContent = $('density').value + '%';
    $('maxBinsVal').textContent = $('maxBins').value;
    $('strengthVal').textContent = strengthLabel();
  }

  function bind() {
    on($('tabEncode'), 'click', function () { showView('encode'); });
    on($('tabDecode'), 'click', function () { showView('decode'); });
    on($('tabHelp'), 'click', function () { showView('help'); });

    on($('btnPickSrc'), 'click', function () { $('fileInput').click(); });
    on($('srcDrop'), 'click', function () { $('fileInput').click(); });
    on($('fileInput'), 'change', function (e) {
      if (e.target.files && e.target.files[0]) loadSource(e.target.files[0]);
      e.target.value = '';
    });

    function dropTarget(el, handler) {
      on(el, 'dragover', function (e) { e.preventDefault(); el.classList.add('dragover'); });
      on(el, 'dragleave', function () { el.classList.remove('dragover'); });
      on(el, 'drop', function (e) {
        e.preventDefault();
        el.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
      });
    }
    dropTarget($('srcDrop'), loadSource);
    dropTarget($('decDropA'), function (f) { decLoad('a', f); });
    dropTarget($('decDropB'), function (f) { decLoad('b', f); });

    ['chan0', 'chan1', 'chan2', 'chan3'].forEach(function (id, c) {
      on($(id), 'click', function () { setChan(c); });
    });

    on($('toolBrush'), 'click', function () { setTool('brush'); });
    on($('toolErase'), 'click', function () { setTool('erase'); });
    on($('toolText'), 'click', function () { setTool('text'); });
    on($('brushSize'), 'input', function () {
      S.brush = +this.value;
      $('brushSizeVal').textContent = this.value;
      renderHud();
    });
    on($('textSize'), 'input', function () { $('textSizeVal').textContent = this.value; });

    on($('btnUndo'), 'click', function () {
      if (!S.undo.length) return;
      S.redo.push({ chan: chanMode() ? S.chan : -1, mask: Uint8Array.from(S.mask) });
      applySnapshot(S.undo.pop());
      scheduleCompute(60);
    });
    on($('btnRedo'), 'click', function () {
      if (!S.redo.length) return;
      S.undo.push({ chan: chanMode() ? S.chan : -1, mask: Uint8Array.from(S.mask) });
      applySnapshot(S.redo.pop());
      scheduleCompute(60);
    });
    on($('btnClear'), 'click', function () {
      pushUndo();
      S.mask.fill(0);
      updateChanTabs();
      renderMask();
      scheduleCompute(60);
      boardHint(chanMode() ? '已清空 ' + CH_NAMES[S.chan] + ' 画板（其它通道不受影响）' : '');
    });
    on($('btnLoadMask'), 'click', function () { $('maskInput').click(); });
    on($('maskInput'), 'change', async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        var img = await readImageFile(f);
        var N = S.N;
        var g;
        if (img.ch >= 3) {
          var rgb = new Float32Array(img.w * img.h * 3);
          for (var i = 0; i < img.w * img.h; i++) {
            rgb[i * 3] = img.data[i * 3];
            rgb[i * 3 + 1] = img.data[i * 3 + 1];
            rgb[i * 3 + 2] = img.data[i * 3 + 2];
          }
          var rs = resampleRect(rgb, img.w, img.h, 3, 0, 0, img.w, img.h, N, N);
          g = new Float32Array(N * N);
          for (var j = 0; j < N * N; j++) g[j] = (rs[j * 3] + rs[j * 3 + 1] + rs[j * 3 + 2]) / 3;
        } else {
          g = resampleRect(img.data, img.w, img.h, 1, 0, 0, img.w, img.h, N, N);
        }
        var p = readParams();
        var dc = (N >> 1) * N + (N >> 1);
        pushUndo();
        S.mask.fill(0);
        var added = 0;
        for (var y = 0; y < N; y++) {
          for (var x = 0; x < N; x++) {
            if (g[y * N + x] < 0.5) continue;
            var i0 = y * N + x;
            if (i0 === dc) continue;
            if (!inBand(S.band[i0], p)) continue;
            if (!S.mask[i0]) added++;
            S.mask[i0] = 1;
            var mi0 = F.mirrorCell(x, y, N);
            if (mi0 !== i0) S.mask[mi0] = 1;
          }
        }
        updateChanTabs();
        renderMask();
        boardHint('掩码图已载入：' + added + ' 个频点（镜像已自动补全）' +
          (chanMode() ? '（只影响当前 ' + CH_KEYS[S.chan] + ' 画板）' : ''));
        scheduleCompute(60);
      } catch (err) {
        console.error(err);
        setStatus('掩码图读取失败', 'err');
      }
    });

    var stack = $('boardStack');
    on(stack, 'pointerdown', function (e) {
      if (!S.src) return;
      e.preventDefault();
      var pt = pointerBin(e);
      cursor = pt;
      if (S.tool === 'text') { applyText(pt); renderHud(); return; }
      if (stack.setPointerCapture) stack.setPointerCapture(e.pointerId);
      pushUndo();
      drawing = true;
      lastPt = pt;
      stamp(pt.x, pt.y, S.brush, S.tool === 'erase' ? 0 : 1);
      renderMask();
      renderHud();
    });
    on(stack, 'pointermove', function (e) {
      if (!S.src) return;
      var pt = pointerBin(e);
      cursor = pt;
      if (drawing && lastPt) {
        strokeSegment(lastPt, pt);
        lastPt = pt;
        renderMask();
      }
      renderHud();
    });
    on(stack, 'pointerup', function () {
      if (drawing) { drawing = false; lastPt = null; scheduleCompute(60); }
    });
    on(stack, 'pointercancel', function () {
      if (drawing) { drawing = false; lastPt = null; scheduleCompute(60); }
    });
    on(stack, 'pointerleave', function () {
      cursor = null;
      renderHud();
    });

    on($('outTabImg'), 'click', function () {
      S.view = 'img';
      $('outTabImg').classList.add('active');
      $('outTabDiff').classList.remove('active');
      $('gainRow').classList.add('hidden');
      renderOut();
    });
    on($('outTabDiff'), 'click', function () {
      S.view = 'diff';
      $('outTabDiff').classList.add('active');
      $('outTabImg').classList.remove('active');
      $('gainRow').classList.remove('hidden');
      renderOut();
    });
    on($('diffGain'), 'input', function () {
      $('diffGainVal').textContent = this.value === '0' ? '自动' : (this.value / 50).toFixed(1) + '×';
      if (S.view === 'diff') renderOut();
    });

    (function () {
      var chk = $('chkOuter');
      if (chk) {
        on(chk, 'change', function () {
          $('bandMax').disabled = !chk.checked;
          syncParamLabels();
          renderSpec();
          renderHud();
          scheduleCompute(80);
        });
      }
      var dchk = $('decOuter');
      if (dchk) {
        on(dchk, 'change', function () {
          $('decBandMax').disabled = !dchk.checked;
          if (!dchk.checked) $('decBandMaxVal').textContent = '不限';
          else $('decBandMaxVal').textContent = (+$('decBandMax').value).toFixed(2);
          decExtract();
        });
      }
    })();

    ['bandMin', 'bandMax', 'density', 'maxBins', 'selMode', 'strength', 'keyInput', 'selColor', 'selFit'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var ev = (el.tagName === 'SELECT' || el.type === 'text') ? 'change' : 'input';
      on(el, ev, function () {
        syncParamLabels();
        if (id === 'selFit') {
          S.fit = el.value;
          if (S.src) { rebuildFit(); renderSource(); renderSpec(); updateSrcMeta(); }
        }
        if (id === 'selColor') { setColorMode(el.value); return; }
        if (id === 'bandMin' || id === 'bandMax') renderSpec();
        renderHud();
        scheduleCompute(160);
      });
      if (el.type === 'text') {
        on(el, 'input', function () { syncParamLabels(); scheduleCompute(500); });
      }
    });

    on($('selN'), 'change', function () {
      var N = +this.value, old = S.N;
      S.N = N;
      resizeCanvases(N);
      resizeMasks(N, old);
      syncParamLabels();
      updateChanTabs();
      if (S.src) {
        S.fit = $('selFit').value;
        rebuildFit();
        renderSource();
        renderSpec();
      }
      renderMask();
      renderHud();
      updateSrcMeta();
      scheduleCompute(60);
    });

    on($('btnRandKey'), 'click', function () {
      var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
      for (var i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
      $('keyInput').value = s;
      syncParamLabels();
      scheduleCompute(80);
    });

    on($('chkAuto'), 'change', function () {
      S.auto = this.checked;
      if (S.auto) compute();
    });
    on($('btnRecompute'), 'click', function () { compute(); });

    on($('btnSaveOut'), 'click', exportPng16);
    on($('btnExp16'), 'click', exportPng16);
    on($('btnExpTif'), 'click', exportTiff);
    on($('btnExp8'), 'click', exportPng8);
    on($('btnExpMask'), 'click', exportMask);
    on($('btnExpDiff'), 'click', exportDiff);
    on($('btnExpPack'), 'click', exportPack);
    on($('btnExpReadme'), 'click', exportReadme);
    on($('btnCopyKey'), 'click', function () {
      var t = $('keyInput').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { setStatus('密钥已复制', 'ok'); });
      }
    });

    on($('decDropA'), 'click', function () { $('decInputA').click(); });
    on($('decDropB'), 'click', function () { $('decInputB').click(); });
    on($('decInputA'), 'change', function (e) {
      if (e.target.files[0]) decLoad('a', e.target.files[0]);
      e.target.value = '';
    });
    on($('decInputB'), 'change', function (e) {
      if (e.target.files[0]) decLoad('b', e.target.files[0]);
      e.target.value = '';
    });
    on($('btnDecRun'), 'click', decExtract);
    on($('decAuto'), 'change', function () {
      $('decThresh').disabled = this.checked;
      decExtract();
    });
    on($('decThresh'), 'input', decExtract);
    ['decBandMin', 'decBandMax'].forEach(function (id) {
      on($(id), 'input', function () {
        $('decBandMinVal').textContent = (+$('decBandMin').value).toFixed(2);
        $('decBandMaxVal').textContent = (+$('decBandMax').value).toFixed(2);
        decExtract();
      });
    });
    on($('btnDecSave'), 'click', async function () {
      var N = S.dec.N;
      if (S.dec.results) {
        /* 四通道：存一张 RGBA 掩码，四个通道各一份 */
        if (!N) return;
        var img4 = new Float32Array(N * N * 4);
        for (var c = 0; c < 4; c++) {
          var m = S.dec.results[c].mask;
          for (var k = 0; k < N * N; k++) img4[k * 4 + c] = m[k] ? 1 : 0;
        }
        download(await C.encodePng(img4, N, N, 4, 8), 'extracted_mask_rgba_' + N + '.png', 'image/png');
        setStatus('已保存四通道提取结果', 'ok');
        return;
      }
      var res = S.dec.result;
      if (!res) return;
      var img = new Float32Array(N * N);
      for (var i = 0; i < N * N; i++) img[i] = res.mask[i] ? 1 : 0;
      download(await C.encodePng(img, N, N, 1, 8), 'extracted_mask_' + N + '.png', 'image/png');
      setStatus('已保存提取结果', 'ok');
    });

    on($('decMode'), 'change', function () {
      S.dec.mode = this.value;
      $('decChanRow').classList.toggle('hidden', this.value !== 'channels');
      if (S.dec.a && S.dec.b) decRun();
    });
    on($('decChanAll'), 'click', function () { setDecChan('all'); });
    on($('decChan0'), 'click', function () { setDecChan(0); });
    on($('decChan1'), 'click', function () { setDecChan(1); });
    on($('decChan2'), 'click', function () { setDecChan(2); });
    on($('decChan3'), 'click', function () { setDecChan(3); });
    on($('btnDecPack'), 'click', function () { $('packInput').click(); });
    on($('packInput'), 'change', async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        var pack = JSON.parse(await f.text());
        S.dec.pack = pack;
        $('decPackName').value = f.name;
        if (pack.band) {
          $('decBandMin').value = pack.band.min;
          $('decBandMax').value = pack.band.max;
          $('decBandMinVal').textContent = (+pack.band.min).toFixed(2);
          $('decBandMaxVal').textContent = (+pack.band.max).toFixed(2);
          if ($('decOuter') && typeof pack.band.outerLimited === 'boolean') {
            $('decOuter').checked = pack.band.outerLimited;
            $('decBandMax').disabled = !pack.band.outerLimited;
            if (!pack.band.outerLimited) $('decBandMaxVal').textContent = '不限';
          }
        }
        /* 谜题包会告诉玩家该用哪种频谱模式，省得猜 */
        var chPack = !!(pack.channelMasks && pack.channelMasks.length) ||
          !!(pack.output && (pack.output.channelMode || pack.output.color === 'channels'));
        S.dec.mode = chPack ? 'channels' : 'gray';
        $('decMode').value = S.dec.mode;
        $('decChanRow').classList.toggle('hidden', !chPack);
        if (S.dec.a && S.dec.b) decRun();
        else setStatus('谜题包已载入', 'ok');
      } catch (err) {
        setStatus('谜题包解析失败', 'err');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        (e.shiftKey ? $('btnRedo') : $('btnUndo')).click();
      }
    });
  }

  /* ===================================================================
   * 启动
   * =================================================================== */

  function boot() {
    buildLut();
    initCanvases();
    bind();
    setTool('brush');
    syncParamLabels();
    S.band = F.bandTable(S.N);
    renderHud();
    $('diffGainVal').textContent = '自动';
    $('btnSaveOut').disabled = true;
    setColorMode($('selColor').value);
    updateChanTabs();
    setStatus('等待载入照片');
    if (/selftest/.test(location.search) && window.__runSelfTest) window.__runSelfTest();
  }

  window.__App = {
    S: S, F: F, C: C, compute: compute, loadSource: loadSource,
    readImageFile: readImageFile, fitToSquare: fitToSquare, resampleRect: resampleRect,
    renderSpec: renderSpec, renderMask: renderMask, renderHud: renderHud, renderOut: renderOut,
    buildPack: buildPack, setStatus: setStatus, updateMetrics: updateMetrics,
    decRun: decRun, decExtract: decExtract, strengthFromSlider: strengthFromSlider,
    setColorMode: setColorMode, setChan: setChan, updateChanTabs: updateChanTabs,
    computeChannels: computeChannels, renderDecChanView: renderDecChanView,
    decLoad: decLoad, setDecChan: setDecChan, decExtractChannels: decExtractChannels
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
