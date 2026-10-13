'use strict';
// V7.0 goal-target and target-bias checks. A live G3/8675 run failed because
// the B-zone centre was re-measured every step while the carried object
// occluded it, and the generated controller took undamped steps. Checks:
// (1) the agent holds a fixed goal pixel when given one; (2) the isolation
// gate's target-bias case rejects that live controller and accepts it with
// damping; (3) offline replay of that controller fails with the legacy
// re-measured target and succeeds with the fixed goal target.
// Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

async function isolation(g, source, channelKind) {
  const runtime = new g.DriverRuntime({ kind: 'controller' });
  try { await runtime.compile(source); return plain(await g.VlabControllerModule.isolationTest(s => runtime.control(s), { channelKind })); }
  finally { runtime.dispose(); }
}
async function replay(g, source, fixedGoalTarget) {
  g.VlabControllerModule.REFERENCE_SOURCE = source;
  // This controller now fails the target-bias gate; analysis only, let it run.
  const real = g.VlabControllerModule.isolationTest;
  g.VlabControllerModule.isolationTest = async (...a) => { const r = await real(...a); r.passed = true; return r; };
  const e = new g.PickPlaceExperimentEngine({ seed: 8675, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-G3', manualTemplate: false, controllerMode: 'generated', fixedGoalTarget });
  try { let s = await e.initialize(); for (let i = 0; i < 3000 && !s.done; i++) s = await e.next(); const r = plain(e.report()); return { completed: r.suiteProgress.totalCompleted, actions: r.actionCount, goalTarget: r.suiteParameters.goalTarget }; }
  finally { e.dispose(); g.VlabControllerModule.isolationTest = real; }
}

async function run() {
  const checks = [];
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'validation', 'live-cli-batch-2026-10-13.json'), 'utf8'));
  const failing = batch.runs.find(r => r.device === 'VLAB-G3' && r.seed === 8675 && r.generatedControllerSource).generatedControllerSource;
  const damped = failing.replace('var m = Math.max(Math.abs(u0), Math.abs(u1));', 'u0 *= 0.6; u1 *= 0.6; var m = Math.max(Math.abs(u0), Math.abs(u1));');
  assert.notEqual(damped, failing);

  {
    const rt = createRuntime(), g = rt.global, core = new g.AgentCore();
    const plant = new g.VirtualPlant({ seed: 7, width: 640, height: 480, kinematics: 'gantry' }), f = plant.frame();
    const free = plain(core.observe({ width: f.width, height: f.height, pixels: f.pixels }));
    core.goal();
    const first = plain(core.observe({ width: f.width, height: f.height, pixels: f.pixels, holdTarget: true, requestedTarget: [100, 120] }));
    assert.deepEqual(first.target, free.target, 'held target is the camera measurement in the goal frame');
    assert.equal(first.targetSource, 'held-goal');
    const blank = { width: f.width, height: f.height, pixels: new Uint8ClampedArray(f.pixels.length) };
    const later = plain(core.observe(blank));
    assert.deepEqual(later.target, free.target, 'held until the next goal even when the marker is not visible');
    core.goal();
    assert.equal(plain(core.observe(blank)).target, null, 'a new goal without holdTarget measures every step again');
    rt.close();
  }
  checks.push('agent measures the goal marker once in the goal frame, holds it until the next goal, then re-measures');

  {
    const rt = createRuntime(), g = rt.global;
    const bad = await isolation(g, failing, 'linear'), good = await isolation(g, damped, 'linear'), ref = await isolation(g, g.VlabControllerModule.REFERENCE_SOURCE, 'linear');
    const name = c => c.name.startsWith('接近目標時');
    assert.equal(bad.passed, false); assert.equal(bad.cases.find(name).passed, false);
    assert.equal(good.passed, true); assert.equal(ref.passed, true);
    rt.close();
  }
  checks.push('target-bias gate case rejects the live undamped G3/8675 controller and accepts it with a 0.6 step gain; reference passes');

  {
    const rt = createRuntime(), g = rt.global;
    const legacy = await replay(g, failing, false), fixed = await replay(g, failing, true);
    assert.equal(legacy.completed, 0, 'legacy re-measured target reproduces the live failure');
    assert.equal(fixed.completed, 1, 'fixed goal target removes the chase');
    assert.match(fixed.goalTarget, /fixed/); assert.match(legacy.goalTarget, /legacy/);
    rt.close();
    checks.push(`offline replay of the live controller with the gate bypassed for analysis, G3 seed 8675 trial 1: legacy target ${legacy.actions} actions not completed; fixed goal target ${fixed.actions} actions completed`);
  }
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v70-goal-target.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
