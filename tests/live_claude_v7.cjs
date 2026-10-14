'use strict';
// Command-line five-trial runner (no browser page). One run per invocation.
//
// Live mode makes AUTHORIZED real Claude API calls through the local bridge.
// The API key stays inside the bridge process; this script only checks that
// the named variable exists and never reads, prints or stores its value.
// --offline runs the offline rule policy instead (no bridge, no API, no cost)
// so the pipeline can be checked before spending calls.
//
// Headless differences from the browser page: the camera image is drawn on a
// software canvas (no browser anti-aliasing) and generated code runs in a
// Node vm sandbox, not the iframe/Worker sandbox. Report these runs
// separately from browser runs. Gates, thresholds and the model loop are the
// same production code.
//
// Usage:
//   node tests/live_claude_v7.cjs --device G3 --seed 2026 --model claude-haiku-5-5 --max-calls 150
//   node tests/live_claude_v7.cjs --device P2 --seed 3140 --offline
// Options: --device P2|G3  --seed n  --model id  --max-calls n (<=500)
//   --manual-template on|off (off)  --controller-mode generated|builtin (generated)
//   --trials 5|1  --min-interval-ms n (6000)  --port n (8766)
//   --key-env ANTHROPIC_API_KEY|ANTHROPIC_API_KEY_Extra  --out-dir dir  --label name
//   --offline  --no-full
//   --legacy-target  re-measure the goal marker every step (behaviour before 2026-10-13)
//   --gate C|D (D)  D: on rotary manuals the two-link case must also stay within 1.3x the
//                   reference actions; C: reach-only (behaviour before 2026-10-14)
//   --no-transient-retry  do not resend a model request after a timeout or HTTP 500/502/504/529
// The last stdout line is "RESULT <json>" with the summary path for wrappers.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execSync } = require('node:child_process');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const flag = name => argv.includes(name);
const fail = message => { console.error(message); console.log('RESULT ' + JSON.stringify({ ok: false, error: message })); process.exit(2); };

const DEVICES = { P2: 'VLAB-P2', G3: 'VLAB-G3', 'VLAB-P2': 'VLAB-P2', 'VLAB-G3': 'VLAB-G3' };
const device = DEVICES[String(arg('--device', 'G3')).toUpperCase()] || fail('--device must be P2 or G3.');
const seed = Number(arg('--seed', 2026));
if (!Number.isInteger(seed) || seed < 1 || seed > 999999) fail('--seed must be an integer from 1 to 999999.');
const manualTemplate = { on: true, off: false }[arg('--manual-template', 'off')];
if (manualTemplate === undefined) fail('--manual-template must be on or off.');
const controllerMode = arg('--controller-mode', 'generated');
if (!['generated', 'builtin'].includes(controllerMode)) fail('--controller-mode must be generated or builtin.');
const trials = Number(arg('--trials', 5));
if (![1, 5].includes(trials)) fail('--trials must be 1 or 5.');
const offline = flag('--offline');
const fixedGoalTarget = !flag('--legacy-target');
const gate = String(arg('--gate', 'D')).toUpperCase();
if (!['C', 'D'].includes(gate)) fail('--gate must be C or D.');
const twoLinkMaxRatio = gate === 'C' ? null : undefined;
const maxTransientRetries = flag('--no-transient-retry') ? 0 : 1;
const keyEnv = arg('--key-env', 'ANTHROPIC_API_KEY');
const maxCalls = Math.min(500, Math.max(1, Math.floor(Number(arg('--max-calls', 150)) || 150)));
const minIntervalMs = Math.min(120000, Math.max(0, Number(arg('--min-interval-ms', 6000))));
const port = Number(arg('--port', 8766));
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-');
const label = String(arg('--label', `${device.slice(5).toLowerCase()}-s${seed}-${offline ? 'offline' : 'claude'}-${stamp}`)).replace(/[^A-Za-z0-9._-]/g, '_');
const outDir = path.resolve(arg('--out-dir', path.join(root, 'artifacts', 'live-runs', stamp.slice(0, 10))));

function gitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain -- src tests', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return { commit, dirtySourceOrTests: dirty };
  } catch { return { commit: null, dirtySourceOrTests: null }; }
}

let bridge = null;
function stopBridge() { if (bridge && bridge.exitCode === null) bridge.kill(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopBridge(); process.exit(130); });

