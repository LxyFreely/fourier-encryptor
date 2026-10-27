# 一键跑全部测试：pwsh -File test\run_all.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name, $block) {
  Write-Host ""
  Write-Host "===== $name =====" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $name" -ForegroundColor Red
    exit 1
  }
}

$png = "demo/demo_A_original_16bit.png"
$pngB = "demo/demo_B_modified_16bit.png"
$tifA = "demo/demo_A_original_f32.tif"
$tifB = "demo/demo_B_modified_f32.tif"
$truth = "demo/demo_truth_mask.png"
$pack = "demo/demo_puzzle.json"

Step "核心数学 / FFT / 提取" { node test/core.test.cjs }
Step "编解码 (PNG16 / TIFF / RLE)" { node test/codec.test.cjs }
Step "PNG 文本块" { node test/textchunk.cjs }
Step "RGBA / alpha 通道归一化" { node test/rgba.test.cjs }
Step "四通道独立频谱（各藏各的）" { node test/channels.test.cjs }
Step "玩家流程（原图与修改图尺寸不同）" { node test/decoder.test.cjs }
Step "自由绘制 / 共轭 / 外径开关" { node test/freepaint.test.cjs }
Step "静态检查 DOM id" { node test/check_ids.cjs }
Step "生成 demo 与谜题包" { node test/e2e.cjs }
Step "格式第三方校验 (PIL/tifffile)" { python test/verify_formats.py }
Step "独立 Python 提取器 (16 位 PNG)" { python tools/extract.py $png $pngB -o test/out_cross_png.png --truth $truth --pack $pack }
Step "独立 Python 提取器 (float32 TIFF)" { python tools/extract.py $tifA $tifB -o test/out_cross_tif.png --truth $truth --pack $pack }
Step "独立 Python 提取器 (8 位 PNG)" { python tools/extract.py $png demo/demo_B_modified_8bit.png -o test/out_cross_8.png --truth $truth --pack $pack }

Write-Host ""
Write-Host "全部通过" -ForegroundColor Green
