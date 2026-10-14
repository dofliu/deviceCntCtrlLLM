'use strict';
// Offline replay of a generated XY controller (no model, no API, no cost).
//
// Runs the five-trial task with the offline rule policy for the high-level
// steps (lift, grip, goals) and the given control(state) source for every XY
// move, on any device and seed. Live runs showed that, for a fixed controller,
// device and seed, the action count is fully determined by the controller, so
// this reproduces live action counts and lets controllers be compared without
// spending calls. Also reports the controller's isolation test.
//
// Usage:
//   node tests/replay_controller.cjs --summary path/to/x.summary.json --device P2 --seeds 2026,3140,8675
//   node tests/replay_controller.cjs --source control.js --device G3 --seeds 2026 --compare-reference
// Options: --summary file (uses generatedControllerSource) | --source file | --reference
//   --device P2|G3 (default: the summary's device)  --seeds list (default: the summary's seed)
//   --trials 5|1  --compare-reference  --jobs n (default 4)  --json out.json
//   --legacy-target  re-measure the goal marker every step (behaviour before 2026-10-13 fix)
//   --gate C|D (D)   controller gate version (C: two-link case reach-only)
//   --ignore-gate    analysis only: let a controller that fails the isolation gate run anyway;
//                    the real verdict is kept in gatePassed (never use for reported results)
// Headless software canvas, as in the command-line runner; compare with headless baselines.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createRuntime, plain } = require('./headless-runtime.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const flag = name => argv.includes(name);
const DEVICES = { P2: 'VLAB-P2', G3: 'VLAB-G3', 'VLAB-P2': 'VLAB-P2', 'VLAB-G3': 'VLAB-G3' };

async function runOne({ device, seed, trials, source, legacyTarget, ignoreGate, gate }) {
  const rt = createRuntime(), g = rt.global;
  let gateActual = null;
  if (ignoreGate) {
    const real = g.VlabControllerModule.isolationTest;
    g.VlabControllerModule.isolationTest = async (...a) => { const r = await real(...a); gateActual = r.passed; r.passed = true; return r; };
  }
  // The offline policy submits VlabControllerModule.REFERENCE_SOURCE; swap in
  // the controller under test. The isolation reference counts stay those of
  // the built-in reference module.
  if (source) g.VlabControllerModule.REFERENCE_SOURCE = source;
  const engine = new g.PickPlaceExperimentEngine({ seed, strategy: 'adaptive', recordFrames: false, trialCount: trials, device, manualTemplate: false, controllerMode: 'generated', fixedGoalTarget: !legacyTarget, twoLinkMaxRatio: gate === 'C' ? null : undefined });
  try {
    let state = await engine.initialize();
    for (let i = 0; i < 6000 && !state.done; i++) state = await engine.next();
    const r = plain(engine.report()), ct = r.onboarding?.controllerTests;
    return { device, seed, completed: r.suiteProgress.totalCompleted, actions: r.actionCount, xyActions: r.xyActionCount,
      trialActions: r.trials.map(t => t.actionCount), placementErrorPx: r.trials.map(t => t.placementError == null ? null : Number(t.placementError.toFixed(2))),
      failure: r.failure, gatePassed: ignoreGate ? gateActual : ct?.passed ?? null, gateIgnored: Boolean(ignoreGate), gateRatio: ct?.efficiency?.ratio ?? null, nonlinearArm: ct?.efficiency?.nonlinearArm ?? null };
  } finally { engine.dispose(); rt.close(); }
}

if (flag('--child')) {
  process.on('message', async job => { try { process.send({ ok: true, row: await runOne(job) }); } catch (e) { process.send({ ok: false, error: String(e.message || e) }); } process.exit(0); });
} else {
  (async () => {
    let source = null, label = 'reference', summary = null;
    if (arg('--summary')) {
      summary = JSON.parse(fs.readFileSync(arg('--summary'), 'utf8'));
      source = summary.generatedControllerSource;
      if (!source) throw new Error('The summary has no generatedControllerSource.');
      label = path.basename(arg('--summary'));
    } else if (arg('--source')) { source = fs.readFileSync(arg('--source'), 'utf8'); label = path.basename(arg('--source')); }
    else if (!flag('--reference')) throw new Error('Give --summary, --source or --reference.');
    const device = DEVICES[String(arg('--device', summary?.condition?.device || 'P2')).toUpperCase()];
    if (!device) throw new Error('--device must be P2 or G3.');
    const seeds = String(arg('--seeds', summary?.condition?.seed ?? 2026)).split(',').map(Number);
    if (!seeds.length || seeds.some(s => !Number.isInteger(s) || s < 1)) throw new Error('--seeds must be positive integers.');
    const trials = Number(arg('--trials', 5));
    const jobs = [];
    for (const seed of seeds) {
      const legacyTarget = flag('--legacy-target'), ignoreGate = flag('--ignore-gate'), gate = String(arg('--gate', 'D')).toUpperCase();
      jobs.push({ kind: label, device, seed, trials, source, legacyTarget, ignoreGate, gate });
      if (flag('--compare-reference') && source) jobs.push({ kind: 'reference', device, seed, trials, source: null, legacyTarget, ignoreGate, gate });
    }
    const width = Math.max(1, Number(arg('--jobs', Math.min(4, os.cpus().length))));
    const rows = new Array(jobs.length); let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const i = next++, job = jobs[i];
        rows[i] = await new Promise(resolve => {
          const child = fork(__filename, ['--child'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
          child.on('message', m => resolve(m.ok ? { kind: job.kind, ...m.row } : { kind: job.kind, device: job.device, seed: job.seed, error: m.error }));
          child.on('exit', code => { if (code) resolve({ kind: job.kind, device: job.device, seed: job.seed, error: 'child exit ' + code }); });
          child.send(job);
        });
      }
    }));
    console.log('controller                         device   seed  done  actions  gateRatio  armRatio  trialActions');
    for (const r of rows) {
      const arm = r.nonlinearArm ? (r.nonlinearArm.reached ? r.nonlinearArm.ratio : 'not reached') : '-';
      console.log(`${String(r.kind).slice(0, 34).padEnd(34)} ${String(r.device).slice(5).padEnd(6)} ${String(r.seed).padStart(5)}  ${String(r.completed ?? '-').padStart(4)}  ${String(r.actions ?? r.error).padStart(7)}  ${String(r.gateRatio ?? '-').padStart(9)}  ${String(arm).padStart(8)}  ${(r.trialActions || []).join('/')}`);
    }
    const out = { kind: 'offline-controller-replay', gate: String(arg('--gate', 'D')).toUpperCase(), gateIgnored: flag('--ignore-gate'), goalTarget: flag('--legacy-target') ? 'legacy re-measured' : 'fixed at select_goal', runner: 'tests/replay_controller.cjs (headless-node, offline policy for high-level steps)', controller: label, device, trials, createdAt: new Date().toISOString(), rows };
    if (arg('--json')) { fs.writeFileSync(arg('--json'), JSON.stringify(out, null, 2) + '\n'); console.log('Wrote ' + arg('--json')); }
  })().catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
}
