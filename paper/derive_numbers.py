"""Derived numbers and figures for paper/manuscript.md (2026-10-17).

Reads only the run records in validation/ and writes
validation/manuscript-derived-2026-10-17.json plus paper/figures/*.png, so
every total, ratio and interval in the manuscript traces to a record. No model
request, bridge or key is involved.

    python paper/derive_numbers.py
"""
import json
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from scipy.stats import beta

ROOT = Path(__file__).resolve().parents[1]
VAL = ROOT / "validation"
FIG = ROOT / "paper" / "figures"

RECORDS = {
    ("claude-haiku-5-5", "VLAB-P2"): "live-cli-batch-E-2026-10-15.json",
    ("claude-haiku-5-5", "VLAB-X"): "live-cli-holdout-X-2026-10-15.json",
    ("claude-haiku-5-5", "VLAB-Y"): "live-cli-holdout-Y-2026-10-15.json",
    ("gemini-3.5-flash-lite", "VLAB-X"): "live-cli-holdout-gemini-X-2026-10-17.json",
    ("gemini-3.5-flash-lite", "VLAB-Y"): "live-cli-holdout-gemini-Y-2026-10-17.json",
}
PILOTS = ["live-cli-pilot-gemini-P2-2026-10-17.json", "live-cli-pilot2-gemini-P2-2026-10-17.json"]
C_RECORDS = ["live-cli-batch-C-2026-10-14.json", "live-cli-batch-C-repeats-2026-10-14.json", "live-cli-batch-C-repeats2-2026-10-14.json"]
D_RECORDS = ["live-cli-batch-D-2026-10-14.json", "live-cli-batch-D2-2026-10-14.json"]


def load(name):
    return json.loads((VAL / name).read_text(encoding="utf-8"))


def clopper_pearson(k, n, level=0.95):
    a = (1 - level) / 2
    low = 0.0 if k == 0 else beta.ppf(a, k, n - k + 1)
    high = 1.0 if k == n else beta.ppf(1 - a, k + 1, n - k)
    return [round(float(low), 3), round(float(high), 3)]


def tokens(usage):
    usage = usage or {}
    if "promptTokenCount" in usage:
        thoughts = usage.get("thoughtsTokenCount", 0)
        return usage.get("promptTokenCount", 0), usage.get("candidatesTokenCount", 0) + thoughts, thoughts
    return usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0), usage.get("output_tokens", 0), None


def stop_stage(run):
    if run.get("completedTrials") == 5:
        return "done"
    if run.get("stoppedAt"):
        return run["stoppedAt"]
    attempts = run.get("controllerGateAttempts") or []
    return "controller gate" if attempts and not any(attempts) else "driver gate"


