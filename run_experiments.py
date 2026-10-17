#!/usr/bin/env python3
"""Batch runner for the command-line five-trial experiment (no browser page).

Runs tests/live_claude_v7.cjs once per device x seed x repeat, enforces a total
model-call budget across the batch, and writes batch-summary.json and
batch-summary.csv next to the per-run summaries.

Live runs make AUTHORIZED real model API calls through claude_bridge.py, or
gemini_bridge.py with --provider gemini. This script never reads the API key;
the Node runner only checks that the named variable exists and the bridge keeps
the value. Use --offline first to check the pipeline without any API call.

--max-usd stops starting new runs once the token cost estimated from the
recorded usage (prices given on the command line) would pass the cap. The
estimate is not the bill: check the provider console as well.

Examples:
  python run_experiments.py --offline --devices P2,G3 --seeds 2026
  python run_experiments.py --devices P2,G3 --seeds 2026,3140,8675 --model claude-haiku-5-5 --total-max-calls 700
  python run_experiments.py --provider gemini --model gemini-3.5-flash-lite --devices P2 --seeds 2026 \
      --total-max-calls 150 --max-usd 20 --usd-per-mtok-in 0.30 --usd-per-mtok-out 2.50

Standard library only.
"""
import argparse
import csv
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNNER = ROOT / "tests" / "live_claude_v7.cjs"
PROVIDERS = {
    "claude": {"keys": ("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_Extra"), "model": "claude-haiku-5-5", "port": 8766},
    # gemini_bridge.py authorizes only gemini_api_key (it also reads the GEMINI_API_KEY spelling).
    "gemini": {"keys": ("gemini_api_key",), "model": "gemini-3.5-flash-lite", "port": 8767},
}
KEY_NAMES = tuple(name for spec in PROVIDERS.values() for name in spec["keys"])


def parse_args():
    p = argparse.ArgumentParser(description="Run headless five-trial experiments in a batch.")
    p.add_argument("--devices", default="P2,G3", help="Comma list of P2 and/or G3 (default P2,G3).")
    p.add_argument("--seeds", default="2026,3140,8675", help="Comma list of seeds (default 2026,3140,8675).")
    p.add_argument("--repeat", type=int, default=1, help="Runs per device x seed (default 1).")
    p.add_argument("--provider", choices=tuple(PROVIDERS), default="claude", help="Model provider (default claude).")
    p.add_argument("--model", default=None, help="Model ID (default claude-haiku-5-5 for claude, gemini-3.5-flash-lite for gemini).")
    p.add_argument("--max-calls-per-run", type=int, default=150, help="Model-call cap for one run, <=500 (default 150).")
    p.add_argument("--total-max-calls", type=int, default=600, help="Model-call budget for the whole batch (default 600).")
    p.add_argument("--min-calls-to-start", type=int, default=100,
                   help="Do not start a run with less remaining budget (default 100; a five-trial run has used 77-92 calls).")
    p.add_argument("--manual-template", choices=("on", "off"), default="off")
    p.add_argument("--controller-mode", choices=("generated", "builtin"), default="generated")
    p.add_argument("--trials", type=int, choices=(1, 5), default=5)
    p.add_argument("--min-interval-ms", type=int, default=6000)
    p.add_argument("--key-env", choices=KEY_NAMES, default=None,
                   help="Key variable name (default ANTHROPIC_API_KEY for claude, gemini_api_key for gemini).")
    p.add_argument("--port", type=int, default=None,
                   help="Bridge port (default 8766 claude, 8767 gemini). Run batches one at a time, or give each concurrent batch its own port.")
    p.add_argument("--max-usd", type=float, default=None,
                   help="Stop starting runs when the estimated token cost would pass this cap (needs both price options).")
    p.add_argument("--usd-per-mtok-in", type=float, default=None, help="Input price per 1M tokens used for the estimate.")
    p.add_argument("--usd-per-mtok-out", type=float, default=None, help="Output price per 1M tokens (thinking included) used for the estimate.")
    p.add_argument("--out-dir", type=Path, default=None, help="Default: artifacts/live-runs/batch-<timestamp>")
    p.add_argument("--offline", action="store_true", help="Offline rule policy; no bridge, no API call, no cost.")
    p.add_argument("--no-full", action="store_true", help="Skip the gzipped full report per run.")
    p.add_argument("--holdout", action="store_true",
                   help="Allow a held-out device: X (VLAB-X, CoreXY + Modbus-RTU style) or Y (VLAB-Y, five-bar parallel arm, JSON line); adds it to the manual library.")
    p.add_argument("--gate", choices=("C", "D", "E"), default="E",
                   help="Controller gate: E (default) = D plus the elbow-limit two-link case on rotary manuals; D limits the two-link case to 1.3x reference actions; C is reach-only.")
    p.add_argument("--no-transient-retry", action="store_true",
                   help="Do not resend a model request after a timeout or server failure (Claude HTTP 500/502/504/529; Gemini 500/502/504 or 503 UNAVAILABLE). Default: one retry, counted in the budget.")
    p.add_argument("--legacy-target", action="store_true", help="Re-measure the goal marker every step (behaviour before 2026-10-13); default holds the select_goal measurement.")
    p.add_argument("--stop-on-failure", action="store_true", help="Stop the batch after the first run that does not finish all trials.")
    p.add_argument("--yes", action="store_true", help="Skip the confirmation prompt for live runs.")
    return p.parse_args()


