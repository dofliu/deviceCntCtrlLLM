"""Mock-only Gemini bridge checks. Never reads real keys or contacts Google."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gemini_bridge", ROOT / "gemini_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
FAKE_KEY = "FAKE_GEMINI_TEST_KEY_NO_CREDENTIAL"


def body():
    return {"model": "gemini-mock-1", "systemInstruction": {"parts": [{"text": "Mock only"}]},
            "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": "image/png", "data": "iVBORw0KGgo="}}, {"text": "Choose observe."}]}],
            "tools": [{"functionDeclarations": [{"name": "observe", "description": "Mock tool", "parametersJsonSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]}],
            "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["observe"]}},
            "generationConfig": {"candidateCount": 1, "maxOutputTokens": 8192}}


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        html = Path(cls.temp.name) / "unknown-device-v5.3.html"
        html.write_text("<!doctype html><title>Mock</title>", encoding="utf-8")
        cls.server = bridge.BridgeServer(0, html, FAKE_KEY, max_calls=2)
        cls.upstream_calls = []

        def mock_upstream(route, key, request=None):
            cls.upstream_calls.append((route, key, request))
            return 200, ({"models": [{"name": "models/gemini-mock-1", "supportedGenerationMethods": ["generateContent"]}], "nextPageToken": "next/+="} if request is None
                         else {"modelVersion": "gemini-mock-1", "candidates": [{"finishReason": "STOP", "content": {"parts": [{"functionCall": {"name": "observe", "args": {}}}]}}]})

        cls.server.upstream = mock_upstream
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.temp.cleanup()

    def request(self, route, method="GET", payload=None, headers=None):
        request = Request(self.server.origin + route, method=method, data=json.dumps(payload).encode() if payload is not None else None,
                          headers={"X-Vlab-Bridge": "1", "Content-Type": "application/json", **(headers or {})})
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            return error.code, error.read(), error.headers

    def test_01_status_and_models_never_disclose_key(self):
        for route in ("/", "/unknown-device-v5.3.html", "/api/gemini/status", "/api/gemini/models?pageSize=100&pageToken=next%2F%2B%3D"):
            status, response, headers = self.request(route)
            self.assertEqual(status, 200, route)
            self.assertNotIn(FAKE_KEY.encode(), response)
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(self.upstream_calls[-1][1], FAKE_KEY)
        self.assertEqual(parse_qs(urlsplit(self.upstream_calls[-1][0]).query)["pageToken"], ["next/+="])
        status = json.loads(self.request("/api/gemini/status")[1])
        self.assertTrue(status["available"])
        self.assertEqual(status["credentialName"], "gemini_api_key")

    def test_02_reject_cross_origin_rebinding_and_missing_header(self):
        for headers in ({"Origin": "https://foreign.invalid"}, {"Origin": "null"}, {"Host": "rebind.invalid"}, {"Sec-Fetch-Site": "cross-site"}, {"X-Vlab-Bridge": ""}):
            self.assertEqual(self.request("/api/gemini/models", headers=headers)[0], 403)
        self.assertEqual(self.request("/api/gemini/models", method="OPTIONS")[0], 403)

    def test_03_reject_open_proxy_paths_and_unbounded_queries(self):
        for route in ("/gemini_bridge.py", "/../gemini_bridge.py", "/api/gemini/https://foreign.invalid", "/api/gemini/models?url=https://foreign.invalid", "/api/gemini/models?pageSize=1001", "/api/gemini/models?pageSize=1&pageSize=2", "/api/gemini/models?pageToken=%0A"):
            self.assertIn(self.request(route)[0], (400, 404), route)
        self.assertEqual(bridge.upstream_request("https://foreign.invalid/models", FAKE_KEY)[0], 400)
        self.assertEqual(bridge.upstream_request("/models?key=oops", FAKE_KEY)[0], 400)
        self.assertEqual(bridge.upstream_request("/models/../secret:generateContent", FAKE_KEY, {})[0], 400)

    def test_04_generation_uses_fixed_url_without_body_model_and_budget(self):
        bad = body()
        bad["model"] = "gemini-mock-1?key=other"
        self.assertEqual(self.request("/api/gemini/generateContent", "POST", bad)[0], 400)
        bad = body()
        bad["tools"][0]["functionDeclarations"][0]["name"] = "read_plant_truth"
        self.assertEqual(self.request("/api/gemini/generateContent", "POST", bad)[0], 400)
        for _ in range(2):
            self.assertEqual(self.request("/api/gemini/generateContent", "POST", body(), {"Origin": self.server.origin})[0], 200)
            route, key, request = self.upstream_calls[-1]
            self.assertEqual(route, "/models/gemini-mock-1:generateContent")
            self.assertEqual(key, FAKE_KEY)
            self.assertNotIn("model", request)
        self.assertEqual(self.request("/api/gemini/generateContent", "POST", body())[0], 429)
        self.assertEqual(self.server.calls, 2)

    def test_05_exact_authorized_key_case_variants_only(self):
        for spelling in ("gemini_api_key", "GEMINI_API_KEY", "Gemini_API_Key"):
            with patch.dict(os.environ, {spelling: FAKE_KEY}, clear=True), patch.object(bridge.os, "name", "posix"):
                self.assertEqual(bridge.read_authorized_key(), FAKE_KEY)
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "WRONG_KEY", "ANTHROPIC_API_KEY": "WRONG_KEY"}, clear=True), patch.object(bridge.os, "name", "posix"):
            self.assertEqual(bridge.read_authorized_key(), "")
        with self.assertRaises(ValueError):
            bridge.read_authorized_key("GOOGLE_API_KEY")
        with patch.dict(os.environ, {"gemini_api_key": "bad\nvalue"}, clear=True):
            self.assertEqual(bridge.read_authorized_key(), "")

    def test_06_missing_key_is_explicit_and_does_not_call_upstream(self):
        with patch.object(self.server, "_api_key", ""):
            response = json.loads(self.request("/api/gemini/status")[1])
            self.assertFalse(response["available"])
            before = len(self.upstream_calls)
            for route, method, request in (("/api/gemini/models", "GET", None), ("/api/gemini/generateContent", "POST", body())):
                status, response, _ = self.request(route, method, request)
                self.assertEqual(status, 503)
                self.assertEqual(json.loads(response)["error"]["code"], "MISSING_AUTHORIZED_KEY")
            self.assertEqual(len(self.upstream_calls), before)

    def test_07_upstream_redacts_and_drops_text_thoughts_signatures(self):
        raw = json.dumps({"modelVersion": "gemini-mock-1", "usageMetadata": {"totalTokenCount": 12}, "candidates": [{"finishReason": "STOP", "content": {"parts": [
            {"text": "internal reasoning", "thought": True}, {"text": "untrusted prose"}, {"thoughtSignature": "secret-signature", "functionCall": {"name": "observe", "args": {"note": FAKE_KEY}}}]}}]}).encode()

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return raw

        class Opener:
            def open(self, request, timeout):
                self.request = request
                return Response()

        opener = Opener()
        with patch.object(bridge, "build_opener", return_value=opener) as build:
            status, result = bridge.upstream_request("/models/gemini-mock-1:generateContent", FAKE_KEY, {"contents": []})
        self.assertEqual(status, 200)
        self.assertIsInstance(build.call_args.args[0], bridge.NoRedirects)
        self.assertEqual(opener.request.full_url, bridge.UPSTREAM + "/models/gemini-mock-1:generateContent")
        self.assertNotIn(FAKE_KEY, opener.request.full_url)
        self.assertEqual(opener.request.get_header("X-goog-api-key"), FAKE_KEY)
        for excluded in (FAKE_KEY, "internal reasoning", "untrusted prose", "secret-signature"):
            self.assertNotIn(excluded, json.dumps(result))
        self.assertEqual(result["usageMetadata"]["totalTokenCount"], 12)
        self.assertEqual(result["candidates"][0]["content"]["parts"][0]["functionCall"]["name"], "observe")

    def test_08_errors_classify_without_echo_or_redirect(self):
        cases = ((400, {"message": "API key not valid. " + FAKE_KEY}, "INVALID_API_KEY"),
                 (400, {"message": "Bad schema " + FAKE_KEY}, "INVALID_REQUEST_FORMAT"),
                 (403, {}, "PERMISSION_DENIED"), (404, {}, "MODEL_UNAVAILABLE"),
                 (429, {"details": [{"retryDelay": "35.5s"}]}, "RATE_LIMITED"), (302, {}, "UPSTREAM_REDIRECT_REJECTED"))
        for status, error, code in cases:
            http_error = HTTPError(bridge.UPSTREAM + "/models", status, "mock", {}, io.BytesIO(json.dumps({"error": error}).encode()))
            with patch.object(bridge, "build_opener") as build:
                build.return_value.open.side_effect = http_error
                result_status, result = bridge.upstream_request("/models?pageSize=100", FAKE_KEY)
            self.assertEqual(result_status, status if status >= 400 else 502)
            self.assertEqual(result["error"]["code"], code)
            self.assertNotIn(FAKE_KEY, json.dumps(result))
            if status == 429:
                self.assertEqual(result["error"]["retryAfterSeconds"], 35.5)
                self.assertTrue(result["error"]["retryable"])
        self.assertIsNone(bridge.NoRedirects().redirect_request(None, None, 302, None, {}, "https://foreign.invalid"))

    def test_09_constrained_generation_schema_and_observation(self):
        self.assertTrue(bridge.validate_message(body()))
        for field, replacement in (("contents", [{"role": "user", "parts": [{"fileData": {"fileUri": "https://foreign.invalid"}}]}]),
                                   ("generationConfig", {"maxOutputTokens": 500000}), ("tools", [{"googleSearch": {}}]),
                                   ("toolConfig", {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["bash"]}})):
            request = body()
            request[field] = replacement
            self.assertFalse(bridge.validate_message(request), field)
        for name in ("inspect_scene", "select_goal", "lift", "grip", "verify_grasp", "verify_place"):
            request = body()
            request["tools"][0]["functionDeclarations"][0]["name"] = name
            request["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"] = [name]
            self.assertTrue(bridge.validate_message(request), name)
        request = body()
        request["contents"][0]["parts"][0]["inlineData"]["data"] = "ZmFrZQ=="
        self.assertFalse(bridge.validate_message(request))
        request = body()
        request["generationConfig"]["temperature"] = float("nan")
        self.assertFalse(bridge.validate_message(request))
        request = body()
        request["generationConfig"]["thinkingConfig"] = {"includeThoughts": True}
        self.assertFalse(bridge.validate_message(request))

    def test_10_bounded_html_query(self):
        for route in ("/?agent=gemini", "/?agent=gemini&model=gemini-mock-1", "/unknown-device-v5.3.html?agent=gemini&model=gemini-mock-1"):
            status, response, _ = self.request(route)
            self.assertEqual(status, 200, route)
            self.assertIn(b"<title>Mock</title>", response)
        for query in ("agent=unknown", "agent=gemini&model=", "model=gemini-mock-1", "agent=gemini&url=https://foreign.invalid", "agent=gemini&agent=gemini", "agent=gemini&model=../secret"):
            self.assertEqual(self.request("/?" + query)[0], 400, query)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(BridgeTests))
    (ROOT / "validation").mkdir(exist_ok=True)
    (ROOT / "validation" / "gemini-bridge-mock.json").write_text(json.dumps({"scope": "mock-only local bridge; no live requests or real credential lookup", "passed": result.wasSuccessful(), "tests": result.testsRun}, indent=2), encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
