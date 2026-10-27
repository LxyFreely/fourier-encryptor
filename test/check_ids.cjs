/* 静态检查：脚本里引用的 DOM id 是否都在 index.html 中定义 */
'use strict';
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

var declared = new Set();
var re = /id="([^"]+)"/g, m;
while ((m = re.exec(html))) declared.add(m[1]);

/* 运行时才创建的元素 */
var RUNTIME = new Set(['selftest']);

var used = new Set();
['src/app.js', 'src/selftest.js'].forEach(function (f) {
  var src = fs.readFileSync(path.join(root, f), 'utf8');
  var pats = [/\$\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g, /setMetric\('([^']+)'/g];
  pats.forEach(function (re2) {
    var mm;
    while ((mm = re2.exec(src))) used.add(mm[1]);
  });
});

var missing = [];
used.forEach(function (id) {
  if (!declared.has(id) && !RUNTIME.has(id)) missing.push(id);
});

/* 由前缀拼接出来的 id，逐个登记核对 */
['viewEncode', 'viewDecode', 'viewHelp', 'tabEncode', 'tabDecode', 'tabHelp'].forEach(function (id) {
  if (!declared.has(id)) missing.push(id);
});

var unused = [];
declared.forEach(function (id) {
  if (!used.has(id)) unused.push(id);
});

console.log('HTML 定义 id: ' + declared.size + '  |  脚本引用 id: ' + used.size);
if (missing.length) {
  console.log('缺少的 id（运行时会报错）: ' + missing.join(', '));
} else {
  console.log('检查通过：所有引用的 id 均已定义');
}
if (unused.length) console.log('未被脚本直接引用: ' + unused.join(', '));
process.exit(missing.length ? 1 : 0);
