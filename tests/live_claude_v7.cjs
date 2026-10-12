'use strict';
// AUTHORIZED LIVE RUN ONLY: real Claude API calls through the local bridge.
// V7 condition: VLAB-G3 gantry (binary frames), manual WITHOUT driver
// template, generated XY controller, five trials, call cap <= 500 (enforced
// by both the provider and the bridge). The API key stays inside the bridge
// process; this script never reads, prints or stores it.
// Usage: node tests/live_claude_v7.cjs [--model id] [--seed n] [--max-calls n] [--key-env ANTHROPIC_API_KEY]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const keyEnv = arg('--key-env', 'ANTHROPIC_API_KEY');
const maxCalls = Math.min(500, Math.max(1, Number(arg('--max-calls', 500))));
// Seeds 42/7 were used to develop G3; default to a seed not used in development.
const seed = Number(arg('--seed', 2026));
const port = Number(arg('--port', 8766));

function startBridge() {
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_Extra'].includes(keyEnv)) throw new Error('Unsupported key variable name.');
  if (!process.env[keyEnv]) throw new Error(`${keyEnv} is not set in this environment; no request was sent.`);
  const html = path.join(root, 'unknown-device-v7.0.html');
  if (!fs.existsSync(html)) throw new Error('Run python build.py first.');
  const child = spawn('python3', [path.join(root, 'claude_bridge.py'), '--port', String(port), '--max-calls', String(maxCalls), '--key-env', keyEnv, '--html', html], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Bridge did not start.')), 15000);
    child.stdout.on('data', chunk => { out += chunk; if (/available/.test(out)) { clearTimeout(timer); resolve(child); } else if (/not found/.test(out)) { clearTimeout(timer); child.kill(); reject(new Error('Bridge could not find the key variable.')); } });
    child.stderr.on('data', chunk => process.stderr.write(String(chunk).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Bridge exited: ' + code)); });
  });
}

async function main() {
  const bridge = await startBridge(), bridgeUrl = `http://127.0.0.1:${port}`;
  const rt = createRuntime(), g = rt.global;
  Object.assign(g, { fetch, AbortController, URL, URLSearchParams, Headers, Response, TextEncoder, TextDecoder });
  const started = new Date();
  let engine, provider, report = null, error = null;
  try {
    let model = arg('--model', null);
    if (!model) {
      const listed = plain(await g.ClaudeAgentProvider.listModels(undefined, { bridgeUrl }));
      const ids = (Array.isArray(listed) ? listed : listed?.models || listed?.data || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
      model = ids.find(id => /opus/.test(id)) || ids[0];
      if (!model) throw new Error('No Claude model listed for this key.');
    }
    console.log(`model=${model} seed=${seed} maxCalls=${maxCalls} device=VLAB-G3 manualTemplate=false controllerMode=generated trials=5`);
    provider = new g.ClaudeAgentProvider({ bridgeUrl, model, maxCalls, timeoutMs: 45000, minIntervalMs: 6000 });
    engine = new g.PickPlaceExperimentEngine({ seed, strategy: 'claude', provider, recordFrames: false, trialCount: 5, device: 'VLAB-G3', manualTemplate: false, controllerMode: 'generated' });
    let state = await engine.initialize(), lastKind = '';
    for (let step = 0; !state.done && step < 5000; step++) {
      state = await engine.next();
      if (state.kind !== lastKind || /decision|result|trial|failure|reached/.test(state.kind)) {
        const tool = state.decision?.tool || '';
        if (!/^(action-result)$/.test(state.kind) || step % 20 === 0)
          console.log(`[${step}] ${state.kind} ${tool} calls=${state.modelCalls} actions=${state.actionCount} ${String(state.explanation || '').slice(0, 110).replace(/\s+/g, ' ')}`);
        lastKind = state.kind;
      }
    }
    report = plain(engine.report());
  } catch (e) { error = String(e.message || e).slice(0, 400); if (engine) report = plain(engine.report()); }
  finally { engine?.dispose(); provider?.dispose?.(); rt.close(); bridge.kill(); }

  const stamp = started.toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  const fullPath = path.join(root, 'artifacts', `live-claude-v7-g3-${stamp}.json`);
  fs.writeFileSync(fullPath, JSON.stringify(report, null, 2));
  const o = report?.onboarding || {};
  const summary = {
    version: report?.version || '0.7.0', kind: 'live-model-run', provider: 'claude', model: report?.model || null,
    condition: { device: 'VLAB-G3', protocol: 'vlab-g3-bin/1', manualTemplate: false, controllerMode: 'generated', trials: 5, seed, maxCalls, minIntervalMs: 6000 },
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), runnerError: error,
    done: report?.done ?? false, failure: report?.failure ?? null, completed: report?.suiteProgress?.totalCompleted ?? 0,
    modelCalls: report?.modelCalls ?? null, actionCount: report?.actionCount ?? null,
    provenance: report?.provenance ? { driverSource: report.provenance.driverSource, controllerSource: report.provenance.controllerSource, frontCalls: report.provenance.frontCalls, controlCalls: report.provenance.controlCalls, usage: report.provenance.usage } : null,
    driverTests: o.driverTests ? { passed: o.driverTests.passed, failed: (o.driverTests.tests || []).filter(t => !t.passed).map(t => t.name) } : null,
    controllerTests: o.controllerTests ? { passed: o.controllerTests.passed, cases: (o.controllerTests.cases || []).map(c => ({ name: c.name, passed: c.passed, actions: c.actions, failure: c.failure })) } : null,
    generatedDriverSource: o.driverSource || null, generatedControllerSource: o.controllerSource || null,
    onboardingSteps: (o.steps || []).map(s => ({ tool: s.tool, ok: s.ok, summary: String(s.summary || '').slice(0, 300) })),
    trials: (report?.trials || []).map(t => ({ trial: t.trialNumber, destinationHeight: t.destinationHeight, success: t.success, failure: t.failure, placementErrorPx: t.placementError, actions: t.actionCount, xyActions: t.xyActionCount, modelCalls: t.modelCalls })),
    decisionRejections: report?.decisionRejections ?? null, modelRuntime: report?.modelRuntime ? { requests: report.modelRuntime.requests, rateLimitRetries: report.modelRuntime.rateLimitRetries, waitMs: report.modelRuntime.waitMs } : null,
    fullReport: path.relative(root, fullPath) + ' (gitignored; not in the source ZIP)'
  };
  const summaryPath = path.join(root, 'validation', `live-claude-v7-g3-${started.toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ done: summary.done, failure: summary.failure, completed: summary.completed, modelCalls: summary.modelCalls, summary: path.relative(root, summaryPath) }));
  if (error) process.exitCode = 1;
}
main().catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
