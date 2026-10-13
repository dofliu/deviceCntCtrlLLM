'use strict';
// V7.0 runtime-environment stop: when the isolated sandbox/worker cannot start
// (DRIVER_STARTUP_TIMEOUT / DRIVER_ISOLATION_TIMEOUT), the generated source never
// reaches the sandbox, so onboarding stops after 3 consecutive failures and
// classifies the run as a local runtime environment failure instead of spending
// further decisions. Also checks the exported browser environment block.
// Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

function timeoutError(code = 'DRIVER_STARTUP_TIMEOUT') {
  const error = new Error(code + ': Waiting for the isolated worker to become ready timed out; generated source was not sent.');
  error.code = code;
  error.diagnostic = { operation: 'compile', phase: 'startup', requestId: 1, attempt: 1, elapsedMs: 5001, deadlineMs: 5000, retryable: false, retryCount: 0 };
  return error;
}

async function runUntilDone(engine, limit = 1500) {
  let state = await engine.initialize();
  for (let i = 0; i < limit && !state.done; i++) state = await engine.next();
  return state;
}

async function run() {
  const checks = [], rt = createRuntime(), g = rt.global;
  const listeners = new Set();
  Object.assign(g.document, { visibilityState: 'visible', hasFocus: () => true,
    addEventListener(name, fn) { if (name === 'visibilitychange') listeners.add(fn); },
    removeEventListener(name, fn) { if (name === 'visibilitychange') listeners.delete(fn); } });
  try {
    // 1. Persistent startup timeout: stop after exactly 3 write_driver failures.
    for (const code of ['DRIVER_STARTUP_TIMEOUT', 'DRIVER_ISOLATION_TIMEOUT']) {
      const engine = new g.PickPlaceExperimentEngine({ seed: 42, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-G3', manualTemplate: false, controllerMode: 'generated' });
      await engine.initialize();
      let compiles = 0;
      engine._runtime.compile = async () => { compiles++; throw timeoutError(code); };
      g.document.visibilityState = 'hidden'; for (const fn of listeners) fn();
      const state = await runUntilDone(engine);
      const report = plain(engine.report());
      assert.equal(state.done, true);
      assert.equal(report.failureCategory, 'runtime-environment');
      assert.match(report.failure, /執行環境/);
      assert.match(report.failure, new RegExp(code));
      assert.equal(compiles, 3);
      const writes = report.onboarding.steps.filter(s => s.tool === 'write_driver');
      assert.deepEqual(writes.map(s => s.ok), [false, false, false]);
      assert.equal(report.actionCount, 0);
      assert.equal(report.commandAttemptCount, 0);
      const last = report.trace.filter(e => e.toolResult && !e.toolResult.ok).at(-1);
      assert.equal(last.toolResult.data.driverErrorCode, code);
      assert.deepEqual(last.toolResult.data.environmentAtFailure, { visibilityState: 'hidden', hasFocus: true });
      assert.equal(report.environment.visibilityState, 'hidden');
      assert.equal(report.environment.visibilityChanges.at(-1).state, 'hidden');
      assert.ok('userAgent' in report.environment && 'pageProtocol' in report.environment);
      engine.dispose();
      assert.equal(listeners.size, 0, 'dispose removes the visibility listener');
      g.document.visibilityState = 'visible';
    }
    checks.push('3 consecutive startup/isolation timeouts stop onboarding as runtime-environment, 0 actions, environment recorded');

    // 2. Transient: two timeouts, then a real compile resets the counter and the run completes.
    {
      const engine = new g.PickPlaceExperimentEngine({ seed: 42, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-G3', manualTemplate: false, controllerMode: 'generated' });
      await engine.initialize();
      const real = engine._runtime.compile.bind(engine._runtime); let compiles = 0;
      engine._runtime.compile = async source => { compiles++; if (compiles <= 2) throw timeoutError(); return real(source); };
      const state = await runUntilDone(engine);
      const report = plain(engine.report());
      assert.equal(state.failure, null, String(state.failure));
      assert.equal(report.failureCategory, null);
      assert.equal(report.suiteProgress.totalCompleted, 1);
      assert.equal(engine._runtimeEnvironmentFailures, 0);
      engine.dispose();
    }
    checks.push('2 transient timeouts followed by a successful compile reset the counter; trial completes 1/1');

    // 3. Program errors are the model's to fix and do not count as environment failures.
    {
      const engine = new g.PickPlaceExperimentEngine({ seed: 42, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-P2', manualTemplate: false, controllerMode: 'builtin', maxFrontDecisions: 10 });
      await engine.initialize();
      engine._runtime.compile = async () => { const e = new Error('DRIVER_PROGRAM_ERROR: Source must define encode(command) and decode(rawReply).'); e.code = 'DRIVER_PROGRAM_ERROR'; throw e; };
      const state = await runUntilDone(engine);
      const report = plain(engine.report());
      assert.equal(state.done, true);
      assert.equal(report.failureCategory, null);
      assert.ok(report.onboarding.steps.filter(s => s.tool === 'write_driver' && !s.ok).length > 3);
      assert.match(report.failure, /決策次數上限/);
      engine.dispose();
    }
    checks.push('DRIVER_PROGRAM_ERROR keeps the existing front-decision limit and is not classified as environment');
  } finally { rt.close?.(); }
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v70-runtime-environment.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
