'use strict';
// V7.0 E-version controller gate: on rotary manuals the elbow-limit two-link
// case is also required. validation/v70-gate-e.json records, for every live
// P2 controller collected so far, whether it completes the full five-trial
// task on seeds 2026/3140/8675 in offline replay (ground truth, slow to
// recompute). This test recomputes the gate decisions from the recorded live
// sources and checks: among controllers the D gate accepts, E rejects exactly
// those that fail the full task; all G3 controllers and the reference module
// still pass. Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

async function run() {
  const rt = createRuntime(), g = rt.global, M = g.VlabControllerModule;
  const record = JSON.parse(fs.readFileSync(path.join(root, 'validation', 'v70-gate-e.json'), 'utf8'));
  const truth = Object.fromEntries(record.rows.map(r => [r.sha1, r.completesAllSeeds]));
  const sources = new Map();
  for (const file of ['live-cli-batch-C-2026-10-14.json', 'live-cli-batch-C-repeats-2026-10-14.json', 'live-cli-batch-C-repeats2-2026-10-14.json', 'live-cli-batch-D-2026-10-14.json', 'live-cli-batch-D2-2026-10-14.json'])
    for (const r of JSON.parse(fs.readFileSync(path.join(root, 'validation', file), 'utf8')).runs)
      if (r.generatedControllerSource) sources.set(crypto.createHash('sha1').update(r.generatedControllerSource).digest('hex').slice(0, 8), { device: r.device, source: r.generatedControllerSource });
  const decide = async (source, options) => {
    const runtime = new g.DriverRuntime({ kind: 'controller' });
    try { await runtime.compile(source); return plain(await M.isolationTest(s => runtime.control(s), options)); } finally { runtime.dispose(); }
  };
  let p2 = 0, g3 = 0;
  for (const [sha, item] of sources) {
    if (item.device === 'VLAB-G3') {
      const e = await decide(item.source, { channelKind: 'linear' });
      assert.equal(e.passed, true, 'G3 controller ' + sha); g3++; continue;
    }
    assert.ok(sha in truth, 'P2 controller missing from the ground-truth record: ' + sha);
    const d = await decide(item.source, { channelKind: 'rotary', elbowLimitCase: false }), e = await decide(item.source, { channelKind: 'rotary' });
    if (d.passed) assert.equal(e.passed, truth[sha], `E must reject exactly the D-accepted controllers that fail the full task (${sha})`);
    else assert.equal(e.passed, false);
    if (!e.passed && d.passed) assert.match(e.cases.find(c => c.name.includes('肘關節')).failure || '', /目標|呼叫/);
    p2++;
  }
  assert.equal(p2, record.rows.length);
  for (const kind of ['rotary', 'linear']) assert.equal((await decide(M.REFERENCE_SOURCE, { channelKind: kind })).passed, true, 'reference ' + kind);
  rt.close();
  const checks = [
    `among ${record.summary.gateD_passed.length} D-accepted P2 controllers, the E gate rejects exactly the ${record.summary.failInFullTaskOnSomeSeed.length} that fail the five-trial task on some seed (offline replay ground truth) and accepts the rest`,
    `all ${g3} G3 controllers pass (elbow-limit case report-only on linear manuals); reference module passes under rotary and linear`,
  ];
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
