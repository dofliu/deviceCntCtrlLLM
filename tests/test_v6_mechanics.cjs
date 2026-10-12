'use strict';
const assert = require('node:assert/strict');
const { createRuntime, SoftwareCanvas, plain } = require('./headless-runtime.cjs');

// Evaluator-only fixture positioning. Production agents continue to receive
// camera pixels and ACKs only; this helper never runs inside their worker.
async function driveTo(plant, target, send, { onRejected } = {}) {
  const geometry = plant.diagnostics().geometry, [l1, l2] = geometry.lengths;
  const q1 = Math.acos(Math.max(-1, Math.min(1, (target[0] ** 2 + target[1] ** 2 - l1 * l1 - l2 * l2) / (2 * l1 * l2))));
  const goal = [Math.atan2(target[1], target[0]) - Math.atan2(l2 * Math.sin(q1), l1 + l2 * Math.cos(q1)), q1];
  for (let n = 0; n < 110; n++) {
    const current = plain(plant.diagnostics());
    const delta = goal.map((value, index) => {
      let amount = value - current.geometry.jointAngles[index];
      if (!index) amount = ((amount + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      return amount;
    });
    if (Math.hypot(...delta) < 1e-8) return;
    const command = current.geometry.channelToJoint.map((joint, channel) => Math.max(-.1, Math.min(.1, delta[joint] / current.geometry.channelGains[channel])));
    try { await send(command); }
    catch (error) { onRejected?.(error, current, plain(plant.diagnostics())); throw error; }
  }
  throw new Error('Evaluator-only fixture could not reach target.');
}

function evidenceFrame(height, tipX = 300) {
  const canvas = new SoftwareCanvas(); canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#08131c'; ctx.fillRect(0, 0, 640, 480);
  ctx.beginPath(); ctx.arc(300, 200, 34, 0, 2 * Math.PI); ctx.strokeStyle = '#4977ef'; ctx.lineWidth = 4; ctx.stroke();
  ctx.beginPath(); ctx.arc(300, 200 - 18 * height, 18, 0, 2 * Math.PI); ctx.strokeStyle = '#9b7df4'; ctx.lineWidth = 3; ctx.stroke();
  // Deliberately incorrect: object remains at tabletop, within one XY pixel of B.
  ctx.fillStyle = '#ffad35'; ctx.fillRect(292, 191, 16, 16);
  ctx.beginPath(); ctx.arc(tipX, 199, 6, 0, 2 * Math.PI); ctx.fillStyle = '#2de2df'; ctx.fill();
  return { width: 640, height: 480, pixels: ctx.getImageData(0, 0, 640, 480).data };
}

async function cameraRejectsWrongHeight(global, height) {
  let frame = evidenceFrame(height);
  const controller = new global.PickPlaceController({ seed: 42, strategy: 'adaptive', recordFrames: false, maxActions: 180, maxDecisions: 300,
    plant: { diagnostics: () => ({}) }, frameGetter: () => frame,
    mechanicalActuator: async command => ({ applied: command, limited: false }) });
  try {
    await controller.initialize();
    await controller.next(); await controller.next(); // Actual inspect_scene establishes required surface evidence.
    assert.equal(controller._surfaceRequired, true);
    // Explicit validation fixture: previous transport prerequisites are assumed.
    // The release frame itself, its height evidence and final checks are REAL.
    Object.assign(controller._task, { phase: 'release', graspVerified: true, coMotionVerified: true, atDestination: true });
    controller._actuatorState = { lift: 'down', gripper: 'closed' };
    await controller.next(); await controller.next();
    frame = evidenceFrame(height, 350);
    Object.assign(controller._task, { phase: 'verify_place', cleared: true });
    controller._actuatorState.lift = 'up';
    await controller.next(); const end = await controller.next();
    assert.equal(end.done, true); assert.ok(end.failure);
    assert.equal(end.toolResult.data.checks.insideDestination, true, 'XY/projection tolerance alone would wrongly accept this tabletop object.');
    assert.equal(end.toolResult.data.checks.releaseHeightMatched, false, 'Observed release height must reject wrong-height placement.');
    assert.equal(end.taskProgress.completed, false);
    return { platformHeight: height, placementError: end.toolResult.data.placementError, releaseHeightMatched: false };
  } finally { controller.dispose(); }
}

async function run() {
  const rt = createRuntime(), g = rt.global, checks = [];
  const plant = new g.VirtualPlant({ seed: 42 }); plant.configureTrial(2, { initialPose: true });
  const link = new g.SimulatedDeviceLink({ plant, seed: 42 }), runtime = new g.DriverRuntime();
  try {
    const manual = link.manual('VLAB-P2'), endpoint = link.inventory().find(item => item.deviceModel === 'VLAB-P2');
    link.connect({ ...manual.connection, endpointId: endpoint.endpointId }); link.handshake();
    const untouched = plain(plant.diagnostics());
    await runtime.compile(manual.sampleDriverSource);
    assert.equal((await runtime.test(link)).passed, true);
    assert.deepEqual(plain(plant.diagnostics()), untouched, 'Driver dry-run cannot move or alter the plant.');
    checks.push('compiled driver dry-run preserves all mechanics');
    const move = command => runtime.act(command, link), aux = command => runtime.operate(command, link);
    await driveTo(plant, plant.diagnostics().pickPlace.object, move);
    await aux({ op: 'grip', state: 'closed' });
    assert.equal(plant.diagnostics().pickPlace.held, false, 'Correct XY at wrong height cannot attach.');
    await aux({ op: 'grip', state: 'open' }); await aux({ op: 'lift', position: 'down' }); await aux({ op: 'grip', state: 'closed' });
    assert.equal(plant.diagnostics().pickPlace.held, true);
    assert.throws(() => plant.configureTrial(3), /release/);
    checks.push('grasp requires matching height; held object prevents trial replacement');
    await aux({ op: 'lift', position: 'up' });
    const destination = plain(plant.diagnostics().pickPlace.destination), radius = Math.hypot(...destination);
    const outside = destination.map(value => value * (radius - 45) / radius);
    await driveTo(plant, outside, move); await aux({ op: 'lift', position: 'down' });
    let rejected = false;
    await assert.rejects(() => driveTo(plant, destination, move, { onRejected(error, before, after) {
      assert.match(error.message, /COLLISION/); assert.deepEqual(after, before, 'Rejected collision must not partly move either joint or object.'); rejected = true;
    } }), /COLLISION/);
    assert.equal(rejected, true); checks.push('low-height platform collision rejects entire XY command without partial movement');
    assert.equal(runtime.passed, false, 'Device rejection invalidates the generated-driver validation.');
    assert.equal((await runtime.test(link)).passed, true, 'Explicit dry-run revalidation is required before this evaluator-only fixture continues.');
    await aux({ op: 'grip', state: 'open' });
    const wrongRelease = plain(plant.diagnostics().pickPlace);
    assert.equal(wrongRelease.held, false); assert.equal(wrongRelease.objectHeight, 0); assert.equal(wrongRelease.placed, false);
    assert.ok(Math.hypot(wrongRelease.object[0] - destination[0], wrongRelease.object[1] - destination[1]) > 24);
    checks.push('release outside platform falls to table and does not snap to B');
    await aux({ op: 'grip', state: 'closed' }); await aux({ op: 'lift', position: 'up' });
    await driveTo(plant, destination, move); await aux({ op: 'lift', position: 'down' });
    assert.equal(plant.diagnostics().pickPlace.liftHeight, .65); assert.equal(plant.diagnostics().pickPlace.objectHeight, .65);
    await aux({ op: 'grip', state: 'open' }); await aux({ op: 'lift', position: 'up' }); await driveTo(plant, outside, move);
    assert.equal(plant.diagnostics().pickPlace.placed, true); assert.equal(plant.diagnostics().pickPlace.objectHeight, .65);
    checks.push('compliant descent and physical platform support retain released object after retreat');
    plant.setOccluded(true); assert.equal(g.inspectTaskFrame(plant.frame()).tip, null);
    plant.setOccluded(false); assert.ok(g.inspectTaskFrame(plant.frame()).tip);
    checks.push('real raster evidence loses and restores endpoint marker');
    const cameraCases = [];
    for (const height of [.35, .65]) cameraCases.push(await cameraRejectsWrongHeight(g, height));
    checks.push('camera validator rejects tabletop object at correct XY beneath both elevated platforms');
    return { passed: true, checks, cameraCases, scope: 'Pure Node production mechanics, frame drawing, driver round trips and explicit camera validation fixtures; no browser/API/network.' };
  } finally { runtime.dispose(); rt.close(); }
}
module.exports = { run, driveTo, cameraRejectsWrongHeight };
if (require.main === module) run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
