param([string]$RepoRoot)
# Usage (Windows PowerShell): powershell -ExecutionPolicy Bypass -File scripts/make-installer-art.ps1 -RepoRoot .
# Generates the AnxOS installer artwork (24-bit BMPs, as NSIS Modern UI needs):
#   sidebar.bmp   164x314  Welcome / Finish pages (installer and uninstaller)
#   header.bmp    150x57   header of the inner pages
# Charcoal background with a purple glow, the AnxOS icon and wordmark.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $RepoRoot "windows\installer-art"
New-Item -ItemType Directory -Force $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Join-Path $RepoRoot "assets\icons\png\256x256.png"))

$charcoalTop = [System.Drawing.Color]::FromArgb(255, 24, 21, 33)
$charcoalBottom = [System.Drawing.Color]::FromArgb(255, 14, 12, 20)
$purple = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)
$purpleSoft = [System.Drawing.Color]::FromArgb(255, 192, 168, 255)
$muted = [System.Drawing.Color]::FromArgb(255, 150, 144, 170)

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"; $g.InterpolationMode = "HighQualityBicubic"; $g.TextRenderingHint = "AntiAliasGridFit"
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $charcoalTop, $charcoalBottom, 90
  $g.FillRectangle($bg, $rect)
  return @($bmp, $g)
}

function Add-Glow($g, $cx, $cy, $radius, $alpha) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $radius, $cy - $radius, 2 * $radius, 2 * $radius)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = [System.Drawing.Color]::FromArgb($alpha, 139, 92, 246)
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 139, 92, 246))
  $g.FillPath($brush, $path)
}

# Sidebar (164x314)
$canvas = New-Canvas 164 314; $bmp = $canvas[0]; $g = $canvas[1]
Add-Glow $g 82 92 110 120
Add-Glow $g 150 300 90 60
$g.DrawImage($icon, 42, 46, 80, 80)
$title = New-Object System.Drawing.Font "Segoe UI Semibold", 15, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$subtitle = New-Object System.Drawing.Font "Segoe UI", 11.5, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font "Segoe UI", 10, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$center = New-Object System.Drawing.StringFormat; $center.Alignment = "Center"
$g.DrawString("AnxOS", $title, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), (New-Object System.Drawing.RectangleF 0, 140, 164, 22), $center)
$g.DrawString("Control Center", $subtitle, (New-Object System.Drawing.SolidBrush $purpleSoft), (New-Object System.Drawing.RectangleF 0, 162, 164, 18), $center)
$pen = New-Object System.Drawing.Pen $purple, 2
$g.DrawLine($pen, 62, 190, 102, 190)
$g.DrawString("Servers, made simple.", $small, (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF 0, 200, 164, 16), $center)
$g.DrawString("by AnxLabs", $small, (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF 0, 288, 164, 16), $center)
$g.Dispose(); $bmp.Save((Join-Path $out "sidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()

# Header (150x57), shown at the right of the dark header bar
$canvas = New-Canvas 150 57; $bmp = $canvas[0]; $g = $canvas[1]
$g.Clear([System.Drawing.Color]::FromArgb(255, 24, 21, 33))
Add-Glow $g 120 28 48 90
$g.DrawImage($icon, 104, 10, 36, 36)
$right = New-Object System.Drawing.StringFormat; $right.Alignment = "Far"
$g.DrawString("AnxOS", $title, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), (New-Object System.Drawing.RectangleF 0, 9, 98, 20), $right)
$g.DrawString("by AnxLabs", $small, (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF 0, 30, 98, 16), $right)
$g.Dispose(); $bmp.Save((Join-Path $out "header.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
$icon.Dispose()
Get-ChildItem $out | ForEach-Object { "$($_.Name) $($_.Length) bytes" }