def run_one(args, device, seed, rep, max_calls, out_dir):
    label = f"{device.lower()}-s{seed}-r{rep}-{'offline' if args.offline else args.provider}"
    cmd = ["node", str(RUNNER), "--device", device, "--seed", str(seed), "--label", label, "--out-dir", str(out_dir),
           "--manual-template", args.manual_template, "--controller-mode", args.controller_mode, "--trials", str(args.trials)]
    if args.offline:
        cmd.append("--offline")
    else:
        cmd += ["--provider", args.provider, "--model", args.model, "--max-calls", str(max_calls), "--min-interval-ms", str(args.min_interval_ms),
                "--key-env", args.key_env, "--port", str(args.port)]
    if args.no_full:
        cmd.append("--no-full")
    if args.legacy_target:
        cmd.append("--legacy-target")
    cmd += ["--gate", args.gate]
    if args.holdout:
        cmd.append("--holdout")
    if args.no_transient_retry and not args.offline:
        cmd.append("--no-transient-retry")
    print(f"\n=== {label} (cap {0 if args.offline else max_calls} calls) ===", flush=True)
    result = None
    with subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace") as proc:
        for line in proc.stdout:
            if line.startswith("RESULT "):
                try:
                    result = json.loads(line[7:])
                except json.JSONDecodeError:
                    result = None
            else:
                print(line, end="", flush=True)
        code = proc.wait()
    summary = None
    if result and result.get("summary") and Path(result["summary"]).exists():
        summary = json.loads(Path(result["summary"]).read_text(encoding="utf-8"))
    return label, code, result, summary


def token_counts(usage):
    """Billed input and output tokens from one run's summed usage (Claude or Gemini fields)."""
    u = usage or {}
    if any(k in u for k in ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount")):
        # Gemini bills thinking tokens at the output price.
        return u.get("promptTokenCount", 0), u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0), u.get("thoughtsTokenCount", 0)
    return (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0),
            u.get("output_tokens", 0), None)


def estimated_usd(args, tokens_in, tokens_out):
    if args.usd_per_mtok_in is None or args.usd_per_mtok_out is None:
        return None
    return round((tokens_in * args.usd_per_mtok_in + tokens_out * args.usd_per_mtok_out) / 1e6, 4)


