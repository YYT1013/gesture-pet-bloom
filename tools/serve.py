#!/usr/bin/env python3
"""隔空撸宠 —— 跨平台本地静态服务器（macOS / Linux / Windows 通用）

为什么需要它：
  1. ES Module 和 .wasm 在 file:// 下会被浏览器拦掉，必须走 http://；
  2. Python 自带的 `python -m http.server` 把 .mjs 当成 text/plain，
     浏览器会拒绝执行模块脚本 —— 这里补上了正确的 MIME。

用法：
  python3 tools/serve.py            # 默认 8766，端口被占用会自动往后找
  python3 tools/serve.py 9000       # 指定端口
  python3 tools/serve.py 9000 -q    # 不自动打开浏览器
"""

import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRA_TYPES = {
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".tflite": "application/octet-stream",
    ".json": "application/json; charset=utf-8",
    ".webp": "image/webp",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # 开发期不缓存，改完刷新就能看到
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静模式，报错才说话


def free_port(start: int) -> int:
    for p in range(start, start + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("找不到空闲端口")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    quiet = "-q" in sys.argv
    port = free_port(int(args[0]) if args else 8766)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        url = f"http://localhost:{port}/"
        print("")
        print(f"  隔空撸宠已启动：{url}")
        print("  玩的时候别关这个窗口，Ctrl+C 停止。")
        print("")
        if not quiet:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  已停止。")


if __name__ == "__main__":
    main()