def group(model, device):
    d = load(RECORDS[(model, device)])
    runs = d["runs"]
    done = [r for r in runs if r["completedTrials"] == 5]
    ratios = [r["ratioToBaseline"] for r in done]
    tin = tout = 0
    thoughts = 0
    for r in runs:
        i, o, t = tokens(r.get("usage"))
        tin, tout = tin + i, tout + o
        thoughts += t or 0
    calls = sum(r["modelCalls"] for r in runs)
    trials = sum(r["completedTrials"] for r in runs)
    failed = [r for r in runs if r["completedTrials"] < 5]
    out = {
        "record": "validation/" + RECORDS[(model, device)],
        "runs": len(runs), "completeRuns": len(done), "trialsCompleted": trials, "trialsPlanned": 5 * len(runs),
        "runCompletionCI95": clopper_pearson(len(done), len(runs)),
        "ratiosCompletedRuns": ratios,
        "ratioMedian": round(median(ratios), 2) if ratios else None,
        "ratioRange": [min(ratios), max(ratios)] if ratios else None,
        "modelCallsTotal": calls,
        "modelCallsRange": [min(r["modelCalls"] for r in runs), max(r["modelCalls"] for r in runs)],
        "inputTokensTotal": tin if any(r.get("usage") for r in runs) else None,
        "outputTokensTotal": tout if any(r.get("usage") for r in runs) else None,
        "unconfirmedTotal": sum(r.get("unconfirmed", 0) for r in runs),
        "failedRuns": [{"label": r["label"], "completedTrials": r["completedTrials"], "actions": r["actions"],
                        "stage": stop_stage(r), "modelCalls": r["modelCalls"]} for r in failed],
        "runRows": [{"label": r["label"], "seed": r["seed"], "completedTrials": r["completedTrials"], "actions": r["actions"],
                     "ratio": r.get("ratioToBaseline"), "modelCalls": r["modelCalls"], "frontCalls": r.get("frontCalls"),
                     "stage": stop_stage(r)} for r in runs],
    }
    if any(r.get("usage") for r in runs):
        out["perCallInputTokens"] = round(tin / calls)
        out["perCallOutputTokens"] = round(tout / calls)
    if "promptTokenCount" in (runs[0].get("usage") or {}):
        out["thinkingTokensTotal"] = thoughts
        out["estimatedUsd"] = round(sum(r.get("estimatedUsd") or 0 for r in runs), 4)
        out["truncationsTotal"] = d["summary"]["truncationsTotal"]
        out["driverVersionsChecked"] = d["summary"]["driverVersionsChecked"]
        out["driverVersionsAcceptingInvalidReplies"] = d["summary"]["driverVersionsAcceptingInvalidReplies"]
    if "controllerGateAttempts" in runs[0]:
        out["controllerGateTestsTotal"] = sum(len(r.get("controllerGateAttempts") or []) for r in runs)
        out["controllerFirstTry"] = sum(1 for r in runs if (r.get("controllerGateAttempts") or [None])[0] is True)
    if "driverGateAttempts" in runs[0]:
        out["driverFirstTry"] = sum(1 for r in runs if (r.get("driverGateAttempts") or [None])[0] is True)
        out["driverGatePassedRuns"] = sum(1 for r in runs if any(r.get("driverGateAttempts") or []))
    return out


def gate_rejections():
    rows = []
    y = load(RECORDS[("claude-haiku-5-5", "VLAB-Y")])
    for v in y["gateRejectedVersions"]:
        rows.append(("claude-haiku-5-5", "VLAB-Y", v["label"], v["version"], v["replayIgnoringGate"], v.get("gateFailedCases")))
    for dev in ("VLAB-X", "VLAB-Y"):
        g = load(RECORDS[("gemini-3.5-flash-lite", dev)])
        for v in g["gateRejectedControllerVersions"]:
            rows.append(("gemini-3.5-flash-lite", dev, v["label"], v["version"], v["replayIgnoringGate"], None))
    out = {}
    for model, dev, label, version, replay, cases in rows:
        key = f"{model} {dev}"
        bucket = out.setdefault(key, {"rejectedVersions": 0, "wouldCompleteAllThreeSeeds": 0, "elbowCaseOnly": 0})
        bucket["rejectedVersions"] += 1
        bucket["wouldCompleteAllThreeSeeds"] += all(s["completed"] == 5 for s in replay.values())
        bucket["elbowCaseOnly"] += cases == ["二連桿肘關節極限繞行"]
    y = [v for k, v in out.items() if k.endswith("VLAB-Y")]
    out["VLAB-Y both models"] = {"rejectedVersions": sum(v["rejectedVersions"] for v in y),
                                 "wouldCompleteAllThreeSeeds": sum(v["wouldCompleteAllThreeSeeds"] for v in y)}
    return out


def truncation_thinking():
    counts = [t["thoughtsTokenCount"] for dev in ("VLAB-X", "VLAB-Y")
              for r in load(RECORDS[("gemini-3.5-flash-lite", dev)])["runs"] for t in r["truncations"]]
    return {"withTraceRecord": len(counts), "min": min(counts), "max": max(counts)}


def gemini_driver_tests():
    runs = [r for dev in ("VLAB-X", "VLAB-Y") for r in load(RECORDS[("gemini-3.5-flash-lite", dev)])["runs"]]
    return {"tests": sum(len(r["driverGateAttempts"]) for r in runs),
            "failedRejectCheck": sum(r["driverGateFailureCounts"].get("驅動程式拒絕失敗或毀損回覆", 0) for r in runs)}


