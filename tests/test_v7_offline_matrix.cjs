'use strict';
// V7 offline five-trial matrix: device (P2 2R/JSON, G3 gantry/binary) x manual
// template (included/omitted) x XY controller (built-in tool loop / tested
// controller module). Offline policy only: the driver is the manual template
// or the rule-based spec synthesizer, and the controller module is the offline
// REFERENCE module. This measures the pipeline, not model-generated code.
// Usage: node tests/test_v7_offline_matrix.cjs [--seeds 42,7] [--jobs 4]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

async function runOne({ device, manualTemplate, controllerMode, seed }) {
  const rt = createRuntime(), g = rt.global, started = Date.now();
  const engine = new g.PickPlaceExperimentEngine({ seed, strategy: 'adaptive', recordFrames: false, trialCount: 5, device, manualTemplate, controllerMode });
  try {
    let state = await engine.initialize();
    for (let step = 0; !state.done && step < 3000; step++) { state = await engine.next(); if (step % 100 === 0) await new Promise(r => setImmediate(r)); }
    const r = plain(engine.report());
    const ok = r.done && !r.failure && r.suiteProgress.totalCompleted === 5 && r.trials.every(t => t.success && t.evidence?.grasp && t.evidence?.coMotion && t.evidence?.release && t.evidence?.surface);
    return { device, protocol: r.experiment.protocol, manualTemplate, controllerMode, seed, passed: ok, failure: r.failure, completed: r.suiteProgress.totalCompleted,
      driverSource: r.provenance.driverSource, controllerSource: r.provenance.controllerSource, controllerTestsPassed: r.provenance.controllerTests?.passed ?? null,
      trialActions: r.trials.map(t => t.actionCount), xyActions: r.trials.map(t => t.xyActionCount), totalActions: r.actionCount,
      placementErrorPx: r.trials.map(t => Number((t.placementError ?? NaN).toFixed(2))), modelCalls: r.modelCalls, seconds: (Date.now() - started) / 1000 };
  } finally { engine.dispose(); rt.close(); }
}

function configs(seeds) {
  const out = [];
  for (const device of ['VLAB-P2', 'VLAB-G3']) for (const manualTemplate of [true, false]) for (const controllerMode of ['builtin', 'generated'])
    for (const seed of seeds[device]) out.push({ device, manualTemplate, controllerMode, seed });
  return out;
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const p2 = (arg('--seeds') || '42').split(',').map(Number), g3 = (arg('--g3-seeds') || '42,7').split(',').map(Number);
  const jobs = Math.max(1, Number(arg('--jobs')) || Math.min(4, os.cpus().length));
  const list = configs({ 'VLAB-P2': p2, 'VLAB-G3': g3 }), rows = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < list.length) {
      const index = next++;
      rows[index] = await new Promise((resolve, reject) => {
        const child = fork(__filename, ['--child', JSON.stringify(list[index])], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
        child.on('message', resolve); child.on('error', reject);
        child.on('exit', code => { if (code) reject(new Error('matrix child failed: ' + JSON.stringify(list[index]))); });
      });
    }
  }));
  for (const row of rows) assert.equal(row.passed, true, 'Five-trial run failed: ' + JSON.stringify(row));
  // Paired comparison: same device/template/seed, built-in vs controller module.
  const comparison = [];
  for (const row of rows.filter(r => r.controllerMode === 'builtin')) {
    const pair = rows.find(r => r.controllerMode === 'generated' && r.device === row.device && r.manualTemplate === row.manualTemplate && r.seed === row.seed);
    comparison.push({ device: row.device, manualTemplate: row.manualTemplate, seed: row.seed, builtinTotalActions: row.totalActions, moduleTotalActions: pair.totalActions,
      builtinXY: row.xyActions.reduce((a, b) => a + b, 0), moduleXY: pair.xyActions.reduce((a, b) => a + b, 0), bothCompleted: row.passed && pair.passed });
  }
  const same = rows.filter(r => r.controllerMode === 'builtin' && r.manualTemplate).every(t => {
    const s = rows.find(r => r.controllerMode === 'builtin' && !r.manualTemplate && r.device === t.device && r.seed === t.seed);
    return JSON.stringify(s.trialActions) === JSON.stringify(t.trialActions);
  });
  assert.equal(same, true, 'Template and spec-synthesized drivers must yield identical built-in runs.');
  const result = { version: '0.7.0', passed: true, pureNode: true, browserUsed: false, networkCalls: 0, modelCalls: 0,
    scope: 'Offline headless five-trial matrix. Driver = manual template or rule-based spec synthesizer; controller module = offline reference module. Not model-generated code, browser, CSP or hardware evidence. Seeds are development data.',
    rows, comparison, templateVsSynthesizedIdentical: same };
  fs.writeFileSync(path.join(root, 'validation', 'v7-offline-matrix.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, comparison, templateVsSynthesizedIdentical: same }));
}

if (process.argv[2] === '--child') runOne(JSON.parse(process.argv[3])).then(row => { process.send(row); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runOne };
