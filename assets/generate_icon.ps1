Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Clear background (transparent)
$g.Clear([System.Drawing.Color]::Transparent)

# 1. Base rounded rectangle (Navy / Slate #0F172A to #1E293B)
$rect = New-Object System.Drawing.Rectangle(4, 4, ($size - 8), ($size - 8))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 48
$diameter = $radius * 2
$arc = New-Object System.Drawing.Rectangle($rect.X, $rect.Y, $diameter, $diameter)

# Top-left arc
$path.AddArc($arc, 180, 90)
# Top-right arc
$arc.X = $rect.Right - $diameter
$path.AddArc($arc, 270, 90)
# Bottom-right arc
$arc.Y = $rect.Bottom - $diameter
$path.AddArc($arc, 0, 90)
# Bottom-left arc
$arc.X = $rect.Left
$path.AddArc($arc, 90, 90)
$path.CloseFigure()

$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    ([System.Drawing.Color]::FromArgb(255, 30, 41, 59)),
    ([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
)
$g.FillPath($bgBrush, $path)

# Border stroke (#334155)
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 51, 65, 85), 3)
$g.DrawPath($borderPen, $path)

# Subtle inner decorative circle
$circlePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 148, 163, 184), 1.5)
$g.DrawEllipse($circlePen, 40, 40, 176, 176)

# Brushes for elements
$goldBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 179, 8))
$sageBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 185, 129))
$terraBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 196, 113, 74))
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$slateBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 41, 59))

$whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 4)
$chainPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 148, 163, 184), 2)

# Central Column
$g.FillRectangle($whiteBrush, 125, 60, 6, 130)
$g.FillEllipse($goldBrush, 121, 52, 14, 14)
$g.FillEllipse($slateBrush, 125, 56, 6, 6)

# Beam
$g.DrawLine($whitePen, 65, 95, 191, 95)
$g.FillEllipse($goldBrush, 123, 90, 10, 10)

# Left Scale (Chains & Pan)
$g.DrawLine($chainPen, 70, 96, 52, 145)
$g.DrawLine($chainPen, 70, 96, 88, 145)
$g.FillPie($sageBrush, 48, 130, 44, 32, 0, 180)
$g.FillEllipse($goldBrush, 50, 142, 40, 6)

# Right Scale (Chains & Pan)
$g.DrawLine($chainPen, 186, 96, 168, 145)
$g.DrawLine($chainPen, 186, 96, 204, 145)
$g.FillPie($sageBrush, 164, 130, 44, 32, 0, 180)
$g.FillEllipse($goldBrush, 166, 142, 40, 6)

# Wheat Ears on Left & Right
$g.FillEllipse($goldBrush, 64, 120, 12, 18)
$g.FillEllipse($goldBrush, 180, 120, 12, 18)
$g.FillEllipse($goldBrush, 58, 110, 10, 14)
$g.FillEllipse($goldBrush, 188, 110, 10, 14)

# Pedestal Base
$basePoints = @(
    (New-Object System.Drawing.Point(95, 190)),
    (New-Object System.Drawing.Point(161, 190)),
    (New-Object System.Drawing.Point(171, 208)),
    (New-Object System.Drawing.Point(85, 208))
)
$g.FillPolygon($terraBrush, $basePoints)
$g.FillRectangle($whiteBrush, 75, 208, 106, 8)

# Center Zimam Diamond Symbol
$diamondPoints = @(
    (New-Object System.Drawing.Point(128, 122)),
    (New-Object System.Drawing.Point(140, 137)),
    (New-Object System.Drawing.Point(128, 152)),
    (New-Object System.Drawing.Point(116, 137))
)
$g.FillPolygon($goldBrush, $diamondPoints)
$g.FillEllipse($slateBrush, 125, 134, 6, 6)

# Flush graphics
$g.Flush()

# Save PNG
$pngPath = Join-Path $PSScriptRoot "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Saved: $pngPath"

# Save ICO
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$icoPath = Join-Path $PSScriptRoot "icon.ico"
$stream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Close()
Write-Host "Saved: $icoPath"

# Dispose resources
$g.Dispose()
$bmp.Dispose()
