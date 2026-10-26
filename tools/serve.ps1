# 隔空撸宠 —— Windows 本地静态服务器
# 只用 Windows 自带的 PowerShell + .NET HttpListener，不需要装任何东西。
# 为什么必须用它：ES Module 和 wasm 在 file:// 下会被浏览器拦掉，
# 所以不能直接双击 index.html，必须走 http://。
# 由 START-Windows.bat 调用，关掉这个黑色窗口就停止服务。

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$port = 8766

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".wasm" = "application/wasm"
  ".task" = "application/octet-stream"
  ".tflite" = "application/octet-stream"
  ".json" = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".svg"  = "image/svg+xml"
  ".webp" = "image/webp"
  ".ico"  = "image/x-icon"
  ".txt"  = "text/plain; charset=utf-8"
  ".md"   = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  端口 $port 已被占用。" -ForegroundColor Yellow
  Write-Host "  可能已经开着一个了 —— 先关掉之前那个黑窗口，再双击一次。"
  Write-Host ""
  Read-Host "  按回车退出"
  exit 1
}

Write-Host ""
Write-Host "  隔空撸宠已启动：" -ForegroundColor Green
Write-Host "  http://localhost:$port/" -ForegroundColor Cyan
Write-Host ""
Write-Host "  玩的时候别关这个窗口，关掉就停了。"
Write-Host "  按 Ctrl + C 可以停止。"
Write-Host ""
Start-Process "http://localhost:$port/"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
    if ($rel -eq "") { $rel = "index.html" }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = "application/octet-stream" }
      # 开发期不缓存，改完刷新就能看到
      $res.Headers.Add("Cache-Control", "no-store")
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
