"""Standard-library HTTP server: JSON API under /api plus static files from web/.

  POST /api/applications                 submit (documents as {type, filename, text})
  GET  /api/applications                 list for the ops dashboard
  GET  /api/applications/{id}            detail + audit trail
  POST /api/applications/{id}/review     {reviewer, outcome: APPROVE|DECLINE, note}
  GET  /api/stats                        counts, queue size, avg risk, component status
  POST /api/reset                        reload sample data (demo convenience)
  GET  /api/samples                      sample applicants (quick-fill + "use sample document")
  GET  /api/outbox?ids=MCL-1001,...      mock notification inbox

Errors are JSON: 400 bad input, 404 unknown id/route, 413 body too large,
500 generic message (the traceback goes to the server console, never the browser).
"""
from __future__ import annotations

import json
import re
import sys
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import notify, pipeline
from .store import Store

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = 1_000_000
APP_PATH = re.compile(r"^/api/applications/(?P<id>[A-Za-z0-9\-]{1,20})(?P<review>/review)?$")

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class Handler(SimpleHTTPRequestHandler):
    store: Store
    quiet = False
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp",
        ".mp4": "video/mp4", ".json": "application/json", ".html": "text/html; charset=utf-8",
        ".woff2": "font/woff2",
    }

    # --- plumbing ---------------------------------------------------------------------
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)

    def list_directory(self, path):  # no directory listings
        self.send_error(404, "Not found")
        return None

    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Invalid Content-Length.") from None
        if length > MAX_BODY:
            raise ApiError(413, "Request body too large (max 1 MB).")
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Request body must be valid JSON.") from None
        if not isinstance(data, dict):
            raise ApiError(400, "Request body must be a JSON object.")
        return data

    def _dispatch(self, route) -> None:
        try:
            status, payload = route(urlsplit(self.path))
            self._json(status, payload)
        except ApiError as e:
            self._json(e.status, {"error": e.message})
        except ValueError as e:  # validation failures from intake / underwriting
            self._json(400, {"error": str(e)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {"error": "Internal server error."})

    # --- routes -----------------------------------------------------------------------
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            return self._dispatch(self._get_api)
        if path.endswith("/") or path in ("", "/"):
            self.path = "/index.html"
        return super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self._json(405, {"error": "Method not allowed."})
        return super().do_HEAD()

    def do_POST(self):
        return self._dispatch(self._post_api)

    def _get_api(self, url):
        store = self.store
        if url.path == "/api/applications":
            return 200, pipeline.list_summaries(store)
        if url.path == "/api/stats":
            return 200, pipeline.stats(store)
        if url.path == "/api/samples":
            return 200, pipeline.load_samples()
        if url.path == "/api/outbox":
            ids = parse_qs(url.query).get("ids", [""])[0]
            wanted = {i for i in ids.split(",") if i} if ids else None
            return 200, list(reversed(notify.outbox(store, wanted)))
        m = APP_PATH.match(url.path)
        if m and not m.group("review"):
            detail = pipeline.get_detail(store, m.group("id"))
            if detail is None:
                raise ApiError(404, f"Application {m.group('id')} not found.")
            return 200, detail
        raise ApiError(404, "Not found.")

    def _post_api(self, url):
        if url.path == "/api/applications":
            return 201, pipeline.submit_application(self.store, self._body())
        if url.path == "/api/reset":
            pipeline.seed_samples(self.store)
            return 200, pipeline.stats(self.store)
        m = APP_PATH.match(url.path)
        if m and m.group("review"):
            body = self._body()
            try:
                return 200, pipeline.review_application(
                    self.store, m.group("id"), body.get("reviewer"), body.get("outcome"), body.get("note"))
            except KeyError:
                raise ApiError(404, f"Application {m.group('id')} not found.") from None
        raise ApiError(404, "Not found.")


def make_server(store: Store, host: str = "127.0.0.1", port: int = 8000, quiet: bool = False) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"store": store, "quiet": quiet})
    server = ThreadingHTTPServer((host, port), partial(handler, directory=str(WEB_DIR)))
    server.daemon_threads = True
    return server
