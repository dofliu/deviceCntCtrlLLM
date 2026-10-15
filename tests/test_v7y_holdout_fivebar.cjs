'use strict';
// Second held-out evaluation device VLAB-Y: a closed-chain five-bar parallel
// arm on the development JSON-line protocol, so only the kinematic class is
// new. Checks the mechanism (coupled, pose-dependent channel mapping; both
// motors stop before a singular pose), the device link, and that P2/G3 and
// VLAB-X runs see the same model inputs as before. It does not change or tune
// the agent, gate, prompts or reference module. Pure Node; no model, browser
// or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

function link(g, seed = 7, includeTemplate = true) {
  const plant = new g.VirtualPlant({ seed, kinematics: 'fivebar' });
  const l = new g.SimulatedDeviceLink({ plant, seed, model: 'VLAB-Y', includeTemplate });
  const manual = plain(l.manual('VLAB-Y')), endpoint = plain(l.inventory()).find(item => item.deviceModel === 'VLAB-Y');
  l.connect({ endpointId: endpoint.endpointId, transport: endpoint.transport, baudRate: manual.connection.baudRate, protocol: manual.connection.protocol });
  return { plant, link: l, manual };
}
async function driverTests(g, l, source) {
  const runtime = new g.DriverRuntime();
  try { await runtime.compile(source); return plain(await runtime.test(l)); } finally { runtime.dispose(); }
}
const tipOf = plant => plain(plant.diagnostics()).tip;
const direction = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const turn = (a, b) => Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI;