def development():
    def p2(names):
        runs = [r for n in names for r in load(n)["runs"] if r["device"] == "VLAB-P2"]
        return {"runs": len(runs), "trialsCompleted": sum(r["completedTrials"] for r in runs), "trialsPlanned": 5 * len(runs),
                "controlFailureRuns": sum(1 for r in runs if "取放動作上限" in (r.get("failure") or "")),
                "interruptedRuns": sum(1 for r in runs if r["completedTrials"] < 5 and "取放動作上限" not in (r.get("failure") or ""))}
    c_rows = [c for row in load(C_RECORDS[2])["cVersionOverview"]["rows"] if row["device"] == "VLAB-P2" for c in row["controllers"]]
    c_ratios = [c["ratio"] for c in c_rows]
    g3_rows = [c for row in load(C_RECORDS[2])["cVersionOverview"]["rows"] if row["device"] == "VLAB-G3" for c in row["controllers"]]
    e = load(RECORDS[("claude-haiku-5-5", "VLAB-P2")])
    return {
        "C": {**p2(C_RECORDS), "fullControllerRatiosP2": c_ratios, "fullControllerRatioMedianP2": round(median(c_ratios), 2),
              "fullControllersAbove1_3": sum(r > 1.3 for r in c_ratios),
              "g3Ratios": [c["ratio"] for c in g3_rows],
              "g3TrialsCompleted": sum(r["completedTrials"] for n in C_RECORDS for r in load(n)["runs"] if r["device"] == "VLAB-G3")},
        "D": p2(D_RECORDS),
        "E": {**p2([RECORDS[("claude-haiku-5-5", "VLAB-P2")]]), "ratioMedian": e["summary"]["ratioMedian"],
              "ratioRange": e["summary"]["ratioRange"], "ratiosAbove1_3": e["summary"]["ratiosAbove1_3"],
              "controllerGateTestsTotal": sum(len(r["controllerGateAttempts"]) for r in e["runs"]),
              "controllerFirstTry": sum(1 for r in e["runs"] if r["controllerGateAttempts"][0])},
    }


def fig_pipeline(path):
    fig, ax = plt.subplots(figsize=(10, 4.2))
    ax.set_xlim(0, 100); ax.set_ylim(0, 44); ax.axis("off")
    model_c, host_c, gate_c = "#dbe9f6", "#eeeeee", "#f9e0c7"
    boxes = [
        (1, 24, 15, 16, "1. Identify\nand connect", "inspect_device\nlist_interfaces\nread_manual\nconnect, handshake", host_c),
        (18, 24, 15, 16, "2. Driver", "write_driver\n(encode / decode,\nfrom protocol spec;\nno template)", model_c),
        (35, 24, 15, 16, "Gate 1: driver\ndry run", "6 checks against the\nhost protocol profile;\nno actuation", gate_c),
        (52, 24, 15, 16, "3. Controller", "write_controller\nstateless control(state)\nfrom pixels and\nconfirmed history", model_c),
        (69, 24, 15, 16, "Gate 2: isolation\ncases", "9 synthetic plants\n(2 only for rotary\nmanuals); no actuation", gate_c),
        (86, 24, 13, 16, "start_control", "both gates passed\nfor the same\nsource hashes", host_c),
        (1, 2, 66, 15, "4. Five pick-and-place trials", "Pre-implemented step order (lift, grip, select_goal, verify_grasp, verify_place);\nmodel issues each step; XY moves come from the generated controller.\nEvery frame and ACK is checked against the host profile; bad output stops the run.", host_c),
        (70, 2, 29, 15, "Evaluation", "System: image verifier (≤ 12 px).\nPaper: simulator truth, hidden\nfrom the agent.", "#e3f1df"),
    ]
    for x, y, w, h, title, body, color in boxes:
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.3", fc=color, ec="#555555", lw=0.8))
        ax.text(x + w / 2, y + h - 1.2, title, ha="center", va="top", fontsize=8.2, fontweight="bold")
        ax.text(x + w / 2, y + h / 2 - 2.6, body, ha="center", va="center", fontsize=7)
    for x0, x1 in ((16.3, 17.7), (33.3, 34.7), (50.3, 51.7), (67.3, 68.7), (84.3, 85.7)):
        ax.annotate("", xy=(x1, 32), xytext=(x0, 32), arrowprops=dict(arrowstyle="->", lw=1))
    ax.annotate("", xy=(34, 17.5), xytext=(92.5, 23.6), arrowprops=dict(arrowstyle="->", lw=1, connectionstyle="arc3,rad=-0.15"))
    ax.annotate("", xy=(69.6, 9.5), xytext=(67.4, 9.5), arrowprops=dict(arrowstyle="->", lw=1))
    for x in (42.5, 76.5):
        ax.text(x, 42.6, "fail: feedback, rewrite", ha="center", fontsize=6.5, color="#a0522d")
    handles = [plt.Rectangle((0, 0), 1, 1, fc=c, ec="#555555") for c in (model_c, gate_c, host_c)]
    ax.legend(handles, ["written by the model", "host-side gate", "host / pre-implemented"], loc="upper center",
              bbox_to_anchor=(0.5, 0.02), fontsize=7, frameon=False, ncol=3)
    fig.savefig(path, dpi=200, bbox_inches="tight"); plt.close(fig)


