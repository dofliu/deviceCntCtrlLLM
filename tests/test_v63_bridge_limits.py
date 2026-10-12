"""Focused V6.3 checks: in-memory HTTP errors only; no network/key lookup."""
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLAUDE, GEMINI = load("claude_bridge"), load("gemini_bridge")
CANARY = "PRIVATE_TEST_CANARY_PROJECT_AND_TOKEN"


def raw(error):
    return json.dumps({"error": error}).encode()


class BridgeLimitTests(unittest.TestCase):
    def test_01_claude_rate_hint_is_finite_and_sanitized(self):
        result = CLAUDE.sanitized_upstream_error(429, raw({"type": "rate_limit_error", "message": CANARY}), "12.5")
        self.assertEqual(result["error"], {"code": "RATE_LIMITED", "status": 429, "retryable": True, "quotaKind": "rate", "retryAfterSeconds": 12.5})
        self.assertNotIn(CANARY, json.dumps(result))

    def test_02_claude_monthly_spend_is_terminal_even_with_hint(self):
        result = CLAUDE.sanitized_upstream_error(429, raw({"type": "rate_limit_error", "details": {"error_code": "enforced_spend_limit_reached", "account_id": CANARY}}), "2")
        self.assertEqual(result["error"], {"code": "QUOTA_EXCEEDED", "status": 429, "retryable": False, "quotaKind": "spend"})

    def test_03_retry_after_http_date_and_long_delay_not_clamped(self):
        for module in (CLAUDE, GEMINI):
            self.assertEqual(module.retry_after_seconds("Thu, 01 Jan 1970 00:05:00 GMT", now=0), 300)
            self.assertEqual(module.retry_after_seconds("86400"), 86400)
            for value in (None, "NaN", "Infinity", "-1", CANARY, "9" * 200, {}, ""):
                self.assertIsNone(module.retry_after_seconds(value))

    def test_04_unknown_and_malformed_429_have_bounded_retry_classification(self):
        for module in (CLAUDE, GEMINI):
            for payload in (b"[]", b"null", b"not-json", b'{"error":[]}'):
                result = module.sanitized_upstream_error(429, payload)["error"]
                self.assertEqual(result["code"], "RATE_LIMITED")
                self.assertTrue(result["retryable"])
                self.assertEqual(result["quotaKind"], "unknown")

    def test_05_gemini_uses_maximum_header_and_retryinfo(self):
        payload = raw({"status": "RESOURCE_EXHAUSTED", "message": CANARY, "details": [
            {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "14.2s"},
            {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [
                {"quotaId": "GenerateContentRequestsPerMinutePerProjectPerModel", "quotaValue": "15", "quotaDimensions": {"project": CANARY}}]}]})
        result = GEMINI.sanitized_upstream_error(429, payload, "20")["error"]
        self.assertEqual(result, {"code": "RATE_LIMITED", "status": 429, "retryable": True, "quotaKind": "rate", "retryAfterSeconds": 20})
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual(GEMINI.sanitized_upstream_error(429, payload, "10")["error"]["retryAfterSeconds"], 14.2)

    def test_06_dailyquota_stays_terminal_despite_short_retryinfo(self):
        payload = raw({"status": "RESOURCE_EXHAUSTED", "details": [
            {"violations": [{"quotaId": "GenerateContentRequestsPerDayPerProjectPerModel", "quotaValue": "20"}]}, {"retryDelay": "1s"}]})
        self.assertEqual(GEMINI.sanitized_upstream_error(429, payload, "2")["error"],
                         {"code": "QUOTA_EXCEEDED", "status": 429, "retryable": False, "quotaKind": "daily"})

    def test_07_zero_quota_is_unavailable_not_rate_retry(self):
        for value in ("0", 0, 0.0, "0.00"):
            payload = raw({"status": "RESOURCE_EXHAUSTED", "details": [{"violations": [{"quotaId": "RequestsPerMinute", "quotaValue": value}]}]})
            result = GEMINI.sanitized_upstream_error(429, payload)["error"]
            self.assertFalse(result["retryable"])
            self.assertEqual(result["quotaKind"], "unavailable")

    def test_08_gemini_spend_rate_message_does_not_imply_hard_quota(self):
        result = GEMINI.sanitized_upstream_error(429, raw({"status": "RESOURCE_EXHAUSTED", "message": "Spend-based rate limit exceeded " + CANARY}), "11")["error"]
        self.assertEqual(result["code"], "RATE_LIMITED")
        self.assertTrue(result["retryable"])
        self.assertNotIn(CANARY, json.dumps(result))

    def test_09_long_retryinfo_preserved_and_invalid_delay_omitted(self):
        for delay in ("300s", "999999.1s", "1000000s"):
            result = GEMINI.sanitized_upstream_error(429, raw({"details": [{"retryDelay": delay}]}))["error"]
            self.assertGreater(result["retryAfterSeconds"], 180)
        for delay in ("NaNs", "-3s", CANARY, None, True, "Infinitys"):
            result = GEMINI.sanitized_upstream_error(429, raw({"details": [{"retryDelay": delay}]}))["error"]
            self.assertNotIn("retryAfterSeconds", result)

    def test_10_non429_errors_never_auto_retry_or_echo(self):
        for module in (CLAUDE, GEMINI):
            for status in (400, 401, 403, 404, 500, 503):
                result = module.sanitized_upstream_error(status, raw({"message": CANARY}), "2")["error"]
                self.assertFalse(result["retryable"])
                self.assertNotIn(CANARY, json.dumps(result))
                self.assertNotIn("retryAfterSeconds", result)

    def test_11_stubbed_upstream_threads_headers_into_safe_metadata(self):
        for module, route, payload in (
                (CLAUDE, "/messages", raw({"type": "rate_limit_error", "message": CANARY})),
                (GEMINI, "/models/gemini-mock:generateContent", raw({"status": "RESOURCE_EXHAUSTED", "message": CANARY}))):
            error = HTTPError("https://test.invalid", 429, "Do not relay " + CANARY, {"Retry-After": "21"}, io.BytesIO(payload))
            opener = SimpleNamespace(open=lambda *args, **kwargs: (_ for _ in ()).throw(error))
            with patch.object(module, "build_opener", return_value=opener):
                status, result = module.upstream_request(route, "FAKE_NO_CREDENTIAL", {})
            self.assertEqual(status, 429)
            self.assertEqual(result["error"]["retryAfterSeconds"], 21)
            self.assertNotIn(CANARY, json.dumps(result))

    def test_12_local_budget_has_terminal_identity_without_upstream(self):
        for module, route in ((CLAUDE, "/api/claude/messages"), (GEMINI, "/api/gemini/generateContent")):
            replies, attempts = [], []
            server = SimpleNamespace(_api_key="FAKE_NO_CREDENTIAL", calls=0, max_calls=1,
                                     call_lock=threading.Lock(), upstream=lambda *args: (attempts.append(args) or (429, {"error": {"code": "RATE_LIMITED"}})))
            handler = SimpleNamespace(server=server, path=route, same_origin=lambda **kwargs: True,
                                      reply=lambda status, value: replies.append((status, value)))
            handler.reject = lambda status, code: module.BridgeHandler.reject(handler, status, code)
            payload = json.dumps({"model": "mock"}).encode()
            # Schema validity is orthogonal to this budget gate. Stub only its
            # predicate; run the actual POST accounting and reject methods.
            with patch.object(module, "validate_message", return_value=True):
                for _ in range(2):
                    handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(payload))}
                    handler.rfile = io.BytesIO(payload)
                    module.BridgeHandler.do_POST(handler)
            self.assertEqual(server.calls, 1)
            self.assertEqual(len(attempts), 1)
            self.assertEqual(replies[-1], (429, {"error": {"code": "BRIDGE_CALL_BUDGET", "status": 429, "retryable": False, "quotaKind": "unavailable"}}))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BridgeLimitTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {"version": "0.6.3", "scope": "Focused in-memory bridge error/limit fixtures; no socket, browser, credentials or live API.",
              "testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "passed": result.wasSuccessful()}
    (ROOT / "validation" / "v63-bridge-limits.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
