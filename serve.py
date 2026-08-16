#!/usr/bin/env python3
"""
Tiny dev server for the Philadelphia Time Machine.

Plain `python3 -m http.server` works, but the building file is ~22 MB of JSON
that compresses to ~2.5 MB. This adds gzip for text payloads and reports the
uncompressed size so the loading bar can show real progress.

    python3 serve.py [port]        # default 8899
"""

import gzip
import http.server
import io
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ROOT = os.path.dirname(os.path.abspath(__file__))

COMPRESS = (".json", ".geojson", ".js", ".css", ".html", ".svg")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Dev server: never let a stale asset survive a reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")

        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
        if not (accepts_gzip and path.endswith(COMPRESS) and os.path.isfile(path)):
            return super().do_GET()

        with open(path, "rb") as fh:
            raw = fh.read()

        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
            gz.write(raw)
        body = buf.getvalue()

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        # app.js uses this to size its progress bar against the decoded stream.
        self.send_header("X-Uncompressed-Length", str(len(raw)))
        self.send_header("Access-Control-Expose-Headers", "X-Uncompressed-Length")
        self.end_headers()
        self.wfile.write(body)
        return None

    def log_message(self, fmt, *args):
        if args and "geojson" in str(args[0]):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Philadelphia Time Machine  ->  http://localhost:{PORT}")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
