'use strict';
// Focused offline contract tests. These execute the production DriverRuntime,
// its generated broker and Worker scripts, and SimulatedDeviceLink. A virtual
// clock injects scheduling/delivery faults; the plant only counts commands.
// This does not certify native browser isolation, rendering, or API behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));

class Clock {
  now = 0; nextId = 0; timers = new Map();
  setTimeout = (fn, delay = 0) => {
    const id = ++this.nextId;
    this.timers.set(id, {id, at: this.now + Math.max(0, Number(delay) || 0), fn});
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  runNext() {
    const timer = [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!timer) return false;
    this.timers.delete(timer.id); this.now = timer.at; timer.fn(); return true;
  }
}

function harness(options = {}) {
  const clock = new Clock(), blobs = new Map(), listeners = new Set(), workers = new Set();
  const calls = [], messages = [], plantCommands = [];
  let sequence = 0, activeCall = null, faultPolicy = () => ({}), deliveryHook = () => {}, frame;
  const performance = {now: () => clock.now};
  class ScriptBlob { constructor(parts) { this.source = parts.join(''); } }
  const scriptURLs = {
    createObjectURL(blob) { const key = 'fixture:blob:' + ++sequence; blobs.set(key, blob.source); return key; },
    revokeObjectURL(key) { blobs.delete(key); }
  };
  const dispatch = event => { for (const listener of listeners) listener(event); };
  const schedule = (delay, fn) => delay ? clock.setTimeout(fn, delay) : queueMicrotask(fn);
  class VMWorker {
    constructor(url) {
      this.call = activeCall; this.plan = this.call.plan; this.terminated = false; this.booted = false; this.queue = [];
      workers.add(this); this.call.worker = this;
      const source = blobs.get(url);
      assert.equal(typeof source, 'string', 'Worker must load the production generated source');
      this.context = vm.createContext({setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, performance});
      this.context.self = this.context;
      this.context.postMessage = data => queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({data: plain(data)});
      });
      schedule(this.plan.startupDelay || 0, () => {
        if (this.terminated) return;
        vm.runInContext(source, this.context, {filename: 'production-driver-worker.js', timeout: 500});
        this.booted = true;
        for (const data of this.queue.splice(0)) this.deliver(data);
      });
    }
    deliver(data) {
      schedule(this.plan.executionDelay || 0, () => {
        if (this.terminated) return;
        try {
          this.context.__event = {data: plain(data)};
          const pending = vm.runInContext('self.onmessage(__event)', this.context, {timeout: 500});
          pending?.catch?.(error => this.onerror?.({message: error.message, preventDefault() {}}));
        } catch (error) { this.onerror?.({message: error.message, preventDefault() {}}); }
      });
    }
    postMessage(data) { if (this.booted) this.deliver(data); else this.queue.push(data); }
    terminate() { this.terminated = true; workers.delete(this); }
  }
  function makeFrame() {
    const item = {srcdoc: '', setAttribute() {}, remove() { this.removed = true; }}, innerListeners = new Set();
    const parent = {postMessage(data) {
      const cloned = plain(data), call = calls.find(value => value.id === cloned.id);
      messages.push({at: clock.now, direction: 'broker-parent', data: cloned});
      const delay = cloned.result ? call?.plan.resultDelay || 0 : 0;
      // Already posted messages may arrive after the Worker has terminated.
      schedule(delay, () => {
        if (!item.removed) { dispatch({source: item.contentWindow, data: cloned}); deliveryHook(cloned); }
      });
    }};
    item.contentWindow = {postMessage(data) {
      const cloned = plain(data);
      messages.push({at: clock.now, direction: 'parent-broker', data: cloned});
      queueMicrotask(() => {
        if (item.removed) return;
        if (cloned.type === 'call') {
          activeCall = {...cloned, at: clock.now, plan: plain(faultPolicy(cloned, calls)) || {}};
          calls.push(activeCall);
        }
        for (const listener of innerListeners) listener({source: parent, data: cloned});
        activeCall = null;
      });
    }};
    item.append = () => {
      const source = /<script>([\s\S]*)<\/script>/.exec(item.srcdoc)?.[1];
      assert.ok(source, 'Use the actual generated broker document');
      const context = vm.createContext({parent, Blob: ScriptBlob, URL: scriptURLs, Worker: VMWorker,
        performance, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        addEventListener(name, listener) { if (name === 'message') innerListeners.add(listener); }});
      vm.runInContext(source, context, {filename: 'production-driver-broker.js', timeout: 500});
    };
    return item;
  }
  const document = {
    createElement(name) {
      if (name === 'iframe') return (frame = makeFrame());
      if (name === 'canvas') return {getContext() { return {}; }};
      throw new Error('Unexpected DOM element: ' + name);
    },
    body: {append(item) { item.append(); }}
  };
  const context = vm.createContext({document, performance, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    crypto: {getRandomValues(array) { for (let i = 0; i < array.length; i++) array[i] = ++sequence; return array; }},
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); }});
  for (const file of ['protocols.js', 'device-link.js', 'driver-runtime.js'])
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, {filename: file, timeout: 500});
  const plant = {
    act(command) { plantCommands.push(plain(command)); return {applied: plain(command), limited: false}; },
    frame() { throw new Error('The focused runtime fixture must not request simulation frames.'); }
  };
  const link = new context.SimulatedDeviceLink({plant, seed: 42});
  const manual = link.manual('VLAB-P2'), endpoint = link.inventory().find(item => item.deviceModel === 'VLAB-P2');
  link.connect({endpointId: endpoint.endpointId, ...manual.connection}); link.handshake();
  const runtime = new context.DriverRuntime({timeoutMs: 100, startupTimeoutMs: 100, ...options});
  async function settle(promise) {
    let complete = false, result, failure;
    Promise.resolve(promise).then(value => {complete = true; result = value;}, error => {complete = true; failure = error;});
    for (let steps = 0; steps < 5000; steps++) {
      // Drain the complete native microtask queue before advancing virtual
      // time; a fixed number of Promise ticks can manufacture false timeouts.
      await new Promise(setImmediate);
      if (complete) { if (failure) throw failure; return result; }
      // A compound dry run can be between awaited operations with only native
      // Promise jobs queued. Let those jobs schedule the next bounded request.
      clock.runNext();
    }
    throw new Error('Fixture exceeded its bounded scheduling steps.');
  }
  async function prepare() {
    await settle(runtime.compile(manual.sampleDriverSource));
    const result = await settle(runtime.test(link));
    assert.equal(result.passed, true, JSON.stringify(result));
    return result;
  }
  return {clock, runtime, link, calls, messages, plantCommands, settle, prepare, manual,
    faults(policy) { faultPolicy = policy; },
    afterDelivery(hook) { deliveryHook = hook; },
    actualTX() { return plain(link.traffic()).filter(item => item.direction === 'TX' && !item.dryRun && JSON.parse(item.wire).op !== 'hello'); },
    close() { runtime.dispose(); for (const worker of workers) worker.terminate(); clock.timers.clear(); },
    frame: () => frame};
}