def row_for(args, label, device, seed, rep, code, result, summary):
    s = summary or {}
    tokens_in, tokens_out, thoughts = token_counts(s.get("usage"))
    res = s.get("result") or {}
    ct = s.get("controllerTests") or {}
    step = s.get("controllerStepStats") or {}
    trials = s.get("trials") or []
    errs = [t.get("placementErrorPx") for t in trials if t.get("placementErrorPx") is not None]
    return {
        "label": label, "device": device, "seed": seed, "repeat": rep, "exitCode": code,
        "completedTrials": res.get("completedTrials"), "allTruthPlaced": res.get("allTruthPlaced"),
        "failure": res.get("failure"), "failureCategory": res.get("failureCategory"),
        "modelCalls": s.get("modelCalls"), "frontCalls": s.get("frontCalls"), "decisionRejections": s.get("decisionRejections"),
        "rateLimitRetries": s.get("rateLimitRetries"), "transientRetries": s.get("transientRetries"), "actions": s.get("actionCount"), "xyActions": s.get("xyActionCount"),
        "unconfirmed": s.get("unconfirmedActuationCount"), "maxPlacementErrorPx": max(errs) if errs else None,
        "controllerTestRatio": (ct.get("efficiency") or {}).get("ratio"), "twoLinkRatio": ((ct.get("efficiency") or {}).get("nonlinearArm") or {}).get("ratio"), "medianStep": step.get("medianMaxAbsU"),
        "driverFirstTry": None if not s.get("onboardingSteps") else not any(t == "test_driver" and not ok for t, ok in s["onboardingSteps"]),
        "controllerFirstTry": None if not s.get("onboardingSteps") else not any(t == "test_controller" and not ok for t, ok in s["onboardingSteps"]),
        "inputTokens": tokens_in, "outputTokens": tokens_out, "thoughtsTokens": thoughts,
        "estimatedUsd": None if args.offline or summary is None else estimated_usd(args, tokens_in, tokens_out),
        "summary": result.get("summary") if result else None, "runnerError": (result or {}).get("error"),
    }


