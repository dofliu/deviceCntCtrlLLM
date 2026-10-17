'use strict';
// Gemini path of the command-line runner, checked offline (2026-10-17).
// Production provider code runs with canned HTTP replies and a virtual clock;
// the engine runs headless with a stubbed bridge reply; the runner is only
// started in ways that stop before a bridge or request exists. No credentials,
// network, browser or model service are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRuntime, plain, root } = require('./headless-runtime.cjs');

const canary = 'FAKE_TEST_KEY_NO_CREDENTIAL';
const frame = { dataURL: 'data:image/png;base64,aGVsbG8=' };
const control = { phase: 'control', allowedTools: ['observe', 'stop'], observation: { tip: [10, 10], target: [20, 20], error: 14.14 },
  budgets: { actionsUsed: 0, maxActions: 180, decisionsUsed: 0, maxDecisions: 500 } };
const onboarding = { phase: 'onboarding', allowedTools: ['inspect_device', 'stop'], budgets: control.budgets };
const drain = () => new Promise(setImmediate);

class Clock {
  now = 0; nextId = 0; timers = new Map();
  setTimeout = (fn, delay = 0) => { const id = ++this.nextId; this.timers.set(id, { id, at: this.now + Math.max(0, Number(delay) || 0), fn }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async settle(promise) {
    let done = false, result, failure;
    Promise.resolve(promise).then(value => { done = true; result = value; }, error => { done = true; failure = error; });
    for (let steps = 0; steps < 2000; steps++) {
      await drain();
      if (done) { if (failure) throw failure; return result; }
      const timer = [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (timer) { this.timers.delete(timer.id); this.now = timer.at; timer.fn(); }
    }
    throw new Error('Request never settled.');
  }
}

const answer = (kind, name = 'observe') => kind === 'claude'
  ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input: { args: {}, reason: '依照影像' } }], usage: { input_tokens: 12, output_tokens: 8 } }
  : { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name, args: { args: {}, reason: '依照影像' } } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, thoughtsTokenCount: 3 } };
const ok = kind => ({ status: 200, body: answer(kind) });
const failure = (status, error) => ({ status, body: { error } });

function harness(kind, replies, options = {}) {
  const clock = new Clock(), requests = [];
  const box = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Date: class extends Date { static now() { return Date.UTC(2026, 9, 17) + clock.now; } }, performance: { now: () => clock.now },
    fetch: async (url, init) => {
      const plan = replies[requests.length];
      requests.push({ at: clock.now, url, body: JSON.parse(init.body) });
      assert.ok(plan, 'unexpected extra model request');
      if (plan.hang) await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return { ok: plan.status < 300, status: plan.status, headers: { get: () => null }, json: async () => plain(plan.body) };
    }
  });
  for (const file of ['claude-provider.js', ...(kind === 'gemini' ? ['gemini-provider.js'] : [])])
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), box, { filename: file });
  const Provider = box[kind === 'claude' ? 'ClaudeAgentProvider' : 'GeminiAgentProvider'];
  const provider = new Provider({ apiKey: canary, model: kind + '-mock', minIntervalMs: 0, maxRateLimitRetries: 0, ...options });
  const run = (context = control) => { const p = provider.decide(context, frame); p.catch(() => {}); return clock.settle(p); };
  return { clock, provider, requests, run };
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => error.code === code || assert.fail(`expected ${code}, got ${error.code}`));
}

function runner(args, env) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', 'live_claude_v7.cjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  const line = result.stdout.split('\n').reverse().find(l => l.startsWith('RESULT '));
  return { status: result.status, result: line ? JSON.parse(line.slice(7)) : null, stdout: result.stdout + result.stderr };
}

