"""Loopback Gemini bridge. Only the explicitly authorized gemini_api_key is read.

Windows environment/registry names are case insensitive; GOOGLE_API_KEY and
unrelated credentials are never consulted. No third-party packages required.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import getpass
import json
import math
import os
import re
import sys
import threading
import time
import webbrowser
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

KEY_NAME = "gemini_api_key"
UPSTREAM = "https://generativelanguage.googleapis.com/v1beta"
MAX_BODY = 6 * 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
MODEL_RE = r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}"
TOOLS = frozenset("inspect_device list_interfaces read_manual connect handshake write_driver test_driver write_controller test_controller start_control observe probe fit_model move reset_model verify inspect_scene select_goal lift grip verify_grasp verify_place stop".split())


def authorized_name(key_name: str) -> bool:
    return isinstance(key_name, str) and key_name.casefold() == KEY_NAME


def read_authorized_key(key_name: str = KEY_NAME) -> str:
    if not authorized_name(key_name):
        raise ValueError("Only gemini_api_key is authorized.")
    # These spellings designate the same Windows variable. Explicit lookups do
    # not enumerate the environment or access unrelated Google credentials.
    value = ""
    for spelling in dict.fromkeys((key_name, KEY_NAME, "GEMINI_API_KEY", "Gemini_API_Key")):
        value = os.environ.get(spelling, "").strip()
        if value:
            break
    if not value and os.name == "nt":
        import winreg
        for hive, path in ((winreg.HKEY_CURRENT_USER, r"Environment"),
                           (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")):
            try:
                with winreg.OpenKey(hive, path) as handle:
                    candidate, _ = winreg.QueryValueEx(handle, KEY_NAME)
                if isinstance(candidate, str) and candidate.strip():
                    value = candidate.strip()
                    break
            except OSError:
                pass
    return value if value and len(value) <= 1024 and "\r" not in value and "\n" not in value else ""


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def retry_after_seconds(value: object, *, now: float | None = None) -> float | None:
    """Convert only a finite delay; raw upstream headers never leave the bridge."""
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
    """Classify errors without relaying raw text, credentials or project IDs."""
    try:
        payload = json.loads(raw)
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        if not isinstance(error, dict):
            error = {}
    except (ValueError, UnicodeError):
        error = {}
    details = error.get("details", [])
    details = details if isinstance(details, list) else []
    reasons = {d.get("reason") for d in details if isinstance(d, dict) and isinstance(d.get("reason"), str)}
    message = str(error.get("message", "")).lower()
    if "API_KEY_INVALID" in reasons or "api key not valid" in message or status == 401:
        code = "INVALID_API_KEY"
    elif status == 429 or error.get("status") == "RESOURCE_EXHAUSTED":
        code = "QUOTA_EXCEEDED"
    elif status == 404:
        code = "MODEL_UNAVAILABLE"
    elif status == 403:
        code = "PERMISSION_DENIED"
    elif status == 400:
        code = "INVALID_REQUEST_FORMAT"
    elif 300 <= status < 400:
        code = "UPSTREAM_REDIRECT_REJECTED"
    else:
        code = "UPSTREAM_UNAVAILABLE"
    result = {"code": code, "status": status, "retryable": False}
    delays = []
    header_delay = retry_after_seconds(retry_after)
    if header_delay is not None:
        delays.append(header_delay)
    violations = []
    for detail in details[:40]:
        retry = detail.get("retryDelay") if isinstance(detail, dict) else None
        if isinstance(retry, str) and len(retry) <= 129 and re.fullmatch(r"\d+(?:\.\d+)?s", retry):
            delay = retry_after_seconds(retry[:-1])
            if delay is not None:
                delays.append(delay)
        values = detail.get("violations") if isinstance(detail, dict) else None
        if isinstance(values, list):
            violations.extend(value for value in values[:40] if isinstance(value, dict))
    if status == 429 and code == "QUOTA_EXCEEDED":
        labels = " ".join(str(value.get(field, ""))[:200].lower()
                          for value in violations for field in ("quotaId", "quotaMetric"))
        daily = any(marker in labels for marker in ("perday", "per_day", "per-day", "daily"))
        zero = any(type(value.get("quotaValue")) in (str, int, float)
                   and re.fullmatch(r"0(?:\.0+)?", str(value["quotaValue"])) for value in violations)
        if daily or zero:
            result["quotaKind"] = "daily" if daily else "unavailable"
        else:
            result.update(code="RATE_LIMITED", retryable=True,
                          quotaKind="rate" if delays or any(marker in labels for marker in
                              ("perminute", "per_minute", "persecond", "per_second")) else "unknown")
            if delays:
                result["retryAfterSeconds"] = max(delays)
    return {"error": result}


def safe_response(result: dict, generation: bool) -> dict:
    if not generation:
        models = result.get("models", [])
        if not isinstance(models, list):
            raise ValueError("Invalid model list")
        fields = {"name", "displayName", "description", "version", "supportedGenerationMethods", "inputTokenLimit", "outputTokenLimit"}
        response = {"models": [{k: v for k, v in model.items() if k in fields} for model in models if isinstance(model, dict)]}
        token = result.get("nextPageToken")
        if isinstance(token, str) and len(token) <= 4096:
            response["nextPageToken"] = token
        return response
    # Only tool calls and bounded metadata. No text/thoughts/signatures are
    # exported; this provider sends a fresh observable-state request each step.
    candidates = result.get("candidates", [])
    if not isinstance(candidates, list):
        raise ValueError("Invalid candidates")
    response = {k: result[k] for k in ("modelVersion", "usageMetadata", "promptFeedback") if k in result}
    response["candidates"] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content", {})
        parts = content.get("parts", []) if isinstance(content, dict) else []
        if not isinstance(parts, list):
            raise ValueError("Invalid parts")
        response["candidates"].append({
            "finishReason": candidate.get("finishReason"),
            "content": {"role": "model", "parts": [{"functionCall": part["functionCall"]} for part in parts
                         if isinstance(part, dict) and isinstance(part.get("functionCall"), dict) and not part.get("thought")]},
        })
    return response


def upstream_request(route: str, key: str, body: dict | None = None) -> tuple[int, dict]:
    parsed = urlsplit(route)
    generation = bool(re.fullmatch(r"/models/" + MODEL_RE + r":generateContent", parsed.path))
    if parsed.scheme or parsed.netloc or parsed.fragment or (body is None and parsed.path != "/models") or (body is not None and (not generation or parsed.query)):
        return 400, {"error": {"code": "INVALID_UPSTREAM_ROUTE"}}
    if body is None and (set(parse_qs(parsed.query)) - {"pageSize", "pageToken"}):
        return 400, {"error": {"code": "INVALID_UPSTREAM_ROUTE"}}
    request = Request(UPSTREAM + route, data=None if body is None else json.dumps(body, allow_nan=False).encode("utf-8"),
                      headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                      method="GET" if body is None else "POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=45) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            return 502, {"error": {"code": "UPSTREAM_TOO_LARGE"}}
        decoded = raw.decode("utf-8").replace(key, "[REDACTED]") if key else raw.decode("utf-8")
        result = json.loads(decoded)
        if not isinstance(result, dict):
            raise ValueError("Expected object")
        return 200, safe_response(result, generation)
    except HTTPError as error:
        raw = error.read(MAX_RESPONSE + 1)
        return error.code if 400 <= error.code <= 599 else 502, sanitized_upstream_error(
            error.code, raw if len(raw) <= MAX_RESPONSE else b"", error.headers.get("Retry-After") if error.headers else None)
    except (URLError, TimeoutError, OSError):
        return 502, {"error": {"code": "UPSTREAM_UNAVAILABLE"}}
    except (ValueError, UnicodeError):
        return 502, {"error": {"code": "UPSTREAM_FORMAT"}}


def finite_json(value, depth=0) -> bool:
    if depth > 16:
        return False
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return len(value) <= 200 and all(finite_json(v, depth + 1) for v in value)
    return isinstance(value, dict) and len(value) <= 100 and all(isinstance(k, str) and finite_json(v, depth + 1) for k, v in value.items())


def valid_model(value) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(MODEL_RE, value))


def validate_message(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {"model", "systemInstruction", "contents", "tools", "toolConfig", "generationConfig"}:
        return False
    if not valid_model(value["model"]) or not finite_json(value):
        return False
    system = value["systemInstruction"]
    if not isinstance(system, dict) or set(system) != {"parts"} or not isinstance(system["parts"], list) or len(system["parts"]) != 1:
        return False
    instruction = system["parts"][0]
    if not isinstance(instruction, dict) or set(instruction) != {"text"} or not isinstance(instruction["text"], str) or len(instruction["text"]) > 16000:
        return False
    contents = value["contents"]
    if not isinstance(contents, list) or len(contents) != 1 or not isinstance(contents[0], dict) or set(contents[0]) != {"role", "parts"} or contents[0]["role"] != "user":
        return False
    parts = contents[0]["parts"]
    if not isinstance(parts, list) or len(parts) != 2:
        return False
    images = [p for p in parts if isinstance(p, dict) and set(p) == {"inlineData"}]
    texts = [p for p in parts if isinstance(p, dict) and set(p) == {"text"}]
    if len(images) != 1 or len(texts) != 1 or not isinstance(texts[0]["text"], str) or len(texts[0]["text"]) > 160000:
        return False
    picture = images[0]["inlineData"]
    if not isinstance(picture, dict) or set(picture) != {"mimeType", "data"} or picture["mimeType"] != "image/png" or not isinstance(picture["data"], str):
        return False
    try:
        image = base64.b64decode(picture["data"], validate=True)
        if len(image) > 4 * 1024 * 1024 or not image.startswith(b"\x89PNG\r\n\x1a\n"):
            return False
    except (ValueError, binascii.Error):
        return False
    tools = value["tools"]
    if not isinstance(tools, list) or len(tools) != 1 or not isinstance(tools[0], dict) or set(tools[0]) != {"functionDeclarations"}:
        return False
    declarations = tools[0]["functionDeclarations"]
    if not isinstance(declarations, list) or not 1 <= len(declarations) <= len(TOOLS):
        return False
    names = []
    for declaration in declarations:
        if not isinstance(declaration, dict) or set(declaration) - {"name", "description", "parameters", "parametersJsonSchema"}:
            return False
        name = declaration.get("name")
        schema_keys = {"parameters", "parametersJsonSchema"} & set(declaration)
        if not isinstance(name, str) or name not in TOOLS or len(schema_keys) != 1:
            return False
        schema = declaration[next(iter(schema_keys))]
        if not isinstance(schema, dict) or schema.get("type") not in ("object", "OBJECT") or len(json.dumps(schema)) > 16000:
            return False
        if not isinstance(declaration.get("description", ""), str) or len(declaration.get("description", "")) > 4000:
            return False
        names.append(name)
    if len(set(names)) != len(names):
        return False
    tool_config = value["toolConfig"]
    if not isinstance(tool_config, dict) or set(tool_config) != {"functionCallingConfig"}:
        return False
    calling = tool_config["functionCallingConfig"]
    if not isinstance(calling, dict) or set(calling) - {"mode", "allowedFunctionNames"} or calling.get("mode") not in ("ANY", "AUTO"):
        return False
    allowed = calling.get("allowedFunctionNames", names)
    if not isinstance(allowed, list) or not allowed or any(not isinstance(n, str) or n not in names for n in allowed):
        return False
    config = value["generationConfig"]
    if not isinstance(config, dict) or set(config) - {"maxOutputTokens", "candidateCount", "temperature", "thinkingConfig"}:
        return False
    if type(config.get("maxOutputTokens")) is not int or not 1 <= config["maxOutputTokens"] <= 16384 or config.get("candidateCount", 1) != 1:
        return False
    if "temperature" in config and (type(config["temperature"]) not in (int, float) or not 0 <= config["temperature"] <= 2):
        return False
    thinking = config.get("thinkingConfig", {})
    if not isinstance(thinking, dict) or set(thinking) - {"includeThoughts", "thinkingBudget", "thinkingLevel"} or thinking.get("includeThoughts", False) is not False:
        return False
    if "thinkingBudget" in thinking and (type(thinking["thinkingBudget"]) is not int or not -1 <= thinking["thinkingBudget"] <= 8192):
        return False
    if "thinkingLevel" in thinking and thinking["thinkingLevel"] not in ("MINIMAL", "LOW", "MEDIUM", "HIGH", "minimal", "low", "medium", "high"):
        return False
    return not ("thinkingLevel" in thinking and "thinkingBudget" in thinking)


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second bridge bind the same port, so two
    # runs could silently share one bridge and its call budget.
    allow_reuse_address = sys.platform != "win32"

    def __init__(self, port: int, html_path: Path, key: str, max_calls: int = 80, key_name: str = KEY_NAME):
        if not authorized_name(key_name):
            raise ValueError("Only gemini_api_key is authorized.")
        if type(max_calls) is not int or not 1 <= max_calls <= 500:
            raise ValueError("max_calls must be 1..500.")
        super().__init__(("127.0.0.1", port), BridgeHandler)
        self.html_path, self._api_key, self.key_name = Path(html_path), key, KEY_NAME
        self.max_calls, self.calls = max_calls, 0
        self.call_lock, self.upstream = threading.Lock(), upstream_request
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.host_header = f"127.0.0.1:{self.server_port}"


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "VLabGeminiBridge/1.0"

    def log_message(self, format, *args):
        pass

    def send_body(self, status, body: bytes, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        for key, value in {"Content-Type": content_type, "Content-Length": str(len(body)), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"}.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reply(self, status, value):
        encoded = json.dumps(value, ensure_ascii=False)
        if self.server._api_key:
            encoded = encoded.replace(self.server._api_key, "[REDACTED]")
        self.send_body(status, encoded.encode("utf-8"))

    def reject(self, status, code):
        error = {"code": code}
        if code == "BRIDGE_CALL_BUDGET":
            error.update(status=status, retryable=False, quotaKind="unavailable")
        self.reply(status, {"error": error})

    def same_origin(self, api=False):
        if self.client_address[0] != "127.0.0.1" or self.headers.get("Host") != self.server.host_header:
            self.reject(403, "HOST_REJECTED")
            return False
        if self.headers.get("Origin") not in (None, self.server.origin):
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
        self.reject(403, "CROSS_ORIGIN_DISABLED")

    def do_GET(self):
        if not self.same_origin():
            return
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        if url.path in ("/", "/unknown-device-v7.0.html", "/unknown-device-v6.3.html", "/unknown-device-v6.2.html", "/unknown-device-v6.1.html", "/unknown-device-v6.html", "/unknown-device-v5.3.html", "/unknown-device-v5.2.html", "/unknown-device-v5.html"):
            if query and (set(query) - {"agent", "model"} or any(len(v) != 1 for v in query.values()) or query.get("agent") != ["gemini"] or ("model" in query and not valid_model(query["model"][0]))):
                self.reject(400, "INVALID_PAGE_QUERY")
                return
            try:
                self.send_body(200, self.server.html_path.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self.reject(404, "HTML_NOT_FOUND")
            return
        if not self.same_origin(api=True):
            return
        if url.path == "/api/gemini/status" and not url.query:
            self.reply(200, {"available": bool(self.server._api_key), "credentialName": self.server.key_name, "provider": "gemini", "calls": self.server.calls, "limit": self.server.max_calls})
            return
        if url.path != "/api/gemini/models":
            self.reject(404, "NOT_FOUND")
            return
        if set(query) - {"pageSize", "pageToken"} or any(len(v) != 1 for v in query.values()):
            self.reject(400, "INVALID_QUERY")
            return
        page_size, page_token = query.get("pageSize", ["100"])[0], query.get("pageToken", [""])[0]
        if not page_size.isascii() or not page_size.isdigit() or not 1 <= int(page_size) <= 1000 or len(page_token) > 4096 or any(ord(c) < 32 for c in page_token):
            self.reject(400, "INVALID_QUERY")
            return
        if not self.server._api_key:
            self.reject(503, "MISSING_AUTHORIZED_KEY")
            return
        params = {"pageSize": page_size}
        if page_token:
            params["pageToken"] = page_token
        status, result = self.server.upstream("/models?" + urlencode(params), self.server._api_key)
        self.reply(status, result)

    def do_POST(self):
        if not self.same_origin(api=True):
            return
        if self.path != "/api/gemini/generateContent":
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
        model = body.pop("model")
        status, result = self.server.upstream(f"/models/{model}:generateContent", self.server._api_key, body)
        self.reply(status, result)


def main():
    parser = argparse.ArgumentParser(description="Local Gemini bridge for the virtual-device experiment.")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--html", type=Path, default=Path(__file__).resolve().with_name("unknown-device-v7.0.html"))
    parser.add_argument("--key-env", default=KEY_NAME, help="Only gemini_api_key (case insensitive) is authorized.")
    parser.add_argument("--max-calls", type=int, default=500)
    parser.add_argument("--open-browser", action="store_true")
    parser.add_argument("--prompt-key", action="store_true", help="If the authorized variable is missing, enter a key privately for this process only.")
    parser.add_argument("--check", action="store_true", help="Check the authorized key and models endpoint; no generateContent call.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.max_calls <= 500:
        parser.error("Invalid port or max-calls (1..500).")
    if not authorized_name(args.key_env):
        parser.error("Only gemini_api_key (case insensitive) is authorized.")
    key = read_authorized_key(args.key_env)
    if not key and args.prompt_key:
        if not sys.stdin.isatty():
            parser.error("Private key entry requires an interactive terminal. Set gemini_api_key or run without --prompt-key.")
        try:
            key = getpass.getpass("Gemini API key (hidden; memory only): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("Key entry cancelled. No server started.")
            return
        if not key or len(key) > 1024 or "\r" in key or "\n" in key:
            parser.error("Key is empty or has an invalid format.")
    if args.check:
        metadata = {"credentialName": KEY_NAME, "available": bool(key), "generationRequests": 0}
        if key:
            status, result = upstream_request("/models?pageSize=100", key)
            metadata.update({"httpStatus": status, "models": [m.get("name") for m in result.get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])], "hasMore": bool(result.get("nextPageToken"))})
            if "error" in result:
                metadata["error"] = result["error"]
        else:
            metadata["error"] = {"code": "MISSING_AUTHORIZED_KEY"}
        print(json.dumps(metadata, ensure_ascii=True))
        return
    if not args.html.is_file():
        parser.error("HTML not found. Run build.py or pass --html.")
    with BridgeServer(args.port, args.html.resolve(), key, args.max_calls) as server:
        print(f"Open {server.origin}/?agent=gemini")
        print(f"{KEY_NAME}: {'available' if key else 'not found; set this variable and restart'}")
        print(f"At most {args.max_calls} Gemini decisions per bridge session. Ctrl+C stops the server.")
        if args.open_browser:
            webbrowser.open(server.origin + "/?agent=gemini", new=2)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server._api_key = ""


if __name__ == "__main__":
    main()