def fig_runs(groups, path):
    order = [("claude-haiku-5-5", "VLAB-X"), ("claude-haiku-5-5", "VLAB-Y"), ("gemini-3.5-flash-lite", "VLAB-X"), ("gemini-3.5-flash-lite", "VLAB-Y")]
    colors = {"done": "#7fbf7f", "driver gate": "#e07b6a", "controller gate": "#f2b05e"}
    fig, ax = plt.subplots(figsize=(9, 3.2))
    for row, key in enumerate(order):
        for col, r in enumerate(groups[key]["runRows"]):
            y = len(order) - 1 - row
            ax.add_patch(plt.Rectangle((col, y), 0.94, 0.9, fc=colors[r["stage"]], ec="white"))
            ax.text(col + 0.47, y + 0.55, f"{r['completedTrials']}/5", ha="center", va="center", fontsize=8, fontweight="bold")
            ax.text(col + 0.47, y + 0.22, f"{r['modelCalls']} calls", ha="center", va="center", fontsize=6)
    ax.set_xlim(0, 9); ax.set_ylim(0, len(order))
    ax.set_yticks([len(order) - 1 - i + 0.45 for i in range(len(order))])
    ax.set_yticklabels([f"{m}\n{d}" for m, d in order], fontsize=7.5)
    ax.set_xticks([i + 0.47 for i in range(9)])
    ax.set_xticklabels([f"{s}\nr{k}" for s in (2026, 3140, 8675) for k in (1, 2, 3)], fontsize=7)
    ax.tick_params(length=0)
    for s in ax.spines.values(): s.set_visible(False)
    handles = [plt.Rectangle((0, 0), 1, 1, fc=c) for c in colors.values()]
    ax.legend(handles, ["completed all trials", "stopped at driver gate", "stopped at controller gate"], fontsize=7,
              loc="upper center", bbox_to_anchor=(0.5, -0.22), ncol=3, frameon=False)
    fig.savefig(path, dpi=200, bbox_inches="tight"); plt.close(fig)


def fig_ratios(groups, path):
    order = [("claude-haiku-5-5", "VLAB-P2", "P2 (development)\nHaiku"), ("claude-haiku-5-5", "VLAB-X", "VLAB-X\nHaiku"),
             ("gemini-3.5-flash-lite", "VLAB-X", "VLAB-X\nGemini"), ("claude-haiku-5-5", "VLAB-Y", "VLAB-Y\nHaiku"),
             ("gemini-3.5-flash-lite", "VLAB-Y", "VLAB-Y\nGemini")]
    fig, ax = plt.subplots(figsize=(6.5, 3))
    for i, (m, d, _) in enumerate(order):
        vals = groups[(m, d)]["ratiosCompletedRuns"]
        xs = [i + (j - (len(vals) - 1) / 2) * 0.05 for j in range(len(vals))]
        ax.scatter(xs, vals, s=18, color="#1f5f9f" if m.startswith("claude") else "#b5562f", zorder=3)
        ax.text(i, 0.82, f"n={len(vals)}", ha="center", fontsize=7)
    ax.axhline(1.0, color="#888888", lw=0.8, ls="--")
    ax.set_xticks(range(len(order))); ax.set_xticklabels([o[2] for o in order], fontsize=7.5)
    ax.set_ylabel("live actions / reference module", fontsize=8); ax.set_ylim(0.78, 1.6)
    ax.tick_params(labelsize=7.5)
    fig.savefig(path, dpi=200, bbox_inches="tight"); plt.close(fig)


