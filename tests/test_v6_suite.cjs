'use strict';
// Full production integration prepared for local verification. See the V6
// validation record: execution was blocked by automatic telemetry review in
// the authoring environment; do not label this script as having passed there.
const assert = require('node:assert/strict');
const { createRuntime, plain } = require('./headless-runtime.cjs');

async function runSeed(seed) {
  const runtime = createRuntime(), engine = new runtime.global.PickPlaceExperimentEngine({ seed, strategy: 'adaptive', recordFrames: false, trialCount: 5 });
  try {
    let state = await engine.initialize(), navigation = null;
    const plant = engine._plant, link = engine._link, driver = engine._runtime;
    const first = plain(plant.diagnostics());
    assert.ok(first.tip[0] < first.geometry.camera.x && first.tip[1] > first.geometry.camera.y, 'Initial tip is at reachable lower-left pose.');
    assert.ok(first.scenario.initialDistancePx > 150); assert.ok(first.scenario.transferDistancePx > 180);
    let transitionSnapshot = null;
    for (let steps = 0; !state.done && steps < 2200; steps++) {
      state = await engine.next();
      assert.equal(engine._plant, plant); assert.equal(engine._link, link); assert.equal(engine._runtime, driver);
      if (engine._control?._navigation) {
        navigation ||= engine._control._navigation;
        assert.equal(engine._control._navigation, navigation, 'Same navigation worker must survive all trials.');
      }
      if (state.kind === 'trial-complete') {
        assert.equal(state.done, false); assert.equal(state.taskProgress.completed, true);
        transitionSnapshot = plain(plant.diagnostics());
      }
      if (state.kind === 'trial-connection-confirmed') {
        assert.deepEqual(plain(plant.diagnostics()), transitionSnapshot, 'Handshake must not move or replace the scene.');
        assert.equal(state.suiteProgress.connectionVerified, true);
      }
      if (state.kind === 'trial-ready') {
        const now = plain(plant.diagnostics());
        assert.deepEqual(now.geometry.jointAngles, transitionSnapshot.geometry.jointAngles, 'New objects do not teleport the arm.');
        for (const key of ['lengths', 'channelToJoint', 'channelGains', 'camera']) assert.deepEqual(now.geometry[key], first.geometry[key]);
        assert.equal(state.taskProgress.completed, false);
        for (const key of ['_graspEvidence', '_coMotionEvidence', '_releaseEvidence', '_releaseHeightEvidence']) assert.equal(engine._control[key], null, 'No success evidence may leak into the next trial.');
      }
      if (steps % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const report = plain(engine.report());
    assert.equal(report.failure, null); assert.equal(report.done, true); assert.equal(state.kind, 'suite-complete');
    assert.equal(report.trials.length, 5); assert.equal(report.suiteProgress.totalCompleted, 5);
    assert.deepEqual(report.trials.map(item => item.destinationHeight), [0, .35, .65, .35, 0]);
    assert.ok(report.trials.every(item => item.success && item.evidence.grasp && item.evidence.coMotion && item.evidence.release && item.evidence.surface));
    assert.equal(new Set(report.trials.map(item => item.driverSourceHash)).size, 1);
    for (const key of ['actionCount', 'probeCount', 'recalibrations', 'commandAttemptCount', 'unconfirmedActuationCount', 'modelCalls'])
      assert.equal(report.trials.reduce((sum, item) => sum + (item[key] || 0), 0), report[key], 'Per-trial totals must match report: ' + key);
    assert.equal(report.trials.reduce((sum, item) => sum + item.decisionCount, 0) + engine._frontDecisions, report.decisionCount);
    const hello = report.onboarding.traffic.filter(item => item.direction === 'TX' && !item.dryRun && JSON.parse(item.wire).op === 'hello');
    assert.equal(hello.length, 5, 'Each reused trial confirms the retained real connection.');
    const completionChecks = report.trace.filter(item => item.decision?.tool === 'verify_place' && item.toolResult?.data?.checks);
    assert.equal(completionChecks.length, 5);
    assert.ok(completionChecks.every(item => Object.values(item.toolResult.data.checks).every(Boolean)));
    const before = plain(plant.diagnostics()), trafficCount = link.traffic().length, actions = state.actionCount;
    await engine.next(); await engine.next();
    assert.deepEqual(plain(plant.diagnostics()), before); assert.equal(link.traffic().length, trafficCount); assert.equal(engine.snapshot().actionCount, actions);
    return { seed, passed: true, actions, placementErrors: report.trials.map(item => item.placementError), trialActions: report.trials.map(item => item.actionCount), modelCalls: report.modelCalls, handshakes: hello.length };
  } finally { engine.dispose(); runtime.close(); }
}

async function run() {
  const rows = [];
  for (const seed of [42, 1]) rows.push(await runSeed(seed));
  return { passed: true, rows, scope: 'Real production plant, pixel raster, generated driver and controller; software transport is not browser/CSP/API verification.' };
}
module.exports = { run, runSeed };
if (require.main === module) run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
