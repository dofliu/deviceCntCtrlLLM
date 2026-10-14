'use strict';
// V7.0 D-version controller gate. On rotary manuals (VLAB-P2) the two-link
// case must reach every target within 1.3x the reference module's actions;
// linear manuals (VLAB-G3) only report it. Checked against the C-version live
// controllers: three P2 controllers that ran at 1.61-1.73x the offline
// baseline must be rejected, the other P2 and all G3 controllers accepted,
// and the C gate (twoLinkMaxRatio null) must still accept all of them.
// Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

async function run() {
  const rt = createRuntime(), g = rt.global, M = g.VlabControllerModule;
  const runs = [];
  for (const file of ['live-cli-batch-C-2026-10-14.json', 'live-cli-batch-C-repeats-2026-10-14.json', 'live-cli-batch-C-repeats2-2026-10-14.json'])
    for (const r of JSON.parse(fs.readFileSync(path.join(root, 'validation', file), 'utf8')).runs)
      if (r.generatedControllerSource) runs.push({ file, label: r.label, device: r.device, seed: r.seed, source: r.generatedControllerSource });
  assert.equal(runs.length, 18);
  const rows = [];
  for (const r of runs) {
    const runtime = new g.DriverRuntime({ kind: 'controller' });
    try {
      await runtime.compile(r.source);
      const kind = r.device === 'VLAB-P2' ? 'rotary' : 'linear';
      const d = plain(await M.isolationTest(s => runtime.control(s), { channelKind: kind }));
      const c = plain(await M.isolationTest(s => runtime.control(s), { channelKind: kind, twoLinkMaxRatio: null }));
      rows.push({ controller: `${r.file}:${r.label}`, device: r.device, seed: r.seed, twoLinkRatio: d.efficiency.nonlinearArm.ratio, gateC: c.passed, gateD: d.passed, failure: d.cases.filter(x => x.gate && !x.passed).map(x => x.failure)[0] || null });
      assert.equal(c.passed, true, 'every C-version controller passed the C gate');
      if (kind === 'linear') assert.equal(d.passed, true, 'G3 is unaffected');
      else assert.equal(d.passed, d.efficiency.nonlinearArm.ratio <= M.TWO_LINK_MAX_RATIO, r.label);
    } finally { runtime.dispose(); }
  }
  const rejected = rows.filter(x => !x.gateD);
  assert.deepEqual(rejected.map(x => x.twoLinkRatio).sort(), [1.33, 1.46, 1.48]);
  assert.ok(rejected.every(x => x.device === 'VLAB-P2' && /1\.3 倍/.test(x.failure)), 'the failure states the ratio and the limit');
  for (const kind of ['rotary', 'linear']) {
    const runtime = new g.DriverRuntime({ kind: 'controller' });
    try { await runtime.compile(M.REFERENCE_SOURCE); const ref = plain(await M.isolationTest(s => runtime.control(s), { channelKind: kind })); assert.equal(ref.passed, true); assert.equal(ref.twoLinkMaxRatio, 1.3); }
    finally { runtime.dispose(); }
  }
  rt.close();
  const checks = [
    'D gate rejects the three C-version P2 controllers whose two-link ratio is 1.33-1.48 (live 1.61-1.73x baseline) and accepts the other six P2 controllers (<= 1.23)',
    'all nine G3 controllers pass (two-link case report-only on linear manuals); the C gate (twoLinkMaxRatio null) accepts all 18',
    'reference module passes under rotary and linear; failure text gives the measured ratio and the 1.3x limit',
  ];
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks, rows };
  fs.writeFileSync(path.join(root, 'validation', 'v70-gate-d.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