function startBridge() {
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_Extra'].includes(keyEnv)) throw new Error('Unsupported key variable name.');
  if (!process.env[keyEnv]) throw new Error(`${keyEnv} is not set in this environment; no request was sent.`);
  const html = path.join(root, 'unknown-device-v7.0.html');
  if (!fs.existsSync(html)) throw new Error('Run python build.py first.');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  // -u / PYTHONUNBUFFERED: stdout is a pipe here, and Python would otherwise
  // block-buffer the "available" startup line until the 15 s timeout fires.
  bridge = spawn(python, ['-u', path.join(root, 'claude_bridge.py'), '--port', String(port), '--max-calls', String(maxCalls), '--key-env', keyEnv, '--html', html],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Bridge did not start.')), 15000);
    bridge.stdout.on('data', chunk => { out += chunk; if (/available/.test(out)) { clearTimeout(timer); resolve(); } else if (/not found/.test(out)) { clearTimeout(timer); stopBridge(); reject(new Error('Bridge could not find the key variable.')); } });
    bridge.stderr.on('data', chunk => process.stderr.write(String(chunk).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')));
    bridge.on('exit', code => { clearTimeout(timer); reject(new Error('Bridge exited: ' + code)); });
  });
}

const median = values => { const s = values.slice().sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const round = (v, n = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(n));

function summarize(report, { model, error }) {
  const o = report?.onboarding || {}, trace = report?.trace || [], truth = report?.evaluatorTruth || [];
  const moves = trace.filter(e => e.decision?.source === 'controller-module' && e.decision.tool === 'move').map(e => e.decision.args.u);
  const mags = moves.map(u => Math.max(Math.abs(u[0]), Math.abs(u[1])));
  const truthAt = index => { let last = null; for (const t of truth) if (t.eventIndex <= index) last = t; return last?.diagnostics?.manipulation || null; };
  const trialRows = (report?.trials || []).map(t => {
    const m = truthAt(t.eventEnd);
    return { trial: t.trialNumber, label: t.label, destinationHeight: t.destinationHeight, success: t.success, failure: t.failure,
      placementErrorPx: round(t.placementError, 2), actions: t.actionCount, xyActions: t.xyActionCount, modelCalls: t.modelCalls,
      evaluatorTruth: m ? { placed: m.placed, attached: m.attached, objectHeight: m.objectHeight,
        objectToDestinationPx: round(Math.hypot(m.object[0] - m.destination[0], m.object[1] - m.destination[1]), 2) } : null };
  });
  const rejections = trace.filter(e => e.kind === 'decision-rejected').map(e => String(e.explanation || '').slice(0, 200));
  const failedAttempts = trace.filter(e => e.stage === 'onboarding' && e.toolResult && !e.toolResult.ok && e.kind !== 'decision-rejected').map(e => {
    const d = e.toolResult.data || {};
    return { tool: e.decision?.tool || null, failed: [...(d.tests || []).filter(t => !t.passed).map(t => t.name), ...(d.cases || []).filter(c => !c.passed).map(c => c.name)], summary: String(e.toolResult.summary || '').slice(0, 200) };
  });
  const ct = o.controllerTests;
  return {
    version: report?.version || '0.7.0', kind: offline ? 'offline-cli-run' : 'live-model-run', runner: 'headless-node (tests/live_claude_v7.cjs)',
    provider: offline ? null : 'claude', model: offline ? null : (report?.model || model || null), git: gitInfo(), node: process.version,
    condition: { device, protocol: report?.experiment?.protocol || null, manualTemplate, controllerMode, trials, seed, goalTarget: report?.suiteParameters?.goalTarget || (fixedGoalTarget ? 'fixed' : 'legacy'), gate, controllerGate: report?.suiteParameters?.controllerGate ?? null, maxTransientRetries: offline ? null : maxTransientRetries, maxCalls: offline ? 0 : maxCalls, minIntervalMs: offline ? null : minIntervalMs },
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), runnerError: error,
    result: { done: report?.done ?? false, failure: report?.failure ?? null, failureCategory: report?.failureCategory ?? null, completedTrials: report?.suiteProgress?.totalCompleted ?? 0,
      allTruthPlaced: trialRows.length === trials && trialRows.every(t => t.evaluatorTruth?.placed === true) },
    modelCalls: report?.modelCalls ?? 0, frontCalls: report?.provenance?.frontCalls ?? null, controlCalls: report?.provenance?.controlCalls ?? null, usage: report?.provenance?.usage || null,
    rateLimitRetries: report?.modelRuntime?.rateLimitRetries ?? null, transientRetries: report?.modelRuntime?.transientRetries ?? null, decisionRejections: report?.decisionRejections ?? null, decisionRejectionDetails: rejections,
    actionCount: report?.actionCount ?? null, xyActionCount: report?.xyActionCount ?? null, unconfirmedActuationCount: report?.unconfirmedActuationCount ?? null,
    driverRuntime: report?.driverRuntime ? { requests: report.driverRuntime.requests, failures: report.driverRuntime.failures, programErrors: report.driverRuntime.programErrors } : null,
    provenance: report?.provenance ? { driverSource: report.provenance.driverSource, controllerSource: report.provenance.controllerSource } : null,
    onboardingSteps: (o.steps || []).map(s => [s.tool, s.ok]), failedAttempts,
    driverTests: o.driverTests ? { passed: o.driverTests.passed, protocol: o.driverTests.protocol, failed: (o.driverTests.tests || []).filter(t => !t.passed).map(t => t.name) } : null,
    controllerTests: ct ? { passed: ct.passed, channelKind: ct.channelKind ?? null, twoLinkMaxRatio: ct.twoLinkMaxRatio ?? null, efficiency: ct.efficiency ? { actions: ct.efficiency.actions, referenceActions: ct.efficiency.referenceActions, ratio: ct.efficiency.ratio, nonlinearArm: ct.efficiency.nonlinearArm ?? null } : null,
      cases: (ct.cases || []).map(c => ({ name: c.name, passed: c.passed, gate: c.gate ?? null, actions: c.actions, referenceActions: c.referenceActions ?? null, actionRatio: c.actionRatio ?? null, failure: c.failure })) } : null,
    controllerStepStats: mags.length ? { moves: mags.length, medianMaxAbsU: round(median(mags), 4), shareAtLeast0_09: round(mags.filter(m => m >= 0.09).length / mags.length),
      singleChannelMoves: moves.filter(u => (Math.abs(u[0]) < 1e-9) !== (Math.abs(u[1]) < 1e-9)).length, inputLimit: 0.1 } : null,
    trials: trialRows,
    generatedDriverSource: o.driverSource || null, generatedControllerSource: o.controllerSource || null
  };
}

async function main() {
  const rt = createRuntime(), g = rt.global;
  // The provider needs a real URL parser; the headless navigation worker needs
  // the runtime's blob-URL shim. Keep both instead of replacing the shim.
  const blobURLs = g.URL;
  class HostURL extends URL {}
  HostURL.createObjectURL = blob => blobURLs.createObjectURL(blob);
  HostURL.revokeObjectURL = key => blobURLs.revokeObjectURL(key);
  Object.assign(g, { fetch, AbortController, URL: HostURL, URLSearchParams, Headers, Response, TextEncoder, TextDecoder });
  let engine, provider, report = null, error = null, model = null;
  try {
    let strategy = 'adaptive';
    if (!offline) {
      await startBridge();
      const bridgeUrl = `http://127.0.0.1:${port}`;
      model = arg('--model', null);
      if (!model) {
        const listed = plain(await g.ClaudeAgentProvider.listModels(undefined, { bridgeUrl }));
        const ids = (Array.isArray(listed) ? listed : listed?.models || listed?.data || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
        model = ids.find(id => /opus/.test(id)) || ids[0];
        if (!model) throw new Error('No Claude model listed for this key.');
      }
      provider = new g.ClaudeAgentProvider({ bridgeUrl, model, maxCalls, timeoutMs: 45000, minIntervalMs, maxTransientRetries });
      strategy = 'claude';
    }
    console.log(`label=${label} device=${device} seed=${seed} manualTemplate=${manualTemplate} controllerMode=${controllerMode} trials=${trials} mode=${offline ? 'offline' : 'claude'} model=${model || '-'} maxCalls=${offline ? 0 : maxCalls}`);
    engine = new g.PickPlaceExperimentEngine({ seed, strategy, provider, recordFrames: false, trialCount: trials, device, manualTemplate, controllerMode, fixedGoalTarget, twoLinkMaxRatio });
    let state = await engine.initialize(), lastKind = '';
    for (let step = 0; !state.done && step < 6000; step++) {
      state = await engine.next();
      if (state.kind !== lastKind || /decision|trial|failure|reached/.test(state.kind)) {
        if (state.kind !== 'action-result' || step % 20 === 0)
          console.log(`[${step}] ${state.kind} ${state.decision?.tool || ''} calls=${state.modelCalls} actions=${state.actionCount} ${String(state.explanation || '').slice(0, 100).replace(/\s+/g, ' ')}`);
        lastKind = state.kind;
      }
    }
    report = plain(engine.report());
  } catch (e) { error = String(e.message || e).slice(0, 400); if (engine) report = plain(engine.report()); }
  finally { engine?.dispose(); provider?.dispose?.(); rt.close(); stopBridge(); }

  fs.mkdirSync(outDir, { recursive: true });
  const summary = summarize(report, { model, error });
  if (report && !flag('--no-full')) {
    const fullPath = path.join(outDir, `${label}.full.json.gz`);
    fs.writeFileSync(fullPath, zlib.gzipSync(JSON.stringify(report)));
    summary.fullReport = path.relative(root, fullPath).split(path.sep).join('/');
  }
  const summaryPath = path.join(outDir, `${label}.summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`completed=${summary.result.completedTrials}/${trials} truthPlaced=${summary.result.allTruthPlaced} actions=${summary.actionCount} modelCalls=${summary.modelCalls} failure=${summary.result.failure || '-'}${error ? ' runnerError=' + error : ''}`);
  console.log('RESULT ' + JSON.stringify({ ok: !error, summary: summaryPath, modelCalls: summary.modelCalls, completed: summary.result.completedTrials, error }));
  if (error) process.exitCode = 1;
}
main().catch(error => { stopBridge(); fail(String(error.message || error)); });
