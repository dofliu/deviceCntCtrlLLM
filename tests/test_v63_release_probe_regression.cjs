'use strict';
// Focused regressions for two offline five-trial failures found on 2026-10-12:
// (1) at the 0.35 platform the endpoint disk hid the object's whole bottom edge,
//     biasing release-height evidence by about +2 px; (2) a probe clamped to zero
//     at the elbow limit was repeated forever. Synthetic RGBA only; no model,
//     browser or network. The 2.5 px height tolerance is unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, plain } = require('./headless-runtime.cjs');
const root = path.resolve(__dirname, '..');

function frame({ tip, objectCenter, destination, surface }) {
  const width = 640, height = 480, pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 8; pixels[i + 1] = 19; pixels[i + 2] = 28; pixels[i + 3] = 255; }
  const paint = (test, rgb) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (test(x + .5, y + .5)) {
      const i = (y * width + x) * 4; pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2];
    }
  };
  const ring = (c, r, w, rgb) => paint((x, y) => Math.abs(Math.hypot(x - c[0], y - c[1]) - r) <= w / 2, rgb);
  const disk = (c, r, rgb) => paint((x, y) => Math.hypot(x - c[0], y - c[1]) <= r, rgb);
  ring(destination, 34, 4, [73, 119, 239]);
  ring(surface, 18, 3, [155, 125, 244]);
  paint((x, y) => Math.abs(x - objectCenter[0]) <= 7.25 && Math.abs(y - objectCenter[1]) <= 7.25, [255, 173, 53]);
  disk(tip, 7.5, [7, 27, 35]);
  disk(tip, 6, [45, 226, 223]);
  return { width, height, pixels };
}

function releaseOffsets(inspect, platformHeight, objectHeight) {
  const tip = [320.3, 240.4], destination = tip.slice();
  const surface = [destination[0], destination[1] - platformHeight * 18];
  const objectCenter = [tip[0], tip[1] - objectHeight * 18];
  const out = plain(inspect(frame({ tip, objectCenter, destination, surface })));
  return {
    expected: out.surfaceOffsetPx,
    anchored: out.tip[1] - (out.objectEdgeAnchored || out.object)[1],
    bboxCenter: out.tip[1] - out.object[1]
  };
}

function run() {
  const runtime = createRuntime(), g = runtime.global, checks = [];
  try {
    const low = releaseOffsets(g.inspectTaskFrame, .35, .35);
    assert.ok(low.bboxCenter - low.expected > 1.5, 'Fixture reproduces the occluded-edge bias.');
    assert.ok(Math.abs(low.anchored - low.expected) <= 1, 'Low platform release height is measured from the visible edge.');
    for (const h of [0, .65]) {
      const r = releaseOffsets(g.inspectTaskFrame, h, h);
      assert.ok(Math.abs(r.anchored - r.expected) <= 1); assert.ok(Math.abs(r.anchored - r.bboxCenter) <= .01, 'Unoccluded heights keep the original estimate.');
    }
    checks.push('0.35 occluded-edge bias removed; 0 and 0.65 unchanged');
    for (const [platform, object] of [[.35, 0], [.35, .65], [.65, .35], [0, .35]]) {
      const r = releaseOffsets(g.inspectTaskFrame, platform, object);
      assert.ok(Math.abs(r.anchored - r.expected) > 2.5, `Wrong release height ${object} on platform ${platform} is still rejected.`);
    }
    checks.push('wrong release heights still exceed the unchanged 2.5 px tolerance');

    const core = new g.AgentCore();
    core.observed = true; core.observation = { tip: [300, 300], target: [400, 200], error: 141 };
    const blocked = { tool: 'probe', command: [.045, 0], applied: [0, 0], limited: true };
    core.lastOutcome = blocked;
    let d = plain(core.adaptiveDecision());
    assert.equal(d.tool, 'probe'); assert.equal(d.args.channel, 0); assert.equal(d.args.direction, -1);
    core.lastOutcome = { ...blocked, command: [-.045, 0] };
    assert.equal(plain(core.adaptiveDecision()).args.direction, 1);
    core.lastOutcome = { ...blocked, applied: [.02, 0] };
    assert.equal(plain(core.adaptiveDecision()).args.direction, 1, 'A partially applied probe is not treated as blocked.');
    core.lastOutcome = null;
    assert.equal(plain(core.adaptiveDecision()).args.direction, 1);
    checks.push('probe clamped to zero is reversed; partial clamps and fresh starts keep prior behaviour');
  } finally { runtime.close(); }
  return { version: '0.6.3', date: '2026-10-12', passed: true, pureNode: true, browserUsed: false, networkCalls: 0,
    scope: 'Synthetic RGBA detector fixture and AgentCore offline policy; not a browser, model or complete pick/place run.', checks };
}

module.exports = { run };
if (require.main === module) {
  const result = run();
  fs.writeFileSync(path.join(root, 'validation', 'v63-release-probe-regression.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
