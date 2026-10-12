'use strict';
// V7 focused checks: second simulated device (VLAB-G3 gantry, hex binary
// frames), trusted host protocol profiles, the no-template manual and the
// offline spec synthesizer. Pure Node; no model, browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

function connected(g, model, seed, includeTemplate = true) {
  const plant = new g.VirtualPlant({ seed, kinematics: model === 'VLAB-G3' ? 'gantry' : '2r' });
  const link = new g.SimulatedDeviceLink({ plant, seed, model, includeTemplate });
  const manual = plain(link.manual(model)), endpoint = plain(link.inventory()).find(item => item.deviceModel === model);
  link.connect({ endpointId: endpoint.endpointId, transport: endpoint.transport, baudRate: manual.connection.baudRate, protocol: manual.connection.protocol });
  link.handshake();
  return { plant, link, manual, endpoint };
}
async function driverTests(g, link, source) {
  const runtime = new g.DriverRuntime();
  try { await runtime.compile(source); return plain(await runtime.test(link)); } finally { runtime.dispose(); }
}

async function run() {
  const checks = [], runtime = createRuntime(), g = runtime.global;
  try {
    // Protocol profiles and device-side framing.
    const bin = g.VlabProtocols.get('vlab-g3-bin/1');
    assert.equal(bin.encodeCommand([0.02, 0]), 'a5051000c80000dd');
    assert.deepEqual(plain(bin.commandFromWire(bin.encodeCommand([-0.0333, 0.1]))), [-0.0333, 0.1]);
    assert.throws(() => bin.commandFromWire('a5051000c80000de'), /checksum/);
    assert.throws(() => bin.commandFromWire('A5051000C80000DD'), /lowercase/);
    assert.deepEqual(plain(g.VlabProtocols.quantize([0.0884658, -0.03333], bin)), [0.0885, -0.0333]);
    assert.deepEqual(plain(g.VlabProtocols.quantize([0.0884658, -0.03333], g.VlabProtocols.get('vlab-p2-json/1'))), [0.0884658, -0.03333]);
    const { link: g3, manual: g3Manual, plant: gantry } = connected(g, 'VLAB-G3', 7);
    const codes = [];
    for (const wire of bin.fixtures.invalidFrames) { const reply = bin.parseReply(g3.exchange(wire, { dryRun: true })); assert.equal(reply.ok, false); codes.push(reply.error.split(' ')[0]); }
    assert.deepEqual(codes, ['LIMIT', 'CHECKSUM', 'ARGUMENT', 'ARGUMENT', 'OPCODE', 'FRAME']);
    assert.equal(bin.parseReply(g3.exchange('{"op":"hello"}\n', { dryRun: true })).ok, false, 'JSON text is not a binary frame.');
    checks.push('G3 hex frames: sync/length/XOR checksum, int16 fixed point, explicit device error codes, host quantization only for fixed-point protocols');

    // Identity, transport and wrong-manual rejection.
    {
      const plant = new g.VirtualPlant({ seed: 7, kinematics: 'gantry' }), link = new g.SimulatedDeviceLink({ plant, seed: 7, model: 'VLAB-G3' });
      const ep = plain(link.inventory()).find(item => item.deviceModel === 'VLAB-G3'), p2Manual = plain(link.manual('VLAB-P2'));
      assert.throws(() => link.connect({ endpointId: ep.endpointId, transport: ep.transport, baudRate: p2Manual.connection.baudRate, protocol: p2Manual.connection.protocol }), /PROTOCOL/);
      assert.throws(() => link.connect({ endpointId: 'sim-serial-logger', transport: 'serial', baudRate: 57600, protocol: 'vlab-g3-bin/1' }), /DEVICE_IDENTITY_MISMATCH/);
      assert.throws(() => link.manual('VLAB-X9'), /找不到/);
    }
    checks.push('reading the P2 manual on the G3 station yields a protocol the connection rejects; logger endpoints remain rejected');

    // Driver gates on the G3 link.
    assert.equal(g3Manual.templateIncluded, true);
    assert.equal((await driverTests(g, g3, g3Manual.sampleDriverSource)).passed, true);
    const { manual: p2Manual } = connected(g, 'VLAB-P2', 42);
    const jsonOnBinary = await driverTests(g, g3, p2Manual.sampleDriverSource);
    assert.equal(jsonOnBinary.passed, false, 'A JSON driver must not pass on the binary device.');
    const littleEndian = g3Manual.sampleDriverSource.replace('return [(u >> 8) & 255, u & 255];', 'return [u & 255, (u >> 8) & 255];');
    assert.notEqual(littleEndian, g3Manual.sampleDriverSource);
    assert.equal((await driverTests(g, g3, littleEndian)).passed, false, 'Byte-order bug must fail.');
    const noChecksum = g3Manual.sampleDriverSource.replace("if (body.reduce((x, b) => x ^ b, 0) !== bytes[bytes.length - 1]) throw new Error('Bad checksum.');", '');
    assert.notEqual(noChecksum, g3Manual.sampleDriverSource);
    assert.equal((await driverTests(g, g3, noChecksum)).passed, false, 'Decoder that skips checksum validation must fail.');
    const { link: p2 } = connected(g, 'VLAB-P2', 42);
    assert.equal((await driverTests(g, p2, g3Manual.sampleDriverSource)).passed, false, 'A binary driver must not pass on the JSON device.');
    checks.push('G3 template driver passes; wrong-protocol, byte-order and missing-checksum drivers are rejected by host dry-run tests');

    // Real actuation through a quantizing binary driver.
    {
      const rt = new g.DriverRuntime(); await rt.compile(g3Manual.sampleDriverSource); await rt.test(g3);
      const ack = plain(await rt.act([0.0884658, -0.03333], g3));
      assert.deepEqual(ack.applied, [0.0885, -0.0333]); assert.equal(ack.limited, false);
      rt.dispose();
    }
    checks.push('XY commands are quantized to 0.0001 before encoding; ACK equals the quantized command');

    // Manual template switch and spec synthesizer.
    for (const [model, seed] of [['VLAB-P2', 42], ['VLAB-G3', 7]]) {
      const { link, manual } = connected(g, model, seed, false);
      assert.equal(manual.templateIncluded, false);
      assert.ok(!('sampleDriver' in manual) && !('sampleDriverSource' in manual));
      assert.ok(!JSON.stringify(manual).includes('function encode'), 'No driver source may leak through any manual field.');
      assert.ok(manual.protocolSpec && manual.protocolSpec.name === manual.connection.protocol);
      const source = g.VlabDriverSynthesizer.fromSpec(manual.protocolSpec);
      assert.ok(source.includes('no driver template used'));
      assert.equal((await driverTests(g, link, source)).passed, true, model + ' synthesized driver passes.');
    }
    assert.throws(() => g.VlabDriverSynthesizer.fromSpec({ family: 'can-bus' }), /unsupported framing family/);
    checks.push('no-template manuals omit every driver source; the offline spec synthesizer builds passing drivers for both framing families');

    // Gantry plant mechanics.
    {
      const plant = new g.VirtualPlant({ seed: 3, kinematics: 'gantry' }), d0 = plain(plant.diagnostics());
      assert.equal(d0.geometry.kinematics, 'gantry'); assert.match(d0.description, /龍門/);
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) limited = plant.act([0.1, 0.1]).limited;
      assert.equal(limited, true, 'Travel limits clamp and report limited.');
      const q = plain(plant.diagnostics()).geometry.jointAngles, travel = d0.geometry.lengths;
      assert.ok(Math.abs(q[0]) <= travel[0] + 1e-9 && Math.abs(q[1]) <= travel[1] + 1e-9);
      plant.configureTrial(2, { initialPose: true });
      plant.operate({ op: 'lift', position: 'down' });
      const before = plain(plant.diagnostics()).geometry.jointAngles;
      const d = plain(plant.diagnostics()).geometry, dest = d.destination, tip = before;
      // Evaluator-only aiming: steer straight at the platform centre.
      const toward = [dest[0] - tip[0], dest[1] - tip[1]], g0 = d.channelGains, map = d.channelToJoint;
      let u = [0, 1].map(c => toward[map[c]] / g0[c]);
      const k = 0.1 / Math.max(Math.abs(u[0]), Math.abs(u[1])); u = u.map(v => v * k);
      let threw = false;
      for (let i = 0; i < 40 && !threw; i++) { try { plant.act(u); } catch (error) { threw = /COLLISION/.test(error.message); } }
      assert.equal(threw, true, 'Low gantry sweeps into the elevated platform are rejected.');
    }
    checks.push('gantry plant: hidden axis mapping/gains, travel-limit clamping, atomic low-height platform collision');

    // Provider context allowlist for the new manual and controller fields.
    {
      const box = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout };
      vm.createContext(box); vm.runInContext(fs.readFileSync(path.join(root, 'src', 'claude-provider.js'), 'utf8'), box);
      const contract = box.VlabAgentContract;
      const { manual } = connected(g, 'VLAB-G3', 7, false);
      const ctx = plain(contract.allowContext({ phase: 'onboarding', allowedTools: ['write_driver', 'write_controller', 'stop'], manual, controllerMode: 'generated', controllerContract: 'contract text', controllerSource: 'function control(s){}', controllerTests: { passed: false, cases: [{ name: 'x', passed: false, failure: 'f', secret: 1 }] } }));
      assert.equal(ctx.manual.templateIncluded, false); assert.equal(ctx.manual.sampleDriverSource, '');
      assert.equal(ctx.manual.protocolSpec.family, 'binary-frame'); assert.equal(ctx.manual.protocol.limits.resolution, 0.0001);
      assert.deepEqual(ctx.allowedTools, ['write_driver', 'write_controller', 'stop']);
      assert.equal(ctx.controllerContract, 'contract text'); assert.equal(ctx.controllerTests.cases[0].secret, undefined);
      const builtin = plain(contract.allowContext({ phase: 'onboarding', allowedTools: [], manual }));
      assert.equal(builtin.controllerContract, undefined, 'Built-in mode does not advertise controller fields.');
      assert.ok(contract.instruction.includes('VLAB') || contract.instruction.includes('十六進位'));
    }
    checks.push('model context forwards protocolSpec and template status, filters controller test details, and hides controller fields in built-in mode');
  } finally { runtime.close(); }
  return { version: '0.7.0', passed: true, pureNode: true, browserUsed: false, networkCalls: 0, scope: 'Protocol profiles, simulated G3 device, driver gates, no-template manuals, spec synthesizer and provider context. Not a model, browser or complete pick/place run.', checks };
}
module.exports = { run };
if (require.main === module) run().then(result => {
  fs.writeFileSync(path.join(root, 'validation', 'v7-devices-protocols.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}).catch(error => { console.error(error); process.exitCode = 1; });
