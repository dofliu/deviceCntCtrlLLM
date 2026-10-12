'use strict';
// V7 browser smoke test: opens the built unknown-device-v7.0.html in headless
// Chromium (real iframe sandbox, CSP and Workers) and runs single-trial
// offline experiments for the new device/template/controller options.
// Offline policy only; no model API or network. Requires Node Playwright and a
// Chromium build (PLAYWRIGHT_BROWSERS_PATH or CHROMIUM_PATH).
// Usage: node tests/browser_v7_smoke.cjs [--shots dir]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(require.resolve('playwright', { paths: [require('node:child_process').execSync('npm root -g').toString().trim()] }))); }

const CASES = [
  { device: 'VLAB-G3', manualTemplate: false, controllerMode: 'generated', seed: 7 },
  { device: 'VLAB-P2', manualTemplate: false, controllerMode: 'generated', seed: 42 },
  { device: 'VLAB-G3', manualTemplate: true, controllerMode: 'builtin', seed: 42 }
];

async function main() {
  const html = path.join(root, 'unknown-device-v7.0.html');
  if (!fs.existsSync(html)) throw new Error('Run python build.py first.');
  const shotsIndex = process.argv.indexOf('--shots'), shots = shotsIndex > 0 ? process.argv[shotsIndex + 1] : null;
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  const rows = [];
  try {
    for (const spec of CASES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(String(error.message)));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('request', request => { if (!/^(file|data|blob|about):/.test(request.url())) requests.push(request.url()); });
      await page.goto('file://' + html);
      await page.waitForFunction(() => window.experimentLab && window.experimentLab.ready, null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => window.experimentLab.version), '0.7.0');
      const started = Date.now();
      await page.evaluate(spec => window.experimentLab.configure({ ...spec, trialCount: 1, strategy: 'adaptive' }), spec);
      const result = await page.evaluate(async () => {
        const lab = window.experimentLab;
        let s = lab.state().current;
        for (let i = 0; i < 900 && !s.done; i++) s = await lab.next();
        const r = lab.report();
        return { done: r.done, failure: r.failure, completed: r.suiteProgress?.totalCompleted, experiment: r.experiment,
          driverSource: r.provenance.driverSource, controllerSource: r.provenance.controllerSource, controllerTestsPassed: r.provenance.controllerTests?.passed ?? null,
          actions: r.actionCount, templateInManual: Boolean(r.onboarding?.manual?.sampleDriverSource), protocol: r.onboarding?.connection?.protocol };
      });
      await page.evaluate(() => window.experimentLab.showPage('driver'));
      const panel = await page.evaluate(() => ({ controllerPanelHidden: document.getElementById('xy-module-panel').hidden,
        controllerBadge: document.getElementById('xy-module-badge').textContent, driverBadge: document.getElementById('driver-source-badge').textContent,
        title: document.title }));
      if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${spec.device}-${spec.controllerMode}-${spec.manualTemplate ? 'template' : 'notemplate'}.png`), fullPage: false }); }
      rows.push({ ...spec, ...result, ...panel, seconds: (Date.now() - started) / 1000, consoleErrors: errors.slice(0, 10), externalRequests: requests.slice(0, 10) });
      await page.close();
    }
  } finally { await browser.close(); }
  for (const row of rows) {
    assert.equal(row.done, true); assert.equal(row.failure, null, JSON.stringify(row)); assert.equal(row.completed, 1);
    assert.deepEqual(row.consoleErrors, []); assert.deepEqual(row.externalRequests, []);
    assert.equal(row.templateInManual, row.manualTemplate);
    assert.equal(row.controllerPanelHidden, row.controllerMode !== 'generated');
    if (row.controllerMode === 'generated') assert.equal(row.controllerTestsPassed, true);
  }
  const out = { version: '0.7.0', passed: true, browser: 'headless Chromium via Playwright', modelCalls: 0,
    scope: 'Single-trial offline runs of the built HTML in a real browser (sandbox iframe, CSP, Workers). Offline policy, template/spec-synthesized drivers and the offline reference controller; not model-generated code or a five-trial browser run.', rows };
  fs.writeFileSync(path.join(root, 'validation', 'v7-browser-smoke.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
