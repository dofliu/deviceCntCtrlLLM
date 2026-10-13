'use strict';
// V7.0 command-line runner checks: the headless PNG encoder round-trips the
// real camera frame, an offline one-trial run produces a complete summary and
// gzipped full report, and a live run without the key refuses before any
// request. No model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { createRuntime, root } = require('./headless-runtime.cjs');

function decodeRGBA(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8, width = 0, height = 0; const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) { assert.equal(raw[y * (width * 4 + 1)], 0); raw.copy(out, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)); }
  return { width, height, pixels: out };
}

function runner(args, env = process.env) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', 'live_claude_v7.cjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 600000 });
  const line = result.stdout.split('\n').reverse().find(l => l.startsWith('RESULT '));
  return { status: result.status, result: line ? JSON.parse(line.slice(7)) : null, stdout: result.stdout };
}

function main() {
  const checks = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlab-cli-'));
  try {
    const g = createRuntime().global;
    for (const [seed, kinematics] of [[2026, undefined], [7, 'gantry']]) {
      const plant = new g.VirtualPlant({ seed, width: 640, height: 480, kinematics }), frame = plant.frame();
      const decoded = decodeRGBA(Buffer.from(g.VlabAgentContract.cameraPNG(frame), 'base64'));
      assert.equal(decoded.width, 640); assert.equal(decoded.height, 480);
      assert.ok(Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.length).equals(decoded.pixels), 'PNG pixels must match the frame');
    }
    checks.push('headless PNG encoder round-trips P2 and G3 camera frames losslessly (provider cameraPNG accepts it)');

    const off = runner(['--offline', '--device', 'G3', '--seed', '7', '--trials', '1', '--out-dir', tmp, '--label', 'g3-offline']);
    assert.equal(off.status, 0, off.stdout.slice(-800));
    assert.equal(off.result.ok, true); assert.equal(off.result.completed, 1); assert.equal(off.result.modelCalls, 0);
    const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'g3-offline.summary.json'), 'utf8'));
    assert.equal(summary.kind, 'offline-cli-run'); assert.equal(summary.condition.device, 'VLAB-G3'); assert.equal(summary.condition.protocol, 'vlab-g3-bin/1');
    assert.equal(summary.result.allTruthPlaced, true); assert.equal(summary.trials[0].evaluatorTruth.placed, true);
    assert.equal(summary.provenance.controllerSource, 'offline-reference-module');
    assert.equal(summary.controllerTests.efficiency.ratio, 1);
    assert.ok(summary.controllerStepStats.moves > 0);
    const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'g3-offline.full.json.gz'))));
    assert.equal(full.suiteProgress.totalCompleted, 1);
    checks.push('offline G3 one-trial CLI run: summary with truth check, efficiency, step stats; gzipped full report');

    const replay = spawnSync(process.execPath, [path.join(root, 'tests', 'replay_controller.cjs'), '--source', path.join(tmp, 'ref.js'), '--device', 'G3', '--seeds', '7', '--trials', '1', '--compare-reference', '--json', path.join(tmp, 'replay.json')],
      { cwd: root, encoding: 'utf8', timeout: 600000, input: '' , env: process.env, stdio: 'pipe', ...(fs.writeFileSync(path.join(tmp, 'ref.js'), g.VlabControllerModule.REFERENCE_SOURCE), {}) });
    assert.equal(replay.status, 0, replay.stderr);
    const replayed = JSON.parse(fs.readFileSync(path.join(tmp, 'replay.json'), 'utf8')).rows;
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0].actions, replayed[1].actions, 'replaying the reference source must equal the built-in reference run');
    assert.equal(replayed[0].actions, summary.actionCount, 'replay must equal the offline CLI run for the same device, seed and controller');
    checks.push('replay_controller.cjs reproduces the offline CLI action count for the same controller, device and seed');

    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
    const live = runner(['--device', 'P2', '--seed', '2026', '--trials', '1', '--out-dir', tmp, '--label', 'nokey', '--port', '8795'], env);
    assert.equal(live.status, 1); assert.equal(live.result.ok, false); assert.equal(live.result.modelCalls, 0);
    assert.match(live.result.error, /not set in this environment; no request was sent/);
    checks.push('live mode without ANTHROPIC_API_KEY stops before starting the bridge; 0 model calls');

    const bad = runner(['--device', 'X9']);
    assert.equal(bad.status, 2); assert.equal(bad.result.ok, false);
    checks.push('invalid device argument is rejected');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v70-cli-runner.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main();