(async () => {
  const checks = [];
  const retry = { maxTransientRetries: 1 };

  // 1. One resend after a server-side failure, counted in the call budget.
  for (const [label, first] of [
    ['bridge 503 UPSTREAM_UNAVAILABLE (model overloaded)', failure(503, { code: 'UPSTREAM_UNAVAILABLE', status: 503, retryable: false })],
    ['bridge 500', failure(500, { code: 'UPSTREAM_UNAVAILABLE', status: 500, retryable: false })],
    ['bridge 502 (upstream unreachable)', failure(502, { code: 'UPSTREAM_UNAVAILABLE' })],
    ['direct 504 DEADLINE_EXCEEDED', failure(504, { status: 'DEADLINE_EXCEEDED' })],
    ['direct 503 UNAVAILABLE', failure(503, { status: 'UNAVAILABLE' })]
  ]) {
    const h = harness('gemini', [first, ok('gemini')], retry);
    assert.equal((await h.run()).tool, 'observe', label);
    assert.deepEqual(h.requests.map(r => r.at), [0, 10000], label);
    assert.equal(h.provider.calls, 2, label); assert.equal(h.provider.requestDiagnostics.transientRetries, 1, label);
  }
  checks.push('Gemini with maxTransientRetries 1 resends once after 10 s on HTTP 500/502/504 or 503 UNAVAILABLE (bridge or direct); both attempts count as calls');

  let h = harness('gemini', [{ status: 200, hang: true }, ok('gemini')], { ...retry, timeoutMs: 45000 });
  assert.equal((await h.run()).tool, 'observe'); assert.deepEqual(h.requests.map(r => r.at), [0, 55000]); assert.equal(h.provider.calls, 2);
  checks.push('a Gemini request timeout (45 s) is resent once after the 10 s cooldown');

  const upstream = failure(503, { code: 'UPSTREAM_UNAVAILABLE' });
  h = harness('gemini', [upstream, upstream], retry);
  await rejects(h.run(), 'UPSTREAM_UNAVAILABLE'); assert.equal(h.requests.length, 2);
  for (const [label, reply, code] of [
    ['bridge without key', failure(503, { code: 'MISSING_AUTHORIZED_KEY' }), 'MISSING_AUTHORIZED_KEY'],
    ['bridge call budget', failure(429, { code: 'BRIDGE_CALL_BUDGET', status: 429, retryable: false }), 'BRIDGE_CALL_BUDGET'],
    ['bad request', failure(400, { status: 'INVALID_ARGUMENT' }), 'INVALID_REQUEST_FORMAT'],
    ['malformed upstream reply', failure(502, { code: 'UPSTREAM_FORMAT' }), 'UPSTREAM_FORMAT']
  ]) {
    h = harness('gemini', [reply, ok('gemini')], retry);
    if (code === 'UPSTREAM_FORMAT') {
      // Same as Claude, where any bridge 502 becomes HTTP_502 and is resent.
      assert.equal((await h.run()).tool, 'observe', label); assert.equal(h.requests.length, 2, label);
    } else { await rejects(h.run(), code); assert.equal(h.requests.length, 1, label); }
  }
  h = harness('gemini', [upstream], { ...retry, maxCalls: 1 });
  await rejects(h.run(), 'CALL_BUDGET'); assert.equal(h.requests.length, 1); assert.equal(h.provider.calls, 1);
  h = harness('gemini', [upstream]);
  await rejects(h.run(), 'UPSTREAM_UNAVAILABLE'); assert.equal(h.requests.length, 1);
  checks.push('no third attempt; no resend for a missing key, budget refusal or 4xx; an exhausted budget stops the resend; the default (browser) Gemini provider still never resends');

  h = harness('claude', [failure(529, { type: 'overloaded_error' }), ok('claude')], retry);
  assert.equal((await h.run()).tool, 'observe'); assert.equal(h.requests.length, 2);
  h = harness('claude', [failure(503, { type: 'api_error' }), ok('claude')], retry);
  await rejects(h.run(), 'HTTP_503'); assert.equal(h.requests.length, 1);
  checks.push('Claude keeps its own rule (529 resent, 503 not): the scheduler default is unchanged');

  // 2. Output limits match the Claude request; thinking is not configured.
  h = harness('gemini', [ok('gemini'), { status: 200, body: answer('gemini', 'stop') }], { maxOutputTokens: { onboarding: 8192, other: 1400 } });
  await h.run(control); await h.run(onboarding);
  assert.deepEqual(h.requests.map(r => r.body.generationConfig), [{ candidateCount: 1, maxOutputTokens: 1400 }, { candidateCount: 1, maxOutputTokens: 8192 }]);
  const claude = harness('claude', [ok('claude'), { status: 200, body: answer('claude', 'stop') }]);
  await claude.run(control); await claude.run(onboarding);
  assert.deepEqual(claude.requests.map(r => r.body.max_tokens), [1400, 8192]);
  assert.ok(claude.requests.every(r => !('thinking' in r.body)));
  h = harness('gemini', [ok('gemini')]);
  await h.run(control); assert.equal(h.requests[0].body.generationConfig.maxOutputTokens, 8192);
  assert.throws(() => harness('gemini', [], { maxOutputTokens: { onboarding: 0, other: 1400 } }), error => error.code === 'INVALID_OUTPUT_LIMIT');
  checks.push('Gemini can use the Claude output limits (8192 onboarding, 1400 afterwards); neither request sets thinking; the browser default stays 8192');

  h = harness('gemini', [ok('gemini')], { thinkingLevel: 'medium', maxOutputTokens: { onboarding: 8192, other: 1400 } });
  await h.run(control);
  assert.deepEqual(h.requests[0].body.generationConfig, { candidateCount: 1, maxOutputTokens: 1400, thinkingConfig: { thinkingLevel: 'medium' } });
  assert.throws(() => harness('gemini', [], { thinkingLevel: 'max' }), error => error.code === 'INVALID_THINKING_LEVEL');
  // The bridge must accept the body the provider sends (fixture image swapped for a real 1x1 PNG).
  h.requests[0].body.contents[0].parts[0].inlineData.data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEcAAAAASUVORK5CYII=';
  const bridgeCheck = spawnSync('python3', ['-c', 'import json,sys,importlib.util as u;s=u.spec_from_file_location("b",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);print(m.validate_message(json.loads(sys.stdin.read())))', path.join(root, 'gemini_bridge.py')],
    { input: JSON.stringify({ model: 'gemini-3.5-flash-lite', ...h.requests[0].body }), encoding: 'utf8' });
  assert.equal(bridgeCheck.stdout.trim(), 'True', bridgeCheck.stderr);
  checks.push('an optional thinkingLevel is sent as generationConfig.thinkingConfig and accepted by gemini_bridge.validate_message; invalid levels are refused');

  // 3. Engine plumbing with the Gemini provider behind a stubbed bridge.
  const rt = createRuntime({ extraSources: ['gemini-provider.js'] }), g = rt.global, sent = [];
  const script = [
    ['inspect_device', { deviceClass: '平面手臂', visibleAxes: 2, modelLabel: 'VLAB-P2', uncertainties: '尺寸未知' }],
    ['list_interfaces', {}],
    ['stop', {}]
  ];
  class HostURL extends URL {}
  Object.assign(g, { URL: HostURL, AbortController, fetch: async (url, init) => {
    const body = JSON.parse(init.body); sent.push({ url, body });
    const [name, args] = script[sent.length - 1];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args: { args, reason: '依據相機影像與工具回覆' } } }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1080, thoughtsTokenCount: 30 } }) };
  } });
  const provider = new g.GeminiAgentProvider({ bridgeUrl: 'http://127.0.0.1:8767', model: 'gemini-3.5-flash-lite', maxCalls: 5, minIntervalMs: 0, maxTransientRetries: 1, maxOutputTokens: { onboarding: 8192, other: 1400 } });
  const engine = new g.PickPlaceExperimentEngine({ seed: 2026, strategy: 'gemini', provider, recordFrames: false, trialCount: 1, device: 'VLAB-P2', manualTemplate: false, controllerMode: 'generated' });
  let state = await engine.initialize();
  for (let step = 0; !state.done && step < 50; step++) state = await engine.next();
  const report = plain(engine.report()); engine.dispose(); rt.close();
  assert.equal(sent.length, 3);
  assert.ok(sent.every(r => r.url === 'http://127.0.0.1:8767/api/gemini/generateContent' && r.body.model === 'gemini-3.5-flash-lite'));
  assert.ok(sent.every(r => r.body.generationConfig.maxOutputTokens === 8192 && !('thinkingConfig' in r.body.generationConfig)));
  assert.equal(report.strategy, 'gemini'); assert.equal(report.model, 'gemini-3.5-flash-lite'); assert.equal(report.modelCalls, 3);
  assert.equal(report.provenance.frontMode, 'gemini-tools');
  assert.deepEqual(report.provenance.usage, { promptTokenCount: 3000, candidatesTokenCount: 150, totalTokenCount: 3240, thoughtsTokenCount: 90 });
  assert.equal(report.modelRuntime.maxTransientRetries, 1);
  checks.push('headless engine with the Gemini provider: bridge route, model and limits in each request; report keeps strategy, model, call count and summed usage including thinking tokens');

  // 4. Runner: Gemini setup errors stop before any bridge or request.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlab-gemini-cli-'));
  try {
    const env = { ...process.env };
    for (const name of ['gemini_api_key', 'GEMINI_API_KEY', 'Gemini_API_Key']) delete env[name];
    let r = runner(['--provider', 'gemini', '--device', 'P2', '--trials', '1', '--out-dir', tmp], env);
    assert.equal(r.status, 2); assert.match(r.result.error, /--model is required with --provider gemini/);
    r = runner(['--provider', 'gemini', '--model', 'gemini-3.5-flash-lite', '--key-env', 'ANTHROPIC_API_KEY', '--device', 'P2'], env);
    assert.equal(r.status, 2); assert.match(r.result.error, /--key-env for gemini must be gemini_api_key/);
    r = runner(['--provider', 'openai', '--device', 'P2'], env);
    assert.equal(r.status, 2); assert.match(r.result.error, /--provider must be claude or gemini/);
    r = runner(['--thinking-level', 'medium', '--device', 'P2'], env);
    assert.equal(r.status, 2); assert.match(r.result.error, /--thinking-level is for --provider gemini/);
    r = runner(['--provider', 'gemini', '--model', 'gemini-3.5-flash-lite', '--thinking-level', 'medium', '--device', 'P2', '--seed', '2026', '--trials', '1', '--out-dir', tmp, '--label', 'nokey', '--port', '8796'], env);
    assert.equal(r.status, 1, r.stdout.slice(-600)); assert.equal(r.result.modelCalls, 0);
    assert.match(r.result.error, /gemini_api_key \/ GEMINI_API_KEY \/ Gemini_API_Key is not set in this environment; no request was sent/);
    const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'nokey.summary.json'), 'utf8'));
    assert.equal(summary.kind, 'live-model-run'); assert.equal(summary.provider, 'gemini'); assert.equal(summary.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(summary.condition.modelSettings.maxOutputTokens, { onboarding: 8192, other: 1400 });
    assert.equal(summary.condition.maxTransientRetries, 1); assert.equal(summary.condition.modelSettings.thinking, 'thinkingLevel medium');
    checks.push('runner --provider gemini: model required, only gemini_api_key accepted, unknown provider rejected, --thinking-level only for gemini; without the key it stops before the bridge with 0 calls and a summary naming provider, model, request limits and thinking level');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const result = { version: '0.7.0', kind: 'offline-node', date: new Date().toISOString().slice(0, 10), node: process.version,
    scope: 'Gemini path of the CLI runner: provider retry and output limits with canned HTTP, headless engine plumbing with a stubbed bridge, runner setup refusals. No key, network, model call or full experiment.',
    passed: true, checks };
  fs.writeFileSync(path.join(root, 'validation', 'v7g-gemini-cli.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