def main():
    args = parse_args()
    if shutil.which("node") is None:
        sys.exit("Node.js is required (node not found on PATH).")
    if not (ROOT / "unknown-device-v7.0.html").exists():
        sys.exit("Run python build.py first.")
    devices = [d.strip().upper() for d in args.devices.split(",") if d.strip()]
    if not devices or any(d not in ("P2", "G3", "X", "Y") for d in devices):
        sys.exit("--devices must list P2, G3, X and/or Y.")
    if any(d in ("X", "Y") for d in devices) and not args.holdout:
        sys.exit("X and Y are held-out evaluation devices; add --holdout to run them.")
    try:
        seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    except ValueError:
        sys.exit("--seeds must be integers.")
    if not seeds or args.repeat < 1:
        sys.exit("Need at least one seed and --repeat >= 1.")
    spec = PROVIDERS[args.provider]
    args.model = args.model or spec["model"]
    args.key_env = args.key_env or spec["keys"][0]
    args.port = args.port or spec["port"]
    if args.key_env not in spec["keys"]:
        sys.exit(f"--key-env for {args.provider} must be one of {', '.join(spec['keys'])}.")
    if args.max_usd is not None and (args.max_usd <= 0 or args.usd_per_mtok_in is None or args.usd_per_mtok_out is None):
        sys.exit("--max-usd needs a positive cap plus --usd-per-mtok-in and --usd-per-mtok-out (official prices at run time).")
    per_run = max(1, min(500, args.max_calls_per_run))
    plan = [(d, s, r) for r in range(1, args.repeat + 1) for s in seeds for d in devices]
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = (args.out_dir or ROOT / "artifacts" / "live-runs" / f"batch-{stamp}").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Runs: {len(plan)} ({', '.join(devices)} x seeds {seeds} x repeat {args.repeat}); mode={'offline' if args.offline else args.provider}")
    if not args.offline:
        print(f"Provider: {args.provider}; model: {args.model}; per-run cap {per_run}; batch budget {args.total_max_calls} model calls (all real requests count, including retries).")
        if args.max_usd is not None:
            print(f"Estimated-cost cap: US${args.max_usd:g} at ${args.usd_per_mtok_in:g} in / ${args.usd_per_mtok_out:g} out per 1M tokens.")
        if not args.yes:
            if input("Start live runs? Type yes to continue: ").strip().lower() != "yes":
                sys.exit("Cancelled; no request was sent.")

    remaining = 0 if args.offline else args.total_max_calls
    rows, stopped = [], None
    spent_usd, spent_calls = 0.0, 0
    for device, seed, rep in plan:
        if not args.offline:
            if remaining < args.min_calls_to_start:
                stopped = f"batch budget left {remaining} < {args.min_calls_to_start}; remaining runs skipped"
                print("\n" + stopped)
                break
            cap = min(per_run, remaining)
            if args.max_usd is not None:
                # Project the next run at its full call cap and the mean cost per call so far.
                projected = spent_usd + (spent_usd / spent_calls * cap if spent_calls else 0)
                if spent_usd >= args.max_usd or projected > args.max_usd:
                    stopped = f"estimated cost US${spent_usd:.2f} (next run projected to US${projected:.2f}) would pass the US${args.max_usd:g} cap; remaining runs skipped"
                    print("\n" + stopped)
                    break
        else:
            cap = 0
        label, code, result, summary = run_one(args, device, seed, rep, cap, out_dir)
        used = (summary or {}).get("modelCalls")
        if not args.offline:
            # Unknown usage is charged at the full cap so the budget is never under-counted.
            remaining -= cap if used is None else used
        row = row_for(args, label, device, seed, rep, code, result, summary)
        rows.append(row)
        if row["estimatedUsd"] is not None:
            spent_usd += row["estimatedUsd"]
            spent_calls += used or 0
        elif args.max_usd is not None and spent_calls:
            # No usage record: charge the full call cap at the mean cost per call so far.
            spent_usd += spent_usd / spent_calls * cap
        cost = f", est. US${spent_usd:.2f} so far" if row["estimatedUsd"] is not None else ""
        print(f"--> {label}: completed {row['completedTrials']}/{args.trials}, truth {row['allTruthPlaced']}, actions {row['actions']}, "
              f"calls {row['modelCalls']}, budget left {remaining if not args.offline else '-'}{cost}", flush=True)
        if row["runnerError"]:
            print(f"    runner error: {row['runnerError']}")
            if any(text in row["runnerError"] for text in ("is not set in this environment", "Run python build.py", "Bridge could not find", "is already in use")):
                stopped = f"stopped: setup problem in {label} ({row['runnerError']}); no further runs"
                print(stopped)
                break
        if args.stop_on_failure and row["completedTrials"] != args.trials:
            stopped = f"stopped after {label} did not finish all trials"
            print(stopped)
            break

    batch = {
        "kind": "offline-cli-batch" if args.offline else "live-model-batch", "runner": "run_experiments.py -> tests/live_claude_v7.cjs (headless-node)",
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"), "provider": None if args.offline else args.provider, "model": None if args.offline else args.model,
        "condition": {"manualTemplate": args.manual_template, "controllerMode": args.controller_mode, "trials": args.trials, "goalTarget": "legacy re-measured" if args.legacy_target else "fixed at select_goal", "gate": args.gate, "holdout": args.holdout,
                      "transientRetry": None if args.offline else not args.no_transient_retry,
                      "minIntervalMs": None if args.offline else args.min_interval_ms},
        "budget": None if args.offline else {"perRun": per_run, "total": args.total_max_calls, "remaining": remaining,
                                             "maxUsd": args.max_usd, "usdPerMTokIn": args.usd_per_mtok_in, "usdPerMTokOut": args.usd_per_mtok_out,
                                             "estimatedUsd": round(spent_usd, 4) if args.usd_per_mtok_in is not None and args.usd_per_mtok_out is not None else None},
        "planned": len(plan), "ran": len(rows), "stopped": stopped, "runs": rows,
    }
    (out_dir / "batch-summary.json").write_text(json.dumps(batch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (out_dir / "batch-summary.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["label"])
        writer.writeheader()
        writer.writerows(rows)

    print("\nlabel                      done  truth  actions  calls  ratio  step")
    for r in rows:
        print(f"{r['label']:<26} {str(r['completedTrials']):>4}  {str(r['allTruthPlaced']):<5}  {str(r['actions']):>7}  {str(r['modelCalls']):>5}  "
              f"{str(r['controllerTestRatio']):>5}  {str(r['medianStep'])}")
    print(f"\nWrote {out_dir / 'batch-summary.json'} and batch-summary.csv")
    print("To share results: zip the *.summary.json files plus batch-summary.json (add *.full.json.gz for trace analysis).")


if __name__ == "__main__":
    main()