async function run() {
  const checks = [], rt = createRuntime(), g = rt.global;

  {
    const radii = [];
    for (let seed = 0; seed < 120; seed++) {
      const plant = new g.VirtualPlant({ seed, kinematics: 'fivebar' });
      const f = plain(plant.diagnostics()).geometry.fiveBar;
      radii.push(f.radius);
      for (let i = 0; i < 5; i++) {
        plant.configureTrial(i, { initialPose: i === 0 });
        const d = plain(plant.diagnostics());
        assert.ok(d.pickPlace.object.every(Number.isFinite) && d.pickPlace.destination.every(Number.isFinite));
        assert.ok(d.geometry.jointAngles.every(Number.isFinite), 'every trial start pose is reachable');
      }
    }
    assert.ok(Math.min(...radii) >= 100, 'every seed keeps a singularity-free work disk of at least 100 px');
    checks.push(`five-bar work disk radius ${Math.min(...radii).toFixed(0)}-${Math.max(...radii).toFixed(0)} px over seeds 0-119; all trial start poses reachable`);
  }

  {
    // Reproducible nonlinearity measure (test code, not the agent): drive the
    // tip with a finite-difference Jacobian to every trial's object and goal
    // position, and at each pose record each channel's image direction and
    // gain. Compared with the development arm VLAB-P2 on the same seeds.
    const channelMap = plant => [0, 1].map(c => {
      const a = tipOf(plant), cmd = c ? [0, 0.01] : [0.01, 0]; plant.act(cmd); const b = tipOf(plant); plant.act(cmd.map(v => -v));
      return [b[0] - a[0], b[1] - a[1]];
    });
    const goTo = (plant, goal) => {
      for (let i = 0; i < 400; i++) {
        const tip = tipOf(plant), e = [goal[0] - tip[0], goal[1] - tip[1]];
        if (Math.hypot(...e) < 1.5) return true;
        const [ja, jb] = channelMap(plant), det = ja[0] * jb[1] - jb[0] * ja[1];
        let u = [(jb[1] * e[0] - jb[0] * e[1]) / det * 0.01, (-ja[1] * e[0] + ja[0] * e[1]) / det * 0.01];
        const scale = Math.max(1, Math.abs(u[0]) / 0.05, Math.abs(u[1]) / 0.05); u = u.map(v => v / scale);
        plant.act(u);
      }
      return false;
    };
    const measure = (kinematics, seed) => {
      const plant = new g.VirtualPlant({ seed, kinematics }), maps = [];
      for (let i = 0; i < 5; i++) {
        plant.configureTrial(i, { initialPose: i === 0 });
        const m = plain(plant.diagnostics()).manipulation;
        for (const goal of [m.object, m.destination]) { assert.ok(goTo(plant, goal), kinematics + ' reaches every trial position'); maps.push(channelMap(plant)); }
      }
      const out = [0, 1].map(c => {
        const dirs = maps.map(m => Math.atan2(m[c][1], m[c][0])), gains = maps.map(m => Math.hypot(...m[c]));
        let rotation = 0; for (const a of dirs) for (const b of dirs) rotation = Math.max(rotation, turn(a, b));
        return { rotation, gain: Math.max(...gains) / Math.min(...gains) };
      });
      return { rotation: Math.max(out[0].rotation, out[1].rotation), gain: Math.max(out[0].gain, out[1].gain) };
    };
    const rows = [2026, 3140, 8675].map(seed => ({ seed, y: measure('fivebar', seed), p2: measure('2r', seed) }));
    for (const r of rows) assert.ok(r.y.rotation > 40 && r.y.gain > 1.4, 'the five-bar channel mapping turns and rescales across the task');
    checks.push('channel mapping across the ten trial positions (max direction change / max gain ratio): ' + rows.map(r => `seed ${r.seed} VLAB-Y ${r.y.rotation.toFixed(0)} deg / x${r.y.gain.toFixed(2)}, VLAB-P2 ${r.p2.rotation.toFixed(0)} deg / x${r.p2.gain.toFixed(2)}`).join('; '));
  }

  {
    // Driving one channel without end reaches a singularity margin: both
    // motors stop together, the ACK reports the accepted fraction and
    // limited:true, and the opposite command moves away again.
    const plant = new g.VirtualPlant({ seed: 11, kinematics: 'fivebar' });
    let last = null, steps = 0;
    for (; steps < 400; steps++) { last = plain(plant.act([0.1, 0])); if (last.limited) break; }
    assert.equal(last.limited, true, 'a singularity margin stops the motion');
    assert.ok(Math.abs(last.applied[0]) < 0.1 && last.applied[1] === 0, 'the ACK reports the accepted fraction');
    const held = tipOf(plant), again = plain(plant.act([0.1, 0]));
    assert.equal(again.limited, true);
    assert.ok(Math.hypot(...tipOf(plant).map((v, i) => v - held[i])) < 1.5, 'it stays at the stop');
    const back = plain(plant.act([-0.1, 0]));
    assert.equal(back.limited, false); assert.ok(Math.hypot(...tipOf(plant).map((v, i) => v - held[i])) > 1, 'the reverse command moves away');
    assert.equal(plain(plant.act([0.2, 0])).limited, true, 'over-range commands are clamped and reported');
    checks.push(`singularity stop: channel A at +0.1 stopped after ${steps} steps with applied ${last.applied[0].toFixed(4)} and limited:true; the reverse command moves away`);
  }

  {
    const { link: l, manual } = link(g);
    assert.equal(manual.channelKind, 'rotary'); assert.equal(manual.connection.protocol, 'vlab-p2-json/1');
    assert.match(manual.deviceClass, /五連桿/); assert.equal(manual.connection.baudRate, manual.connection.transport === 'serial' ? 230400 : 0);
    const hs = plain(l.handshake());
    assert.equal(hs.ok, true); assert.equal(hs.model, 'VLAB-Y'); assert.equal(hs.firmware, 'sim-y-1.0');
    assert.throws(() => l.connect({}), /ALREADY_CONNECTED/);
    const p2 = new g.SimulatedDeviceLink({ plant: new g.VirtualPlant({ seed: 7 }), seed: 7, model: 'VLAB-P2' });
    const ep = plain(p2.inventory()).find(item => item.deviceModel === 'VLAB-P2');
    p2.connect({ endpointId: ep.endpointId, transport: ep.transport, baudRate: ep.transport === 'serial' ? 115200 : 0, protocol: 'vlab-p2-json/1' });
    assert.equal(p2.exchange('{"op":"hello"}\n'), '{"ok":true,"model":"VLAB-P2","protocol":"vlab-p2-json/1","firmware":"sim-2.0","channels":2,"maxStep":0.1,"capabilities":{"xy":"relative-unknown-mapping","lift":["up","down"],"grip":["open","closed"]},"simulated":true}\n', 'the VLAB-P2 hello reply is unchanged');
    assert.equal((await driverTests(g, l, manual.sampleDriverSource)).passed, true, 'the JSON-line template driver passes on VLAB-Y');
    const plantY = new g.VirtualPlant({ seed: 7, kinematics: 'fivebar' }), wrong = new g.SimulatedDeviceLink({ plant: plantY, seed: 7, model: 'VLAB-Y' });
    const epY = plain(wrong.inventory()).find(item => item.deviceModel === 'VLAB-Y');
    assert.throws(() => wrong.connect({ endpointId: epY.endpointId, transport: epY.transport, baudRate: epY.transport === 'serial' ? 115200 : 1, protocol: 'vlab-p2-json/1' }), /BAUD/, 'wrong connection settings are rejected');
    const serialY = new g.SimulatedDeviceLink({ plant: new g.VirtualPlant({ seed: 9, kinematics: 'fivebar' }), seed: 9, model: 'VLAB-Y' });
    const epS = plain(serialY.inventory()).find(item => item.deviceModel === 'VLAB-Y');
    assert.equal(epS.transport, 'serial'); assert.equal(plain(serialY.manual('VLAB-Y')).connection.baudRate, 230400);
    assert.throws(() => serialY.connect({ endpointId: epS.endpointId, transport: 'serial', baudRate: 115200, protocol: 'vlab-p2-json/1' }), /BAUD/, 'the VLAB-P2 baud rate is rejected');
  }
  checks.push('VLAB-Y link: JSON-line protocol shared with VLAB-P2, own model, firmware and baud rate; handshake reports VLAB-Y; the template driver passes the unchanged driver tests; the VLAB-P2 hello reply is unchanged');

  {
    assert.deepEqual(plain(g.SimulatedDeviceLink.models()), ['VLAB-P2', 'VLAB-G3']);
    assert.deepEqual(plain(g.SimulatedDeviceLink.models({ includeHoldout: true })), ['VLAB-P2', 'VLAB-G3', 'VLAB-X', 'VLAB-Y']);
    assert.throws(() => new g.PickPlaceExperimentEngine({ device: 'VLAB-Y' }), /VLAB-Y 是保留/);
    const x = new g.PickPlaceExperimentEngine({ seed: 3, device: 'VLAB-X', includeHoldout: true, recordFrames: false });
    await x.initialize(); assert.deepEqual(plain(x._context()).documentLibrary, ['VLAB-P2', 'VLAB-G3', 'VLAB-X'], 'VLAB-X runs keep their library'); x.dispose();
    const y = new g.PickPlaceExperimentEngine({ seed: 3, device: 'VLAB-Y', includeHoldout: true, recordFrames: false });
    await y.initialize(); const lib = plain(y._context()).documentLibrary; y.dispose();
    assert.deepEqual(lib, ['VLAB-P2', 'VLAB-G3', 'VLAB-X', 'VLAB-Y']);
    const C = g.VlabAgentContract, def = plain(C.toolDefinition('read_manual', lib));
    assert.deepEqual(def.input_schema.properties.args.properties.documentId.enum, lib);
    assert.match(def.description, /手冊庫有 VLAB-P2、VLAB-G3、VLAB-X 與 VLAB-Y，/);
    assert.equal(C.validateToolCall({ name: 'read_manual', input: { args: { documentId: 'VLAB-Y' }, reason: 'nameplate' } }, ['read_manual'], lib).args.documentId, 'VLAB-Y');
  }
  checks.push('isolation: VLAB-Y is not listed by default and cannot start without includeHoldout; VLAB-X runs keep the [P2, G3, X] library; VLAB-Y runs add VLAB-Y to read_manual');

  {
    const e = new g.PickPlaceExperimentEngine({ seed: 7, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-Y', includeHoldout: true, manualTemplate: false, controllerMode: 'generated' });
    try {
      let s = await e.initialize();
      for (let i = 0; i < 3000 && !s.done; i++) s = await e.next();
      const r = plain(e.report());
      assert.equal(r.failure, null); assert.equal(r.suiteProgress.totalCompleted, 1);
      assert.equal(r.provenance.driverSource, 'offline-spec-synthesizer');
      assert.equal(r.provenance.controllerTests.channelKind, 'rotary');
      checks.push(`offline single trial on VLAB-Y (seed 7, no template, spec-synthesized driver, reference controller module under the rotary gate): completed in ${r.actionCount} actions`);
    } finally { e.dispose(); }
  }
  rt.close();
  const result = { version: '0.7.0', kind: 'offline-node', device: 'VLAB-Y (held-out; five-bar parallel arm, JSON-line protocol)', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v7y-holdout-device.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
