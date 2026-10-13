'use strict';
// Offline five-trial baseline for one device/controller/seed (no template).
// Usage: node tests/baseline_v7_seed.cjs VLAB-G3 generated 2026. Prints one JSON row; no assertions, no model.
const path = require('node:path').join(__dirname, 'headless-runtime.cjs');
const { createRuntime, plain } = require(path);
(async () => {
  const [device, controllerMode, seed] = [process.argv[2], process.argv[3], Number(process.argv[4])];
  const rt = createRuntime(), g = rt.global, started = Date.now();
  const engine = new g.PickPlaceExperimentEngine({ seed, strategy: 'adaptive', recordFrames: false, trialCount: 5, device, manualTemplate: false, controllerMode });
  let state = await engine.initialize();
  for (let step = 0; !state.done && step < 3000; step++) state = await engine.next();
  const r = plain(engine.report());
  const passed = r.done && !r.failure && r.suiteProgress.totalCompleted === 5 && r.trials.every(t => t.success && t.evidence?.grasp && t.evidence?.coMotion && t.evidence?.release && t.evidence?.surface);
  console.log(JSON.stringify({ device, protocol: r.experiment.protocol, manualTemplate: false, controllerMode, seed, passed, failure: r.failure, completed: r.suiteProgress.totalCompleted,
    driverSource: r.provenance.driverSource, controllerSource: r.provenance.controllerSource, controllerTestsPassed: r.provenance.controllerTests?.passed ?? null,
    trialActions: r.trials.map(t => t.actionCount), xyActions: r.trials.map(t => t.xyActionCount), totalActions: r.actionCount,
    placementErrorPx: r.trials.map(t => Number((t.placementError ?? NaN).toFixed(2))), modelCalls: r.modelCalls, seconds: (Date.now() - started) / 1000 }));
  engine.dispose(); rt.close(); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
