'use strict';
// Focused offline scheduler tests. Actual production Claude/Gemini providers
// run in a VM with a virtual clock and canned HTTP responses. No credentials,
// network, browser, model service, or device actuation are used by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const credentialCanary = 'FAKE_TEST_KEY_NO_CREDENTIAL';
const rawCanary = 'PRIVATE_RESPONSE_BODY_MUST_NOT_BE_EXPORTED';
const frame = {dataURL: 'data:image/png;base64,aGVsbG8='};
const context = {phase: 'control', allowedTools: ['observe', 'move', 'probe', 'stop'],
  observation: {tip: [10, 10], target: [20, 20], error: 14.14},
  budgets: {actionsUsed: 0, maxActions: 180, decisionsUsed: 0, maxDecisions: 500}};
const drain = () => new Promise(setImmediate);

class Clock {
  now = 0; nextId = 0; timers = new Map();
  setTimeout = (fn, delay = 0) => {
    const id = ++this.nextId;
    this.timers.set(id, {id, at: this.now + Math.max(0, Number(delay) || 0), fn});
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  next() {return [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];}
  async advance(ms) {
    const target = this.now + ms;
    for (let steps = 0; steps < 2000; steps++) {
      await drain();
      const timer = this.next();
      if (!timer || timer.at > target) {this.now = target; await drain(); return;}
      this.timers.delete(timer.id); this.now = timer.at; timer.fn();
    }
    throw new Error('Virtual clock exceeded bounded scheduling steps.');
  }
  async settle(promise) {
    let done = false, result, failure;
    Promise.resolve(promise).then(value => {done = true; result = value;}, error => {done = true; failure = error;});
    for (let steps = 0; steps < 2000; steps++) {
      // A complete native microtask drain is required before moving time;
      // a fixed Promise-tick count can incorrectly fire a request timeout.
      await drain();
      if (done) {if (failure) throw failure; return result;}
      const timer = this.next();
      if (timer) {this.timers.delete(timer.id); this.now = timer.at; timer.fn();}
    }
    throw new Error('Request never settled in the focused fake-clock fixture.');
  }
}

function answer(kind, name = 'observe', args = {}) {
  const input = {args, reason: '依照本次影像選擇工具'};
  return kind === 'claude' ? {stop_reason: 'tool_use', content: [{type: 'tool_use', name, input}], usage: {input_tokens: 12, output_tokens: 8}} :
    {candidates: [{finishReason: 'STOP', content: {parts: [{functionCall: {name, args: input}}]}}], usageMetadata: {promptTokenCount: 12, candidatesTokenCount: 8}};
}
const ok = (kind, name, args, delay = 0) => ({status: 200, body: answer(kind, name, args), delay});
function limited(kind, seconds = '12', error = {}) {
  return {status: 429, headers: seconds === null ? {} : {'retry-after': seconds},
    body: {error: {type: 'rate_limit_error', status: 'RESOURCE_EXHAUSTED', message: rawCanary + credentialCanary, ...error}}};
}
function harness(kind, responses, options = {}) {
  const clock = new Clock(), requests = [], statuses = [];
  const epoch = Date.UTC(2026, 9, 12, 0, 0, 0);
  class MockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [epoch + clock.now]));}
    static now() {return epoch + clock.now;}
  }
  const mockFetch = async (url, init) => {
    const plan = responses[requests.length];
    const body = JSON.parse(init.body);
    const parts = kind === 'claude' ? body.messages[0].content : body.contents[0].parts;
    const evidenceText = parts.find(part => typeof part.text === 'string').text;
    const evidence = JSON.parse(evidenceText.slice(evidenceText.indexOf('{'), evidenceText.lastIndexOf('}') + 1));
    requests.push({at: clock.now, url, signal: init.signal, modelRequests: evidence.modelRequests});
    assert.ok(plan, 'An unexpected extra model request was issued.');
    if (plan.delay || plan.hang) await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('fixture fetch aborted'));
      if (init.signal.aborted) {abort(); return;}
      init.signal.addEventListener('abort', abort, {once: true});
      if (!plan.hang) clock.setTimeout(() => {init.signal.removeEventListener('abort', abort); resolve();}, plan.delay);
    });
    const headers = Object.fromEntries(Object.entries(plan.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    return {ok: plan.status >= 200 && plan.status < 300, status: plan.status,
      headers: {get(name) {return headers[name.toLowerCase()] ?? null;}}, json: async () => plain(plan.body)};
  };
  const box = vm.createContext({fetch: mockFetch, URL, URLSearchParams, AbortController,
    Date: MockDate, performance: {now: () => clock.now}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout});
  for (const file of ['claude-provider.js', ...(kind === 'gemini' ? ['gemini-provider.js'] : [])])
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), box, {filename: file, timeout: 1000});
  const Provider = box[kind === 'claude' ? 'ClaudeAgentProvider' : 'GeminiAgentProvider'];
  const provider = new Provider({apiKey: credentialCanary, model: kind + '-mock-1',
    onRequestStatus: status => statuses.push(plain(status)), ...options});
  const begin = () => {
    const promise = provider.decide(context, frame);
    // Attach a rejection observer immediately so advancing virtual time never
    // creates an unhandled rejection before the assertion consumes it.
    promise.catch(() => {}); return promise;
  };
  const finish = async promise => {try {return {value: await clock.settle(promise)};} catch (error) {return {error};}};
  return {clock, provider, requests, statuses, begin, finish, epoch};
}

