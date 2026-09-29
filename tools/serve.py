"""ローカル確認用サーバー: python tools/serve.py [port]
Windows のレジストリ設定で .js が text/plain になり ES モジュールが読めない問題を避ける。"""
import http.server
import sys
from pathlib import Path

Handler = http.server.SimpleHTTPRequestHandler
Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript"})

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
root = Path(__file__).resolve().parent.parent
Handler.directory = str(root)
print(f"http://localhost:{port}/  (root={root})")
http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
