"""Batch runner provider and estimated-cost checks (2026-10-17).

run_one is replaced by canned run summaries, so no Node run, bridge, key or
model request is involved.
"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("run_experiments", ROOT / "run_experiments.py")
RUN = importlib.util.module_from_spec(spec)
spec.loader.exec_module(RUN)

GEMINI_USAGE = {"promptTokenCount": 600_000, "candidatesTokenCount": 40_000, "thoughtsTokenCount": 10_000, "totalTokenCount": 650_000}


def canned(calls, usage):
    def run_one(args, device, seed, rep, max_calls, out_dir):
        label = f"{device.lower()}-s{seed}-r{rep}-{args.provider}"
        summary = {"modelCalls": calls, "usage": usage, "result": {"completedTrials": 5, "allTruthPlaced": True}, "trials": []}
        run_one.seen.append({"label": label, "cap": max_calls, "args": [args.provider, args.model, args.key_env, args.port]})
        return label, 0, {"ok": True, "summary": None}, summary
    run_one.seen = []
    return run_one


def batch(argv, run_one):
    with tempfile.TemporaryDirectory() as tmp, patch.object(RUN, "run_one", run_one), \
            patch.object(sys, "argv", ["run_experiments.py", *argv, "--yes", "--out-dir", tmp]), \
            contextlib.redirect_stdout(io.StringIO()) as out:
        RUN.main()
        return json.loads((Path(tmp) / "batch-summary.json").read_text(encoding="utf-8")), out.getvalue()


class BatchCostTests(unittest.TestCase):
    def test_token_counts(self):
        self.assertEqual(RUN.token_counts(GEMINI_USAGE), (600_000, 50_000, 10_000))
        self.assertEqual(RUN.token_counts({"input_tokens": 900, "output_tokens": 80, "cache_read_input_tokens": 100}), (1000, 80, None))
        self.assertEqual(RUN.token_counts(None), (0, 0, None))

    def test_provider_defaults(self):
        run_one = canned(90, GEMINI_USAGE)
        summary, _ = batch(["--provider", "gemini", "--devices", "P2", "--seeds", "2026", "--total-max-calls", "150"], run_one)
        self.assertEqual(run_one.seen[0]["args"], ["gemini", "gemini-3.5-flash-lite", "gemini_api_key", 8767])
        self.assertEqual(run_one.seen[0]["label"], "p2-s2026-r1-gemini")
        self.assertEqual((summary["provider"], summary["model"]), ("gemini", "gemini-3.5-flash-lite"))
        self.assertIsNone(summary["runs"][0]["estimatedUsd"])
        run_one = canned(90, {"input_tokens": 1000, "output_tokens": 100})
        batch(["--devices", "P2", "--seeds", "2026"], run_one)
        self.assertEqual(run_one.seen[0]["args"], ["claude", "claude-haiku-5-5", "ANTHROPIC_API_KEY", 8766])

    def test_usd_cap_stops_before_projected_overrun(self):
        # Each run: 0.6M in x $0.30 + 0.05M out (thinking included) x $2.50 = $0.305 for 100 calls.
        run_one = canned(100, GEMINI_USAGE)
        summary, out = batch(["--provider", "gemini", "--devices", "P2", "--seeds", "1,2,3,4", "--total-max-calls", "600",
                              "--max-usd", "1", "--usd-per-mtok-in", "0.30", "--usd-per-mtok-out", "2.50"], run_one)
        # Before run 3: $0.61 + $0.00305 x 150 calls = $1.0675 > $1.
        self.assertEqual(summary["ran"], 2)
        self.assertIn("would pass the US$1 cap", summary["stopped"])
        self.assertEqual([r["estimatedUsd"] for r in summary["runs"]], [0.305, 0.305])
        self.assertEqual(summary["runs"][0]["outputTokens"], 50_000)
        self.assertEqual(summary["budget"]["estimatedUsd"], 0.61)
        self.assertEqual((summary["budget"]["usdPerMTokIn"], summary["budget"]["usdPerMTokOut"], summary["budget"]["maxUsd"]), (0.30, 2.50, 1.0))
        self.assertIn("est. US$0.61 so far", out)

    def test_first_try_needs_the_test_to_run(self):
        steps = [["write_driver", True], ["test_driver", False], ["write_driver", True], ["test_driver", True]]
        self.assertIs(RUN.first_try(steps, "test_driver"), False)
        self.assertIsNone(RUN.first_try(steps, "test_controller"))
        self.assertIs(RUN.first_try([["test_controller", True]], "test_controller"), True)

    def test_thinking_level_passthrough(self):
        run_one = canned(90, GEMINI_USAGE)
        summary, _ = batch(["--provider", "gemini", "--thinking-level", "medium", "--devices", "P2", "--seeds", "2026", "--total-max-calls", "150"], run_one)
        self.assertEqual(summary["condition"]["thinkingLevel"], "medium")

    def test_bad_arguments(self):
        for argv, message in ((["--provider", "gemini", "--key-env", "ANTHROPIC_API_KEY"], "--key-env for gemini"),
                              (["--provider", "gemini", "--max-usd", "20"], "--max-usd needs"),
                              (["--thinking-level", "medium"], "--thinking-level applies to --provider gemini only")):
            with patch.object(sys, "argv", ["run_experiments.py", *argv, "--devices", "P2"]), self.assertRaises(SystemExit) as stop:
                RUN.main()
            self.assertIn(message, str(stop.exception.code))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BatchCostTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {"version": "0.7.0", "date": dt.date.today().isoformat(),
              "scope": "run_experiments.py provider defaults and estimated-cost cap with canned run summaries; no Node run, bridge, key or model request.",
              "testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "passed": result.wasSuccessful()}
    (ROOT / "validation" / "v7g-batch-cost.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