const results = [];
async function check(name, body) {
  const start = Date.now();
  const detail = await body();
  results.push({name, passed: true, wallMilliseconds: Date.now() - start, ...detail});
  process.stdout.write('PASS ' + name + '\n');
}
async function withFixture(body, options) {
  const fixture = harness(options);
  try { return await body(fixture); } finally { fixture.close(); }
}
async function rejectCode(fixture, promise, expected) {
  let error;
  try { await fixture.settle(promise); } catch (caught) { error = caught; }
  assert.ok(error, 'Operation must fail'); assert.equal(error.code, expected, error.message);
  return error;
}

(async () => {
  await check('production sample driver validates XY, lift, grip without actuation', () => withFixture(async f => {
    const result = await f.prepare();
    assert.equal(f.plantCommands.length, 0); assert.equal(f.actualTX().length, 0);
    const commands = plain(f.link.traffic()).filter(item => item.direction === 'TX' && item.dryRun).map(item => {
      try { return JSON.parse(item.wire); } catch { return null; }
    });
    for (const target of [{op:'lift',position:'up'}, {op:'lift',position:'down'}, {op:'grip',state:'open'}, {op:'grip',state:'closed'}])
      assert.ok(commands.some(command => JSON.stringify(command) === JSON.stringify(target)));
    assert.ok(commands.some(command => command?.op === 'step' && command.channels[0] === 0.1 && command.channels[1] === -0.1));
    for (const command of [[0.02,-0.01], {op:'lift',position:'up'}, {op:'grip',state:'closed'}]) {
      const ack = await f.settle(f.runtime.act(command, f.link));
      assert.deepEqual(plain(ack.applied), command); assert.equal(ack.driverError, undefined);
    }
    assert.equal(f.plantCommands.length, 3); assert.equal(f.actualTX().length, 3);
    return {dryRunChecks: result.tests.length, actualCommandCount: 3};
  }));

  await check('startup and execution receive separate bounded deadlines', () => withFixture(async f => {
    await f.prepare();
    f.faults(call => call.operation === 'encode' ? {startupDelay:90,executionDelay:70} : {});
    const before = f.clock.now, ack = await f.settle(f.runtime.act([0.02,0], f.link));
    assert.deepEqual(plain(ack.applied), [0.02,0]); assert.equal(f.clock.now - before, 160);
    assert.equal(f.actualTX().length, 1); assert.equal(f.runtime.diagnostics.retries, 0);
    return {startupMs:90, executionMs:70, perPhaseDeadlineMs:100, actualCommandCount:1};
  }));

  await check('one encode startup failure retries with exactly one physical command', () => withFixture(async f => {
    await f.prepare(); let encodes = 0;
    f.faults(call => call.operation === 'encode' && ++encodes === 1 ? {startupDelay:200} : {});
    const ack = await f.settle(f.runtime.act([0.02,0], f.link));
    assert.deepEqual(plain(ack.applied), [0.02,0]); assert.equal(encodes, 2);
    assert.equal(f.actualTX().length, 1); assert.equal(f.plantCommands.length, 1);
    assert.equal(f.runtime.diagnostics.retries, 1);
    return {encodeAttempts:2, actualCommandCount:1};
  }));

  await check('two encode startup failures exhaust recovery without transmission', () => withFixture(async f => {
    await f.prepare(); let encodes = 0;
    f.faults(call => { if (call.operation !== 'encode') return {}; encodes++; return {startupDelay:200}; });
    const error = await rejectCode(f, f.runtime.act([0.02,0], f.link), 'DRIVER_STARTUP_TIMEOUT');
    assert.equal(encodes, 2); assert.equal(f.actualTX().length, 0); assert.equal(f.plantCommands.length, 0);
    assert.equal(error.diagnostic.phase, 'startup'); assert.equal(error.diagnostic.attempt, 2);
    return {encodeAttempts:2, actualCommandCount:0};
  }));

  await check('encode execution timeout never retries or transmits', () => withFixture(async f => {
    await f.prepare(); let encodes = 0;
    f.faults(call => { if (call.operation !== 'encode') return {}; encodes++; return {executionDelay:200}; });
    const error = await rejectCode(f, f.runtime.act([0.02,0], f.link), 'DRIVER_EXECUTION_TIMEOUT');
    assert.equal(error.diagnostic.phase, 'execution'); assert.equal(encodes, 1);
    assert.equal(f.actualTX().length, 0); assert.equal(f.runtime.diagnostics.retries, 0);
    return {encodeAttempts:1, actualCommandCount:0};
  }));

  await check('decode timeout preserves actual ACK, invalidates driver, and never resends', () => withFixture(async f => {
    await f.prepare(); let decodes = 0;
    f.faults(call => { if (call.operation !== 'decode') return {}; decodes++; return {executionDelay:200}; });
    const ack = await f.settle(f.runtime.act([0.02,0], f.link));
    assert.deepEqual(plain(ack.applied), [0.02,0]); assert.equal(ack.limited, false);
    assert.equal(ack.driverErrorCode, 'DRIVER_DECODE_AFTER_MOVEMENT'); assert.match(ack.driverError, /DRIVER_EXECUTION_TIMEOUT/);
    assert.equal(decodes, 1); assert.equal(f.actualTX().length, 1); assert.equal(f.plantCommands.length, 1);
    assert.equal(f.runtime.passed, false); assert.equal(f.runtime.diagnostics.retries, 0);
    await assert.rejects(f.settle(f.runtime.act([0.02,0], f.link)), /DRIVER_NOT_VALIDATED/);
    assert.equal(f.actualTX().length, 1);
    return {decodeAttempts:1, actualCommandCount:1, actualAckPreserved:true};
  }));

  await check('late result cannot complete a newer request or send stale movement', () => withFixture(async f => {
    await f.prepare(); let encodes = 0;
    f.faults(call => {
      if (call.operation !== 'encode') return {};
      return ++encodes === 1 ? {resultDelay:160} : {executionDelay:80};
    });
    await rejectCode(f, f.runtime.act([0.02,0], f.link), 'DRIVER_EXECUTION_TIMEOUT');
    assert.equal(f.clock.now, 100); assert.equal(f.actualTX().length, 0);
    const ack = await f.settle(f.runtime.act([0,-0.025], f.link));
    assert.deepEqual(plain(ack.applied), [0,-0.025]); assert.equal(f.clock.now, 180);
    assert.deepEqual(f.plantCommands, [[0,-0.025]]); assert.equal(f.actualTX().length, 1);
    return {lateResultAtMs:160, secondRequestCompletedAtMs:180, actualCommandCount:1};
  }));

  await check('dispose during startup cancels pending work and prohibits recovery', () => withFixture(async f => {
    await f.prepare(); let encodes = 0;
    f.faults(call => { if (call.operation !== 'encode') return {}; encodes++; return {startupDelay:200}; });
    f.clock.setTimeout(() => f.runtime.dispose(), 50);
    await rejectCode(f, f.runtime.act([0.02,0], f.link), 'DRIVER_DISPOSED');
    assert.equal(encodes, 1); assert.equal(f.actualTX().length, 0); assert.equal(f.plantCommands.length, 0);
    assert.equal(f.runtime.diagnostics.retries, 0); assert.equal(f.runtime.passed, false);
    return {encodeAttempts:1, actualCommandCount:0};
  }));

  await check('dispose after successful encoding prevents the pending physical transmission', () => withFixture(async f => {
    await f.prepare(); let interrupted = false;
    f.afterDelivery(message => {
      const call = f.calls.find(item => item.id === message.id);
      if (call?.operation === 'encode' && message.result?.ok === true) {
        interrupted = true;
        // The host already accepted and resolved the encode result, but the
        // async act continuation has not yet reached exchange().
        f.runtime.dispose();
      }
    });
    await rejectCode(f, f.runtime.act([0.02,0], f.link), 'DRIVER_DISPOSED');
    assert.equal(interrupted, true); assert.equal(f.actualTX().length, 0); assert.equal(f.plantCommands.length, 0);
    return {encodeResultReceived:true, actualCommandCount:0};
  }));

  await check('malformed ACK dry run fails when rejection is actually a runtime timeout', () => withFixture(async f => {
    await f.settle(f.runtime.compile(f.manual.sampleDriverSource));
    let malformedCallId = null;
    // Source/payload is deliberately absent from the startup call. Associate
    // the known malformed-ACK operation with its sequence after valid tests:
    // eight roundtrips and one limited-ACK decode precede malformed fixtures.
    // Identify it from observed execute messages, not a fake driver outcome.
    const originalPost = f.frame().contentWindow.postMessage;
    f.frame().contentWindow.postMessage = function(data, origin) {
      if (data.type === 'execute' && data.operation === 'decode' && data.payload === 'not-json\n') {
        malformedCallId = data.id;
        const call = f.calls.find(value => value.id === data.id);
        call.worker.plan.executionDelay = 200;
      }
      return originalPost.call(this, data, origin);
    };
    const report = await f.settle(f.runtime.test(f.link));
    assert.ok(malformedCallId); assert.equal(report.passed, false); assert.equal(f.runtime.passed, false);
    assert.ok(report.tests.some(item => !item.passed && /DRIVER_EXECUTION_TIMEOUT/.test(item.detail)), JSON.stringify(report));
    const failed = report.tests.find(item => !item.passed && /DRIVER_EXECUTION_TIMEOUT/.test(item.detail));
    assert.equal(failed.driverErrorCode, 'DRIVER_EXECUTION_TIMEOUT');
    assert.equal(failed.driverDiagnostic.phase, 'execution');
    assert.equal(failed.driverDiagnostic.operation, 'decode');
    assert.equal(f.actualTX().length, 0); assert.equal(f.plantCommands.length, 0);
    return {dryRunPassed:false, actualCommandCount:0};
  }));

  const report = {schema:'v62-driver-runtime-regression/1', passed:true, testCount:results.length,
    scope:'Focused deterministic VM tests of production driver runtime, generated broker/worker, and device link; no browser, model API, network, credentials, or full mission suite.',
    limitations:['Does not reproduce the unknown real-browser scheduling cause of the V6.1 five-second timeout.',
      'Does not certify browser CSP/Worker isolation or completion of five pick-and-place trials.'], tests:results};
  fs.mkdirSync(path.join(root, 'validation'), {recursive:true});
  fs.writeFileSync(path.join(root, 'validation', 'v62-driver-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({passed:true, testCount:results.length}) + '\n');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
