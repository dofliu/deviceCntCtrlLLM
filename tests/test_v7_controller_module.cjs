'use strict';
// V7 focused checks for generated XY controller modules: sandboxed compile and
// execution, the synthetic isolation gate, rejection of unsafe or naive
// controllers, the onboarding start gate, and runtime failure without actuation.
// Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

const BAD = {
  outOfRange: 'function control(state) { return {action: "move", u: [0.5, 0]}; }',
  throws: 'function control(state) { throw new Error("boom"); }',
  alwaysVerify: 'function control(state) { return {action: "verify"}; }',
  notANumber: 'function control(state) { return {action: "move", u: [NaN, 0]}; }',
  // Assumes channel A moves +x and channel B moves +y with a fixed gain.
  naiveIdentity: `function control(state) {
    const e = [state.target[0] - state.tip[0], state.target[1] - state.tip[1]];
    if (Math.hypot(e[0], e[1]) <= state.tolerancePx - 1) return {action: 'verify'};
    const u = e.map(v => Math.max(-0.1, Math.min(0.1, v / 300)));
    return {action: 'move', u};
  }`
};

async function isolation(g, source) {
  const runtime = new g.DriverRuntime({ kind: 'controller' });
  try {
    await runtime.compile(source);
    return plain(await g.VlabControllerModule.isolationTest(state => runtime.control(state)));
  } finally { runtime.dispose(); }
}

async function run() {
  const checks = [], rt = createRuntime(), g = rt.global, M = g.VlabControllerModule;
  try {
    // Sandbox contract.
    {
      const runtime = new g.DriverRuntime({ kind: 'controller' });
      await assert.rejects(runtime.compile('function encode(c){} function decode(r){}'), /control\(state\)/);
      const compiled = plain(await runtime.compile(M.REFERENCE_SOURCE));
      assert.deepEqual(compiled.functions, ['control']);
      await assert.rejects(runtime.test({ ready: true, protocol: 'vlab-p2-json/1' }), /./, 'Controller runtime has no device link tests.');
      runtime.dispose();
      const driver = new g.DriverRuntime();
      await assert.rejects(driver.control({}), /controller runtime/);
      driver.dispose();
    }
    checks.push('controller modules compile in the same opaque sandbox and must define control(state); driver runtimes cannot run control()');

    const reference = await isolation(g, M.REFERENCE_SOURCE);
    assert.equal(reference.passed, true, JSON.stringify(reference.cases.filter(c => !c.passed)));
    assert.equal(reference.cases.length, 6);
    assert.ok(reference.cases.every(c => c.reached.every(r => r.errorPx <= 7)));
    checks.push('offline reference module reaches every synthetic case (rotation, swap, reversal, nonlinearity, travel limit, mid-run reversal)');

    const rejected = {};
    for (const [name, source] of Object.entries(BAD)) {
      const result = await isolation(g, source);
      assert.equal(result.passed, false, name + ' must fail the isolation gate.');
      rejected[name] = result.cases.filter(c => !c.passed).length;
    }
    assert.ok(rejected.naiveIdentity >= 2, 'A controller that assumes a fixed mapping fails the swapped/rotated cases.');
    checks.push('isolation gate rejects out-of-range, throwing, NaN, always-verify and fixed-mapping controllers');

    // Onboarding gate: a failing controller keeps start_control closed and
    // sends no device command; a passing one opens it.
    {
      const engine = new g.PickPlaceExperimentEngine({ seed: 42, strategy: 'adaptive', recordFrames: false, trialCount: 1, controllerMode: 'generated', manualTemplate: false });
      let state = await engine.initialize();
      for (let i = 0; i < 40 && !(engine._proposal && engine._proposal.tool === 'write_controller'); i++) state = await engine.next();
      assert.equal(engine._proposal.tool, 'write_controller');
      assert.ok(!engine._allowed().includes('start_control'), 'start_control closed before controller tests.');
      engine._proposal = { ...engine._proposal, args: { source: BAD.naiveIdentity } };
      state = await engine.next();
      state = await engine.next(); // offline policy proposes test_controller
      assert.equal(engine._proposal.tool, 'test_controller');
      state = await engine.next();
      assert.equal(state.toolResult.ok, false);
      assert.ok(!engine._allowed().includes('start_control'), 'Failing controller keeps the gate closed.');
      const actuations = plain(engine._link.traffic()).filter(item => item.direction === 'TX' && !item.dryRun && !/hello/.test(item.wire));
      assert.equal(actuations.length, 0, 'No actuation before control is enabled.');
      for (let i = 0; i < 6 && !engine._onboarding.ready; i++) state = await engine.next();
      assert.equal(engine._onboarding.ready, true, 'Offline policy rewrites the reference module, passes, and starts control.');
      const report = plain(engine.report());
      assert.equal(report.provenance.controllerSource, 'offline-reference-module');
      assert.equal(report.provenance.driverSource, 'offline-spec-synthesizer');
      assert.equal(report.experiment.controllerMode, 'generated');
      engine.dispose();
    }
    checks.push('onboarding: a failing controller keeps start_control closed with no actuation; provenance labels offline reference and synthesized code');

    // Runtime contract violation after tests: stop without actuation.
    {
      let calls = 0;
      const engine = new g.AutonomousEngine({ seed: 42, strategy: 'adaptive', recordFrames: false, challenge: false,
        controller: { origin: 'test', decide: async () => (++calls === 1 ? { action: 'move', u: [0.02, 0] } : { action: 'move', u: [0.3, 0] }) } });
      await engine.initialize();
      let state = await engine.next();
      assert.equal(state.kind, 'action-result'); assert.equal(state.actionCount, 1);
      state = await engine.next();
      assert.equal(state.done, true); assert.match(state.failure, /沒有送出動作/); assert.equal(state.actionCount, 1);
      engine.dispose();
    }
    checks.push('a controller output that violates the contract at run time stops the episode without sending that action');
  } finally { rt.close(); }
  return { version: '0.7.0', passed: true, pureNode: true, browserUsed: false, networkCalls: 0, scope: 'Controller sandbox, synthetic isolation gate, onboarding gate and runtime contract. Not a model-written controller or complete pick/place run.', checks };
}
module.exports = { run };
if (require.main === module) run().then(result => {
  fs.writeFileSync(path.join(root, 'validation', 'v7-controller-module.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}).catch(error => { console.error(error); process.exitCode = 1; });