async function reject(h, promise, code) {
  const result = await h.finish(promise);
  assert.ok(result.error, 'Expected a typed rejection.');
  if (Array.isArray(code)) assert.ok(code.includes(result.error.code), result.error.code);
  else assert.equal(result.error.code, code);
  return result.error;
}

(async () => {
  const checks = [];
  const group = async (name, test) => {for (const kind of ['claude', 'gemini']) await test(kind); checks.push(name);};

  await group('Start-to-start spacing, BUSY while waiting, and no added delay after a slow response', async kind => {
    let h = harness(kind, [ok(kind), ok(kind)]);
    await h.clock.settle(h.begin());
    const pending = h.begin(); await drain();
    assert.equal(h.provider.requestStatus.phase, 'spacing');
    await reject(h, h.begin(), 'BUSY');
    await h.clock.advance(5999); assert.equal(h.requests.length, 1);
    await h.clock.advance(1); assert.equal((await h.clock.settle(pending)).tool, 'observe');
    assert.deepEqual(h.requests.map(request => request.at), [0, 6000]);
    assert.equal(h.provider.calls, 2);
    h = harness(kind, [ok(kind, 'observe', {}, 8000), ok(kind)]);
    await h.clock.settle(h.begin()); await h.clock.settle(h.begin());
    assert.deepEqual(h.requests.map(request => request.at), [0, 8000]);
  });

  await group('429 honors Retry-After seconds and HTTP dates before returning one validated proposal', async kind => {
    for (const header of ['12', new Date(Date.UTC(2026, 9, 12, 0, 0, 12)).toUTCString()]) {
      const h = harness(kind, [limited(kind, header), ok(kind, 'move', {scale: 0.7})]);
      const pending = h.begin(); await drain();
      assert.equal(h.provider.requestStatus.phase, 'cooldown');
      await reject(h, h.begin(), 'BUSY');
      await h.clock.advance(11999); assert.equal(h.requests.length, 1);
      const result = await h.clock.settle(pending);
      assert.equal(result.tool, 'move'); assert.deepEqual(plain(result.args), {scale: 0.7});
      assert.deepEqual(h.requests.map(request => request.at), [0, 12000]);
      assert.equal(h.provider.calls, 2); assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 1);
      assert.equal(h.provider.requestStatus.phase, 'idle');
    }
  });

  await group('At most two retries; every generation attempt consumes the existing call budget', async kind => {
    let h = harness(kind, Array.from({length: 3}, () => limited(kind, '1')), {minIntervalMs: 0});
    await reject(h, h.begin(), 'RATE_LIMITED');
    assert.equal(h.requests.length, 3); assert.equal(h.provider.calls, 3);
    assert.deepEqual(h.requests.map(request => request.modelRequests.used), [0, 1, 2]);
    assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 2);
    h = harness(kind, [limited(kind, '1'), limited(kind, '1')], {maxCalls: 2, minIntervalMs: 0});
    await reject(h, h.begin(), 'CALL_BUDGET');
    assert.equal(h.requests.length, 2); assert.equal(h.provider.calls, 2);
    h = harness(kind, [limited(kind, '12')], {maxCalls: 1});
    await reject(h, h.begin(), 'CALL_BUDGET');
    assert.equal(h.requests.length, 1); assert.equal(h.provider.calls, 1);
    assert.equal(h.clock.now, 0); assert.equal(h.provider.requestDiagnostics.waitMs, 0);
    assert.ok(!h.statuses.some(status => status.phase === 'cooldown'));
    h = harness(kind, [limited(kind, '1')], {maxRateLimitRetries: 0});
    const disabled = await h.finish(h.begin()); assert.ok(disabled.error);
    assert.equal(h.requests.length, 1); assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 0);
  });

  await group('Bridge call budget is terminal and cannot be retried as a temporary 429', async kind => {
    const h = harness(kind, [limited(kind, '1', {code: 'BRIDGE_CALL_BUDGET'})], {bridgeUrl: 'http://127.0.0.1:8766'});
    await reject(h, h.begin(), 'BRIDGE_CALL_BUDGET');
    assert.equal(h.requests.length, 1); assert.equal(h.provider.calls, 1);
    assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 0);
  });

  await group('Daily, spending, and zero quota signals are terminal without automatic retries', async kind => {
    const quotaFailure = violation => ({details: [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [violation]}]});
    const cases = kind === 'claude' ? [
      {error: {quotaKind: 'daily', retryable: false}, bridge: true},
      {error: {details: {error_code: 'enforced_spend_limit_reached'}}},
      {error: {quotaKind: 'unavailable', retryable: false}, bridge: true}
    ] : [
      {error: quotaFailure({quotaId: 'GenerateRequestsPerDayPerProject'})},
      {error: {code: 'QUOTA_EXCEEDED', quotaKind: 'spend', retryable: false}, bridge: true},
      {error: quotaFailure({quotaId: 'GenerateRequestsPerMinutePerProject', quotaValue: '0'})}
    ];
    for (const item of cases) {
      const h = harness(kind, [limited(kind, '1', item.error)], item.bridge ? {bridgeUrl: 'http://127.0.0.1:8766'} : {});
      await reject(h, h.begin(), 'QUOTA_EXCEEDED');
      assert.equal(h.requests.length, 1); assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 0);
    }
  });

  await group('Server waits over 180 seconds stop explicitly and are never shortened into an early retry', async kind => {
    const h = harness(kind, [limited(kind, '181')]);
    const result = await h.finish(h.begin()); assert.ok(result.error);
    assert.equal(h.requests.length, 1); assert.equal(h.provider.requestDiagnostics.rateLimitRetries, 0);
    await h.clock.advance(181000); assert.equal(h.requests.length, 1);
  });

  await group('Abort during cooldown or spacing cancels waiting and prevents another fetch', async kind => {
    const immediate = harness(kind, []);
    const unsent = immediate.begin(); immediate.provider.abort();
    await reject(immediate, unsent, 'ABORTED');
    assert.equal(immediate.requests.length, 0); assert.equal(immediate.provider.calls, 0);
    assert.equal(immediate.provider.requestDiagnostics.requests, 0);
    for (const phase of ['cooldown', 'spacing']) {
      const h = harness(kind, phase === 'cooldown' ? [limited(kind, '60')] : [ok(kind)]);
      if (phase === 'spacing') await h.clock.settle(h.begin());
      const pending = h.begin(); await drain();
      assert.equal(h.provider.requestStatus.phase, phase);
      h.provider.abort(); await reject(h, pending, 'ABORTED');
      await h.clock.advance(180000);
      assert.equal(h.requests.length, 1); assert.equal(h.provider.calls, 1);
      assert.equal(h.provider.requestStatus.phase, 'idle');
    }
  });

  await group('Cooldown is outside the HTTP timeout; actual request timeout remains enforced', async kind => {
    let h = harness(kind, [limited(kind, '60'), ok(kind, 'observe', {}, 44000)], {timeoutMs: 45000});
    assert.equal((await h.clock.settle(h.begin())).tool, 'observe');
    assert.deepEqual(h.requests.map(request => request.at), [0, 60000]);
    assert.equal(h.clock.now, 104000);
    h = harness(kind, [limited(kind, '60'), {status: 200, hang: true}], {timeoutMs: 45000, maxTransientRetries: 0});
    await reject(h, h.begin(), 'TIMEOUT');
    assert.equal(h.requests.length, 2); assert.equal(h.clock.now, 105000);
  });

  await group('A recovered HTTP request still obeys tool bounds; invalid decisions receive no transport retry', async kind => {
    const h = harness(kind, [limited(kind, '1'), ok(kind, 'probe', {channel: 0, direction: 1, amplitude: 0.11})], {minIntervalMs: 0});
    const error = await reject(h, h.begin(), 'INVALID_ARGUMENTS');
    assert.equal(error.diagnostic.issue, 'invalid-arguments');
    assert.equal(h.requests.length, 2); assert.equal(h.provider.calls, 2);
  });

  {
    // Claude resends a model request once after a timeout or HTTP 500/502/504/529.
    // Each attempt is counted against the call budget; Gemini keeps no retry.
    const server = {status: 502, body: {error: {type: 'api_error', message: 'upstream'}}};
    let h = harness('claude', [server, ok('claude')]);
    assert.equal((await h.clock.settle(h.begin())).tool, 'observe');
    assert.deepEqual(h.requests.map(request => request.at), [0, 10000]);
    assert.equal(h.provider.calls, 2); assert.equal(h.provider.requestDiagnostics.transientRetries, 1);
    h = harness('claude', [server, server]);
    await reject(h, h.begin(), 'HTTP_502'); assert.equal(h.requests.length, 2); assert.equal(h.provider.calls, 2);
    h = harness('claude', [{status: 200, hang: true}, ok('claude')], {timeoutMs: 45000});
    assert.equal((await h.clock.settle(h.begin())).tool, 'observe');
    assert.deepEqual(h.requests.map(request => request.at), [0, 55000]);
    h = harness('claude', [{status: 400, body: {error: {type: 'invalid_request_error', message: 'bad'}}}]);
    await reject(h, h.begin(), 'HTTP_400'); assert.equal(h.requests.length, 1);
    h = harness('claude', [server], {maxCalls: 1});
    await reject(h, h.begin(), 'CALL_BUDGET'); assert.equal(h.requests.length, 1); assert.equal(h.provider.calls, 1);
    h = harness('claude', [server], {maxTransientRetries: 0});
    await reject(h, h.begin(), 'HTTP_502'); assert.equal(h.requests.length, 1);
    h = harness('gemini', [server]);
    await reject(h, h.begin(), 'HTTP_502'); assert.equal(h.requests.length, 1);
    checks.push('Claude resends a model request once after a timeout or HTTP 5xx (500/502/504/529), counted in the call budget; 4xx, an exhausted budget, maxTransientRetries 0 and Gemini get no resend');
  }

  await group('Request diagnostics and wait status remain bounded and omit keys and raw HTTP errors', async kind => {
    const h = harness(kind, [limited(kind, '1'), ...Array.from({length: 44}, () => ok(kind))], {minIntervalMs: 0});
    for (let index = 0; index < 44; index++) await h.clock.settle(h.begin());
    const diagnostic = plain(h.provider.requestDiagnostics);
    assert.equal(diagnostic.requests, 45); assert.equal(diagnostic.rateLimitRetries, 1);
    assert.ok(Array.isArray(diagnostic.recent) && diagnostic.recent.length <= 40);
    const exported = JSON.stringify({diagnostic, statuses: h.statuses});
    assert.ok(!exported.includes(credentialCanary)); assert.ok(!exported.includes(rawCanary));
    assert.equal(h.requests.length, 45);
  });

  const report = {version: '0.6.3', scope: 'Focused offline tests of actual production provider code with canned HTTP and a virtual clock. No API keys, network, browser, device actuation, or complete five-trial experiment.',
    passed: true, providers: ['claude', 'gemini'], groups: checks.length, checks};
  fs.mkdirSync(path.join(root, 'validation'), {recursive: true});
  fs.writeFileSync(path.join(root, 'validation', 'v63-provider-pacing.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => {console.error(error); process.exitCode = 1;});