def main():
    FIG.mkdir(parents=True, exist_ok=True)
    groups = {key: group(*key) for key in RECORDS}
    held = {m: [groups[(m, d)] for d in ("VLAB-X", "VLAB-Y")] for m in ("claude-haiku-5-5", "gemini-3.5-flash-lite")}
    pilots = [load(n) for n in PILOTS]
    heldout = {}
    for m, gs in held.items():
        runs, done = sum(g["runs"] for g in gs), sum(g["completeRuns"] for g in gs)
        heldout[m] = {"runs": runs, "completeRuns": done, "runCompletionCI95": clopper_pearson(done, runs),
                      "trialsCompleted": sum(g["trialsCompleted"] for g in gs), "trialsPlanned": sum(g["trialsPlanned"] for g in gs),
                      "modelCallsTotal": sum(g["modelCallsTotal"] for g in gs)}
    failed = [f for gs in held.values() for g in gs for f in g["failedRuns"]]
    gem = held["gemini-3.5-flash-lite"]
    haiku3 = [groups[("claude-haiku-5-5", d)] for d in ("VLAB-P2", "VLAB-X", "VLAB-Y")]
    out = {
        "version": "0.7.0", "date": "2026-10-17", "kind": "manuscript-derived-numbers", "modelCalls": 0,
        "scope": "Totals, medians and post-hoc Clopper-Pearson intervals derived from the run records listed per group; analysis only, no new runs.",
        "groups": {f"{m} {d}": g for (m, d), g in groups.items()},
        "heldOut": heldout,
        "haikuThreeDevices": {"trialsCompleted": sum(g["trialsCompleted"] for g in haiku3), "trialsPlanned": sum(g["trialsPlanned"] for g in haiku3)},
        "heldOutRunsTotal": sum(h["runs"] for h in heldout.values()),
        "heldOutFailedRuns": len(failed),
        "heldOutFailedRunsWithActuation": sum(1 for f in failed if f["actions"] > 0),
        "heldOutFailedRunsByStage": {s: sum(1 for f in failed if f["stage"] == s) for s in sorted({f["stage"] for f in failed})},
        "heldOutUnconfirmedTotal": sum(g["unconfirmedTotal"] for gs in held.values() for g in gs),
        "geminiHeldOutUsd": round(sum(g["estimatedUsd"] for g in gem), 2),
        "geminiPilotsUsd": round(sum(p["usage"]["estimatedUsd"] for p in pilots), 4),
        "geminiAllUsd": round(sum(g["estimatedUsd"] for g in gem) + sum(p["usage"]["estimatedUsd"] for p in pilots), 2),
        "geminiTruncationsHeldOut": sum(g["truncationsTotal"] for g in gem),
        "geminiTruncationThinkingTokens": truncation_thinking(),
        "geminiDriverTests": gemini_driver_tests(),
        "gateRejectedControllerVersions": gate_rejections(),
        "developmentP2": development(),
        "figures": ["paper/figures/fig1_pipeline.png", "paper/figures/fig2_holdout_runs.png", "paper/figures/fig3_action_ratio.png"],
    }
    (VAL / "manuscript-derived-2026-10-17.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    fig_pipeline(FIG / "fig1_pipeline.png")
    fig_runs(groups, FIG / "fig2_holdout_runs.png")
    fig_ratios(groups, FIG / "fig3_action_ratio.png")
    print(json.dumps({k: out[k] for k in ("heldOut", "haikuThreeDevices", "heldOutRunsTotal", "heldOutFailedRuns", "heldOutFailedRunsWithActuation",
                                         "heldOutFailedRunsByStage", "geminiHeldOutUsd", "geminiPilotsUsd", "geminiAllUsd", "gateRejectedControllerVersions")},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
