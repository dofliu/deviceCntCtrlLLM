'use strict';
// Held-out evaluation device VLAB-X: CoreXY belt mechanism with reversal
// backlash and a Modbus-RTU style register protocol (CRC-16, function 0x17
// step, silent on bad CRC, drives must be enabled and homed). Checks that the
// device, its trusted host profile, both offline drivers and the default
// (non-holdout) model view behave as specified. It does not change or tune
// the agent, gate or prompts. Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

function link(g, seed = 7, includeTemplate = true) {
  const plant = new g.VirtualPlant({ seed, kinematics: 'corexy' });
  const l = new g.SimulatedDeviceLink({ plant, seed, model: 'VLAB-X', includeTemplate });
  const manual = plain(l.manual('VLAB-X')), endpoint = plain(l.inventory()).find(item => item.deviceModel === 'VLAB-X');
  l.connect({ endpointId: endpoint.endpointId, transport: endpoint.transport, baudRate: manual.connection.baudRate, protocol: manual.connection.protocol });
  return { plant, link: l, manual };
}
async function driverTests(g, l, source) {
  const runtime = new g.DriverRuntime();
  try { await runtime.compile(source); return plain(await runtime.test(l)); } finally { runtime.dispose(); }
}

async function run() {
  const checks = [], rt = createRuntime(), g = rt.global;
  const x = g.VlabProtocols.get('vlab-x-modbus/1');
  // CRC-16/MODBUS check value for ASCII "123456789" is 0x4B37.
  assert.equal(x.crc16(Array.from('123456789', c => c.charCodeAt(0))), 0x4b37);
  assert.deepEqual(plain(x.commandFromWire(x.encodeCommand([-0.0333, 0.1]))), [-0.0333, 0.1]);
  assert.deepEqual(plain(x.commandFromWire(x.encodeCommand({ op: 'grip', state: 'closed' }))), { op: 'grip', state: 'closed' });
  const good = x.encodeCommand([0.02, 0]);
  assert.throws(() => x.commandFromWire(good.slice(0, -2) + (good.endsWith('00') ? '01' : '00')), /CRC/);
  assert.equal(x.parseReply('').ok, false);
  checks.push('Modbus-RTU style frames: CRC-16/MODBUS (check value 0x4B37), unit 0x11, function 0x17 step and 0x06 lift/grip round trips; silence parsed as no response');

  {
    const { link: l } = link(g);
    const early = x.parseReply(l.exchange(x.encodeCommand([0.02, 0]), { dryRun: true }));
    assert.equal(early.ok, false); assert.match(early.error, /NOT_READY/);
    assert.equal(l.ready, false);
    const hs = plain(l.handshake());
    assert.equal(hs.ok, true); assert.equal(hs.model, 'VLAB-X'); assert.deepEqual(hs.startup, ['enable', 'home', 'status']);
    assert.equal(l.ready, true);
    const codes = [];
    for (const wire of x.fixtures.invalidFrames) { const reply = x.parseReply(l.exchange(wire, { dryRun: true })); assert.equal(reply.ok, false, wire); codes.push(reply.error.split(' ')[0]); }
    assert.deepEqual(codes, ['NO_RESPONSE', 'ILLEGAL_DATA_VALUE', 'NO_RESPONSE', 'ILLEGAL_DATA_VALUE', 'ILLEGAL_DATA_ADDRESS', 'ILLEGAL_FUNCTION']);
  }
  checks.push('device answers exception 6 before enable/home; host handshake reads identity, enables, homes and confirms status; bad CRC/unit stay silent; Modbus exception codes for range, address and function');

  {
    const { link: l, manual } = link(g, 7, true); l.handshake();
    assert.equal((await driverTests(g, l, manual.sampleDriverSource)).passed, true, 'manual template');
    const { link: l2, manual: m2 } = link(g, 7, false); l2.handshake();
    assert.equal(m2.templateIncluded, false); assert.equal(m2.sampleDriverSource, undefined);
    const synthesized = g.VlabDriverSynthesizer.fromSpec(m2.protocolSpec);
    assert.equal((await driverTests(g, l2, synthesized)).passed, true, 'offline spec synthesizer');
    const noCrcCheck = manual.sampleDriverSource.replace("if (b[b.length - 2] !== (c & 255) || b[b.length - 1] !== ((c >> 8) & 255)) throw new Error('Bad CRC.');", '');
    assert.notEqual(noCrcCheck, manual.sampleDriverSource);
    assert.equal((await driverTests(g, l, noCrcCheck)).passed, false, 'a decoder that skips CRC must fail');
    const crcHighFirst = manual.sampleDriverSource.replace('return hex([...body, c & 255, (c >> 8) & 255]);', 'return hex([...body, (c >> 8) & 255, c & 255]);');
    assert.notEqual(crcHighFirst, manual.sampleDriverSource);
    assert.equal((await driverTests(g, l, crcHighFirst)).passed, false, 'CRC byte order must matter');
    const g3 = g.VlabProtocols.get('vlab-g3-bin/1');
    assert.equal((await driverTests(g, l, plain(new g.SimulatedDeviceLink({ plant: new g.VirtualPlant({ seed: 7, kinematics: 'gantry' }), seed: 7, model: 'VLAB-G3' }).manual('VLAB-G3')).sampleDriverSource)).passed, false, 'a G3 driver must fail on VLAB-X');
    assert.ok(g3);
  }
  checks.push('manual template and offline spec-synthesized drivers pass the unchanged driver tests; skipping CRC, swapping CRC byte order or reusing the G3 driver fails');

  {
    const plant = new g.VirtualPlant({ seed: 11, kinematics: 'corexy' });
    const d0 = plain(plant.diagnostics()).geometry, w = d0.backlash;
    assert.ok(w >= 0.012 && w <= 0.02);
    const tip = () => plain(plant.diagnostics()).geometry.jointAngles;
    plant.act([0.05, 0]); const a = tip(); plant.act([0.05, 0]); const b = tip();
    assert.ok(Math.abs(b[0] - a[0]) > 1 && Math.abs(b[1] - a[1]) > 1, 'one motor moves both carriage axes');
    plant.act([-w * 0.8, 0]); const c = tip();
    assert.ok(Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-9, 'a reversal smaller than the backlash does not move the carriage');
    const ack = plain(plant.act([-0.05, 0]));
    assert.deepEqual(ack.applied, [-0.05, 0], 'the ACK reports the motor command, not belt motion');
  }
  checks.push('CoreXY plant: each motor moves the carriage diagonally; a reversal inside the backlash band leaves the carriage still while the ACK reports the motor command');

  {
    assert.deepEqual(plain(g.SimulatedDeviceLink.models()), ['VLAB-P2', 'VLAB-G3']);
    assert.throws(() => new g.PickPlaceExperimentEngine({ device: 'VLAB-X' }), /保留/);
    const C = g.VlabAgentContract;
    const def = plain(C.toolDefinition('read_manual'));
    assert.deepEqual(def.input_schema.properties.args.properties.documentId.enum, ['VLAB-P2', 'VLAB-G3']);
    assert.match(def.description, /手冊庫有 VLAB-P2 與 VLAB-G3，/);
    const lib = ['VLAB-P2', 'VLAB-G3', 'VLAB-X'], defX = plain(C.toolDefinition('read_manual', lib));
    assert.deepEqual(defX.input_schema.properties.args.properties.documentId.enum, lib);
    assert.match(defX.description, /手冊庫有 VLAB-P2、VLAB-G3 與 VLAB-X，/);
    const call = { name: 'read_manual', input: { args: { documentId: 'VLAB-X' }, reason: 'nameplate' } };
    assert.throws(() => C.validateToolCall(call, ['read_manual']));
    assert.equal(C.validateToolCall(call, ['read_manual'], lib).args.documentId, 'VLAB-X');
    assert.equal(plain(C.allowContext({ phase: 'onboarding', allowedTools: ['read_manual'] })).documentLibrary, undefined);
    assert.deepEqual(plain(C.allowContext({ phase: 'onboarding', allowedTools: ['read_manual'], documentLibrary: lib })).documentLibrary, lib);
    const p2 = new g.PickPlaceExperimentEngine({ seed: 3, device: 'VLAB-P2', recordFrames: false });
    await p2.initialize(); assert.equal(plain(p2._context()).documentLibrary, undefined); p2.dispose();
  }
  checks.push('default runs are unchanged: VLAB-X is not listed, cannot start without includeHoldout, and read_manual schema, description and context stay the two-document versions');

  {
    const e = new g.PickPlaceExperimentEngine({ seed: 7, strategy: 'adaptive', recordFrames: false, trialCount: 1, device: 'VLAB-X', includeHoldout: true, manualTemplate: false, controllerMode: 'generated' });
    try {
      let s = await e.initialize(); assert.deepEqual(plain(e._context()).documentLibrary, ['VLAB-P2', 'VLAB-G3', 'VLAB-X']);
      for (let i = 0; i < 3000 && !s.done; i++) s = await e.next();
      const r = plain(e.report());
      assert.equal(r.failure, null); assert.equal(r.suiteProgress.totalCompleted, 1);
      assert.equal(r.provenance.driverSource, 'offline-spec-synthesizer');
      checks.push(`offline single trial on VLAB-X (seed 7, no template, spec-synthesized driver, reference controller module): completed in ${r.actionCount} actions`);
    } finally { e.dispose(); }
  }
  rt.close();
  const result = { version: '0.7.0', kind: 'offline-node', device: 'VLAB-X (held-out)', date: new Date().toISOString().slice(0, 10), node: process.version, passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v7x-holdout-device.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
