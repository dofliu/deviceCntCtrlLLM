"""Loopback-only Claude bridge using an explicitly authorized key name.

Run: python claude_bridge.py
Then open http://127.0.0.1:8766/ in Chrome or Edge.
No third-party packages. No other credential names or files are inspected.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import threading
import time
import webbrowser
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

KEY_NAME = "ANTHROPIC_API_KEY"
AUTHORIZED_KEY_NAMES = (KEY_NAME, "ANTHROPIC_API_KEY_Extra")
UPSTREAM = "https://api.anthropic.com/v1"
MAX_BODY = 6 * 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
TOOLS = frozenset("inspect_device list_interfaces read_manual connect handshake write_driver test_driver start_control observe probe fit_model move reset_model verify inspect_scene select_goal lift grip verify_grasp verify_place stop".split())


def read_authorized_key(key_name: str = KEY_NAME) -> str:
    """Only the exact authorized name, never enumerate or fall back to other keys."""
    if key_name not in AUTHORIZED_KEY_NAMES:
        raise ValueError("Only explicitly authorized key names may be used.")
    value = os.environ.get(key_name, "").strip()
    if not value and os.name == "nt":
        import winreg
        locations = (
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        )
        for hive, path in locations:
            try:
                with winreg.OpenKey(hive, path) as registry_key:
                    candidate, _ = winreg.QueryValueEx(registry_key, key_name)
                if isinstance(candidate, str) and candidate.strip():
                    value = candidate.strip()
                    break
            except OSError:
                pass
    if not value or len(value) > 1024 or "\r" in value or "\n" in value:
        return ""
    return value


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def retry_after_seconds(value: object, *, now: float | None = None) -> float | None:
    """Only expose a finite delay, never the raw upstream header."""
    if not isinstance(value, str) or len(value) > 128:
        return None
    value = value.strip()
    try:
        if re.fullmatch(r"\d+(?:\.\d+)?", value):
            delay = float(value)
        else:
            stamp = parsedate_to_datetime(value)
            if stamp.tzinfo is None:
                return None
            delay = max(0.0, stamp.timestamp() - (time.time() if now is None else now))
        return delay if math.isfinite(delay) and delay >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def sanitized_upstream_error(status: int, raw: bytes, retry_after: object = None) -> dict:
    """Keep rate/spend classifications; never relay text or account identifiers."""
    result = {"code": "UPSTREAM_HTTP", "status": status, "retryable": False}
    if status != 429:
        return {"error": result}
    try:
        payload = json.loads(raw)
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        error = error if isinstance(error, dict) else {}
    except (ValueError, UnicodeError):
        error = {}
    details = error.get("details", {})
    details = details if isinstance(details, dict) else {}
    if details.get("error_code") == "enforced_spend_limit_reached":
        result.update(code="QUOTA_EXCEEDED", quotaKind="spend")
    else:
        delay = retry_after_seconds(retry_after)
        result.update(code="RATE_LIMITED", retryable=True,
                      quotaKind="rate" if error.get("type") == "rate_limit_error" or delay is not None else "unknown")
        if delay is not None:
            result["retryAfterSeconds"] = delay
    return {"error": result}


def upstream_request(route: str, key: str, body: dict | None = None) -> tuple[int, dict]:
    """The route is constructed internally, never supplied as an arbitrary URL."""
    request = Request(UPSTREAM + route, data=None if body is None else json.dumps(body).encode("utf-8"),
                      headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                      method="GET" if body is None else "POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=45) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            return 502, {"error": {"code": "UPSTREAM_TOO_LARGE"}}
        decoded = raw.decode("utf-8").replace(key, "[REDACTED]")
        result = json.loads(decoded)
        if not isinstance(result, dict):
            return 502, {"error": {"code": "UPSTREAM_FORMAT"}}
        # Do not relay thinking blocks, signed thoughts or arbitrary text to the UI.
        if route == "/messages":
            result = {"type": result.get("type"), "model": result.get("model"),
                      "stop_reason": result.get("stop_reason"), "usage": result.get("usage"),
                      "content": [b for b in result.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_use"]}
        return 200, result
    except HTTPError as error:
        raw = error.read(MAX_RESPONSE + 1)
        return error.code if 400 <= error.code <= 599 else 502, sanitized_upstream_error(
            error.code, raw if len(raw) <= MAX_RESPONSE else b"", error.headers.get("Retry-After") if error.headers else None)
    except (URLError, TimeoutError, OSError, ValueError):
        return 502, {"error": {"code": "UPSTREAM_UNAVAILABLE"}}


def validate_message(value: object) -> bool:
    if not isinstance(value, dict) or set(value) - {"model", "max_tokens", "system", "messages", "tools", "tool_choice"}:
        return False
    if not isinstance(value.get("model"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", value["model"]):
        return False
    if type(value.get("max_tokens")) is not int or not 1 <= value["max_tokens"] <= 8192:
        return False
    if not isinstance(value.get("system"), str) or len(value["system"]) > 12000:
        return False
    choice = value.get("tool_choice")
    if not isinstance(choice, dict) or set(choice) != {"type", "disable_parallel_tool_use"} or choice.get("type") not in ("auto", "any") or choice.get("disable_parallel_tool_use") is not True:
        return False
    tools = value.get("tools")
    if not isinstance(tools, list) or not 1 <= len(tools) <= len(TOOLS):
        return False
    if any(not isinstance(t, dict) or t.get("name") not in TOOLS or set(t) - {"name", "description", "input_schema"} for t in tools):
        return False
    if len({t["name"] for t in tools}) != len(tools):
        return False
    messages = value.get("messages")
    if not isinstance(messages, list) or len(messages) != 1 or not isinstance(messages[0], dict) or set(messages[0]) != {"role", "content"} or messages[0]["role"] != "user":
        return False
    content = messages[0]["content"]
    if not isinstance(content, list) or len(content) != 2:
        return False
    picture, text = content
    if not isinstance(picture, dict) or set(picture) != {"type", "source"} or picture["type"] != "image":
        return False
    source = picture["source"]
    if not isinstance(source, dict) or set(source) != {"type", "media_type", "data"} or source["type"] != "base64" or source["media_type"] != "image/png" or not isinstance(source["data"], str) or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", source["data"]):
        return False
    return isinstance(text, dict) and set(text) == {"type", "text"} and text["type"] == "text" and isinstance(text["text"], str) and len(text["text"]) <= 160000


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, port: int, html_path: Path, key: str, max_calls: int = 80, key_name: str = KEY_NAME):
        if key_name not in AUTHORIZED_KEY_NAMES:
            raise ValueError("Only explicitly authorized key names may be used.")
        super().__init__(("127.0.0.1", port), BridgeHandler)
        self.html_path, self._api_key = html_path, key
        self.key_name = key_name
        self.max_calls, self.calls = max_calls, 0
        self.call_lock = threading.Lock()
        self.upstream = upstream_request
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.host_header = f"127.0.0.1:{self.server_port}"


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "VLabClaudeBridge/2.0"

    def log_message(self, format, *args):
        pass  # Never log request bodies, headers, query strings or key material.

    def send_body(self, status, body: bytes, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reply(self, status, value):
        self.send_body(status, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def reject(self, status, code):
        error = {"code": code}
        if code == "BRIDGE_CALL_BUDGET":
            error.update(status=status, retryable=False, quotaKind="unavailable")
        self.reply(status, {"error": error})

    def same_origin(self, api=False):
        if self.client_address[0] != "127.0.0.1" or self.headers.get("Host") != self.server.host_header:
            self.reject(403, "HOST_REJECTED")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != self.server.origin:
            self.reject(403, "ORIGIN_REJECTED")
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            self.reject(403, "CROSS_SITE_REJECTED")
            return False
        if api and self.headers.get("X-Vlab-Bridge") != "1":
            self.reject(403, "BRIDGE_HEADER_REQUIRED")
            return False
        return True

    def do_OPTIONS(self):
        # No CORS: file:// or a remote page may not use this local credential.
        self.reject(403, "CROSS_ORIGIN_DISABLED")

    def do_GET(self):
        if not self.same_origin():
            return
        url = urlsplit(self.path)
        if url.path in ("/", "/unknown-device-v7.0.html", "/unknown-device-v6.3.html", "/unknown-device-v6.2.html", "/unknown-device-v6.1.html", "/unknown-device-v6.html", "/unknown-device-v5.3.html", "/unknown-device-v5.2.html", "/unknown-device-v5.html"):
            query = parse_qs(url.query, keep_blank_values=True)
            if query and (set(query) - {"agent", "model"}
                          or any(len(values) != 1 for values in query.values())
                          or query.get("agent") != ["claude"]
                          or ("model" in query and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", query["model"][0]))):
                self.reject(400, "INVALID_PAGE_QUERY")
                return
            try:
                self.send_body(200, self.server.html_path.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self.reject(404, "HTML_NOT_FOUND")
            return
        if not self.same_origin(api=True):
            return
        if url.path == "/api/claude/status" and not url.query:
            self.reply(200, {"available": bool(self.server._api_key), "credentialName": self.server.key_name, "calls": self.server.calls, "limit": self.server.max_calls})
            return
        if url.path != "/api/claude/models":
            self.reject(404, "NOT_FOUND")
            return
        query = parse_qs(url.query, keep_blank_values=True)
        if set(query) - {"limit", "after_id"} or any(len(values) != 1 for values in query.values()):
            self.reject(400, "INVALID_QUERY")
            return
        limit = query.get("limit", ["1000"])[0]
        after = query.get("after_id", [""])[0]
        if not limit.isdigit() or not 1 <= int(limit) <= 1000 or (after and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", after)):
            self.reject(400, "INVALID_QUERY")
            return
        if not self.server._api_key:
            self.reject(503, "MISSING_AUTHORIZED_KEY")
            return
        params = {"limit": limit}
        if after:
            params["after_id"] = after
        status, result = self.server.upstream("/models?" + urlencode(params), self.server._api_key)
        self.reply(status, result)

    def do_POST(self):
        if not self.same_origin(api=True):
            return
        if self.path != "/api/claude/messages":
            self.reject(404, "NOT_FOUND")
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json" or self.headers.get("Transfer-Encoding"):
            self.reject(400, "JSON_REQUIRED")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_BODY:
            self.reject(413, "BODY_SIZE")
            return
        try:
            body = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeError):
            self.reject(400, "INVALID_JSON")
            return
        if not validate_message(body):
            self.reject(400, "INVALID_REQUEST")
            return
        if not self.server._api_key:
            self.reject(503, "MISSING_AUTHORIZED_KEY")
            return
        with self.server.call_lock:
            if self.server.calls >= self.server.max_calls:
                self.reject(429, "BRIDGE_CALL_BUDGET")
                return
            self.server.calls += 1
        status, result = self.server.upstream("/messages", self.server._api_key, body)
        self.reply(status, result)


def main():
    parser = argparse.ArgumentParser(description="Serve the virtual-device experiment and its local Claude bridge.")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--html", type=Path, default=Path(__file__).resolve().with_name("unknown-device-v7.0.html"))
    parser.add_argument("--key-env", choices=AUTHORIZED_KEY_NAMES, default=KEY_NAME)
    parser.add_argument("--open-browser", action="store_true", help="Open the same-origin experiment page after starting the local server.")
    parser.add_argument("--max-calls", type=int, default=500)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.max_calls <= 500:
        parser.error("Invalid port or max-calls (1..500).")
    if not args.html.is_file():
        parser.error("HTML not found. Place unknown-device-v7.0.html next to this script, or pass --html.")
    key = read_authorized_key(args.key_env)
    with BridgeServer(args.port, args.html.resolve(), key, args.max_calls, key_name=args.key_env) as server:
        print(f"Open {server.origin}/")
        print(f"{args.key_env}: {'available' if key else 'not found; set this exact variable and restart'}")
        print(f"At most {args.max_calls} Claude decisions per bridge session. Ctrl+C stops the server.")
        if args.open_browser:
            webbrowser.open(server.origin + "/", new=2)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server._api_key = ""


if __name__ == "__main__":
    main()
