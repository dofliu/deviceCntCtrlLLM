'use strict';
// V7.0 controller efficiency report: the isolation test adds per-case and total
// action ratios against the hand-written reference module. The ratio is
// informational only; pass/fail still depends solely on reaching every target.
// Also checks the contract guidance and that the model context keeps the ratio.
// Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

async function isolation(g, source) {
  const runtime = new g.DriverRuntime({ kind: 'controller' });
  try { await runtime.compile(source); return plain(await g.VlabControllerModule.isolationTest(state => runtime.control(state))); }
  finally { runtime.dispose(); }
}

async function run() {
  const checks = [], rt = createRuntime(), g = rt.global, M = g.VlabControllerModule;
  try {
    const reference = await isolation(g, M.REFERENCE_SOURCE);
    assert.equal(reference.passed, true);
    assert.equal(reference.efficiency.ratio, 1);
    for (const c of reference.cases) { assert.equal(c.actionRatio, 1); assert.equal(c.referenceActions, c.actions); }
    checks.push(`reference module: ratio 1.00 on all ${reference.cases.length} cases (${reference.efficiency.actions} actions)`);

    // Same algorithm with a self-imposed 0.05 step cap, as seen in live runs.
    const halfStep = M.REFERENCE_SOURCE.replace('Math.min(1, lim / Math.max', 'Math.min(1, (lim / 2) / Math.max');
    assert.notEqual(halfStep, M.REFERENCE_SOURCE);
    const slow = await isolation(g, halfStep);
    assert.equal(slow.passed, true, 'a slower controller still passes; efficiency is not a gate');
    assert.ok(slow.efficiency.ratio >= 1.3, 'half-step cap should cost noticeably more actions: ' + slow.efficiency.ratio);
    checks.push(`half-step (0.05) controller passes with ratio ${slow.efficiency.ratio}; efficiency does not change the pass decision`);

    const failing = await isolation(g, 'function control(state) { return {action: "move", u: [0.01, 0]}; }');
    assert.equal(failing.passed, false);
    assert.ok(failing.cases.every(c => c.passed || c.actionRatio === null));
    assert.equal(failing.efficiency.ratio, failing.efficiency.referenceActions ? failing.efficiency.ratio : null);
    checks.push('failed cases carry no ratio and are excluded from the total');

    // A real live P2 controller (seed 3140, 8192 batch) fits one linear map over
    // its whole history. It passed the gate live yet needed 1.94x the actions of
    // the offline baseline; the report-only two-link case flags it.
    const longWindow = JSON.parse(fs.readFileSync(path.join(root, 'validation', 'live-claude-v7-ui-p2-seed3140-8192-2026-10-13.json'), 'utf8')).generatedControllerSource;
    const long = await isolation(g, longWindow);
    assert.equal(long.passed, true, 'report-only case must not change the pass decision: ' + JSON.stringify(long.cases.filter(c => c.gate && !c.passed)));
    const arm = long.efficiency.nonlinearArm;
    assert.ok(arm && (!arm.reached || arm.ratio >= 1.3), 'long-window fit should be flagged on the two-link case: ' + JSON.stringify(arm));
    assert.equal(arm.required, false);
    const asRotary = await (async () => { const rt2 = new g.DriverRuntime({ kind: 'controller' }); try { await rt2.compile(longWindow); return plain(await g.VlabControllerModule.isolationTest(s => rt2.control(s), { channelKind: 'rotary' })); } finally { rt2.dispose(); } })();
    assert.equal(asRotary.passed, false, 'with a rotary manual the two-link case is required and rejects this controller');
    assert.equal(asRotary.efficiency.nonlinearArm.required, true);
    assert.equal(reference.efficiency.nonlinearArm.ratio, 1);
    checks.push(`live P2 controller with a whole-history linear fit passes without a rotary manual (two-link case reported: ${arm.reached ? arm.ratio + 'x' : 'not reached'}) and is rejected when the manual declares rotary channels`);

    assert.match(M.CONTRACT, /可以使用到上限/);
    assert.match(M.CONTRACT, /不影響是否通過/);
    const safe = plain(g.VlabAgentContract.allowContext({ phase: 'onboarding', allowedTools: ['test_controller'], controllerMode: 'generated', controllerContract: M.CONTRACT, controllerSource: 'function control(s){}', controllerTests: slow }));
    assert.equal(safe.controllerTests.efficiency.ratio, slow.efficiency.ratio);
    assert.equal(safe.controllerTests.cases[0].actionRatio, slow.cases[0].actionRatio);
    assert.deepEqual(Object.keys(safe.controllerTests.efficiency.nonlinearArm).sort(), ['actions', 'failure', 'ratio', 'reached', 'referenceActions', 'required']);
    assert.equal(safe.controllerTests.cases.at(-1).gate, false);
    assert.equal(Object.hasOwn(safe.controllerTests.efficiency, 'note'), false);
    checks.push('contract states the 0.1 step guidance; model context keeps per-case and total ratios');
  } finally { rt.close?.(); }
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v70-controller-efficiency.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
