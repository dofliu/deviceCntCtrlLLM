"""Mock-only local bridge checks. No real key lookup and no upstream network."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("claude_bridge", ROOT / "claude_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
FAKE_KEY = "FAKE_BRIDGE_TEST_KEY_NO_CREDENTIAL"


def body():
    return {"model": "claude-mock-1", "max_tokens": 100, "system": "Mock only", "tools": [{"name": "observe", "description": "Mock tool", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": True}, "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}, {"type": "text", "text": "Choose observe."}]}]}


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
            return 200, {"data": [{"id": "claude-mock-1", "display_name": "Mock"}], "has_more": False} if route.startswith("/models?") else {"content": [], "stop_reason": "end_turn"}

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

    def test_01_no_key_disclosure(self):
        for route in ("/", "/unknown-device-v5.3.html", "/api/claude/status", "/api/claude/models?limit=1000"):
            status, response, headers = self.request(route)
            self.assertEqual(status, 200)
            self.assertNotIn(FAKE_KEY.encode(), response)
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(self.upstream_calls[-1][1], FAKE_KEY)
        status = json.loads(self.request("/api/claude/status")[1])
        self.assertEqual(status["credentialName"], "ANTHROPIC_API_KEY")

    def test_02_reject_external_origin_and_host(self):
        for headers in ({"Origin": "https://foreign.invalid"}, {"Origin": "null"}, {"Host": "rebind.invalid"}, {"Sec-Fetch-Site": "cross-site"}, {"X-Vlab-Bridge": ""}):
            status, _, _ = self.request("/api/claude/models", headers=headers)
            self.assertEqual(status, 403)
        self.assertEqual(self.request("/api/claude/models", method="OPTIONS")[0], 403)

    def test_03_no_open_proxy_or_filesystem(self):
        for route in ("/claude_bridge.py", "/../claude_bridge.py", "/api/claude/https://foreign.invalid", "/api/claude/models?url=https://foreign.invalid", "/api/claude/models?after_id=../secret"):
            self.assertIn(self.request(route)[0], (400, 404))

    def test_04_only_constrained_messages_and_budget(self):
        invalid = body()
        invalid["url"] = "https://foreign.invalid"
        self.assertEqual(self.request("/api/claude/messages", "POST", invalid)[0], 400)
        invalid = body()
        invalid["tools"] = [{"name": "bash", "type": "bash_20250124"}]
        self.assertEqual(self.request("/api/claude/messages", "POST", invalid)[0], 400)
        for _ in range(2):
            self.assertEqual(self.request("/api/claude/messages", "POST", body(), {"Origin": self.server.origin})[0], 200)
        self.assertEqual(self.request("/api/claude/messages", "POST", body())[0], 429)
        self.assertEqual(self.server.calls, 2)
        self.assertTrue(all(route == "/messages" or route.startswith("/models?") for route, _, _ in self.upstream_calls))

    def test_05_only_explicit_authorized_environment_name(self):
        with patch.dict(os.environ, {bridge.KEY_NAME: FAKE_KEY}, clear=True):
            self.assertEqual(bridge.read_authorized_key(), FAKE_KEY)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY_Extra": "NO_IMPLICIT_FALLBACK", "GOOGLE_API_KEY": "WRONG_KEY_MUST_NOT_USE"}, clear=True), patch.object(bridge.os, "name", "posix"):
            self.assertEqual(bridge.read_authorized_key(), "")
            self.assertEqual(bridge.read_authorized_key("ANTHROPIC_API_KEY_Extra"), "NO_IMPLICIT_FALLBACK")
        with self.assertRaises(ValueError):
            bridge.read_authorized_key("GOOGLE_API_KEY")
        with patch.dict(os.environ, {bridge.KEY_NAME: "bad\nvalue"}, clear=True):
            self.assertEqual(bridge.read_authorized_key(), "")

    def test_06_upstream_redacts_and_discards_thinking(self):
        raw = json.dumps({"model": "mock", "stop_reason": "tool_use", "content": [{"type": "thinking", "thinking": "internal"}, {"type": "tool_use", "input": {"reason": FAKE_KEY}}]}).encode()

        class MockResponse:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return raw

        class MockOpener:
            def open(self, request, timeout):
                self.last_request = request
                return MockResponse()

        with patch.object(bridge, "build_opener", return_value=MockOpener()):
            status, result = bridge.upstream_request("/messages", FAKE_KEY, body())
        self.assertEqual(status, 200)
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertNotIn("thinking", json.dumps(result))

    def test_07_accept_only_declared_mission_tools(self):
        for name in ("inspect_scene", "select_goal", "lift", "grip", "verify_grasp", "verify_place"):
            request = body()
            request["tools"][0]["name"] = name
            self.assertTrue(bridge.validate_message(request), name)
        request = body()
        request["tools"][0]["name"] = "read_plant_truth"
        self.assertFalse(bridge.validate_message(request))

    def test_08_bounded_html_model_selection_query(self):
        for route in ("/?agent=claude", "/?agent=claude&model=claude-mock-1", "/unknown-device-v5.3.html?agent=claude&model=claude-mock-1"):
            status, response, _ = self.request(route)
            self.assertEqual(status, 200, route)
            self.assertIn(b"<title>Mock</title>", response)
            self.assertNotIn(FAKE_KEY.encode(), response)
        for query in ("agent=unknown", "agent=claude&model=", "model=claude-mock-1", "agent=claude&url=https://foreign.invalid", "agent=claude&agent=claude", "agent=claude&model=../secret"):
            self.assertEqual(self.request("/?" + query)[0], 400, query)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BridgeTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (ROOT / "validation").mkdir(exist_ok=True)
    (ROOT / "validation" / "claude-bridge-mock.json").write_text(json.dumps({"scope": "mock-only local bridge; no live Claude requests or real credential lookup", "passed": result.wasSuccessful(), "tests": result.testsRun}, indent=2), encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
