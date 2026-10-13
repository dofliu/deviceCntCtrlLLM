(function (global) {
  'use strict';
  // Generated XY controller modules: contract, host-side validation, a
  // synthetic isolation test, and the offline REFERENCE module. A controller is
  // a stateless JavaScript function control(state) executed in the same opaque
  // sandbox as generated drivers. It never touches the device: the host turns
  // its bounded output into a driver command and records the camera result.
  const LIMIT = 0.1, TOLERANCE = 7, HISTORY = 40;
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const finite = v => typeof v === 'number' && Number.isFinite(v);

  const CONTRACT = [
    '定義 JavaScript function control(state)，每次獨立執行（不可依賴全域狀態、時間、亂數或網路），回傳下一步決策。',
    'state = {tip:[x,y], target:[x,y], errorPx, tolerancePx:7, inputLimit:0.1, step, maxActions, history:[{command:[a,b], applied:[a,b], delta:[dx,dy], limited}]}。',
    'tip／target 是相機像素；history 依時間排序（最舊在前，最多 40 筆），applied 是設備 ACK 實際接受的輸入，delta 是同一步前後影像中末端的像素位移。',
    '通道與像素的對應、方向、增益與耦合都未知，且可能在執行中改變（例如某通道反向）；只能從 history 推估。',
    '回傳 {action:"move", u:[a,b]}（|a|,|b| ≤ 0.1 的有限數值）、{action:"verify"}（認為已在 tolerancePx 內，主機會重新拍攝驗證）或 {action:"stop", reason}。',
    '違反格式、超出範圍或拋出例外時主機不送出任何動作並停止。設備遇行程限制會回覆較小的 applied 與 limited:true。',
    'inputLimit（0.1）是每個通道每步的上限，可以使用到上限；設備在行程邊界會自行縮小並回覆 limited，不會因此損壞。動作數是評估指標：遠離目標時應讓 u 的最大分量接近 0.1，接近目標時再縮小；不要另設更小的固定步長上限。',
    '程式須先通過主機以合成設備進行的隔離測試（不同旋轉、交換、反向、非線性、行程限制與中途反向），才會用於真實模擬設備。測試報告另列各案例相對預寫參考模組的動作數倍率（efficiency），只供改進參考，不影響是否通過。'
  ].join('\n');

  // Offline reference controller. It is a hand-written baseline used by the
  // offline policy; reports label it as such, never as model-generated code.
  const REFERENCE_SOURCE = `function control(state) {
  const tol = state.tolerancePx, lim = state.inputLimit;
  const e = [state.target[0] - state.tip[0], state.target[1] - state.tip[1]];
  const err = Math.hypot(e[0], e[1]);
  if (err <= tol - 1) return {action: 'verify'};
  const raw = Array.isArray(state.history) ? state.history : [];
  const usable = raw.filter(h => Array.isArray(h.applied) && Array.isArray(h.delta) && Math.hypot(h.applied[0], h.applied[1]) > 1e-4).slice(-16);
  const fit = samples => {
    let a = 0, b = 0, d = 0; const n = [[0, 0], [0, 0]];
    for (const s of samples) {
      const u = s.applied; a += u[0] * u[0]; b += u[0] * u[1]; d += u[1] * u[1];
      for (let r = 0; r < 2; r++) { n[r][0] += s.delta[r] * u[0]; n[r][1] += s.delta[r] * u[1]; }
    }
    const det = a * d - b * b, tr = a + d;
    if (!(tr > 1e-6) || det / (tr * tr) < 0.02) return null;
    return n.map(r => [(r[0] * d - r[1] * b) / det, (r[1] * a - r[0] * b) / det]);
  };
  const predict = (J, u) => [J[0][0] * u[0] + J[0][1] * u[1], J[1][0] * u[0] + J[1][1] * u[1]];
  // Grow a window backwards from the newest sample while older samples agree
  // with the mapping fitted to the newer ones; a disagreement marks a change.
  const win = [];
  for (let i = usable.length - 1; i >= 0 && win.length < 10; i--) {
    const J = win.length >= 2 ? fit(win) : null;
    if (J) {
      const p = predict(J, usable[i].applied), r = Math.hypot(usable[i].delta[0] - p[0], usable[i].delta[1] - p[1]);
      if (r > Math.max(5, 0.5 * Math.hypot(p[0], p[1]))) break;
    }
    win.unshift(usable[i]);
  }
  const J = fit(win);
  const last = raw[raw.length - 1];
  const probe = () => {
    let p = [0.04, 0];
    if (win.length) {
      const m = win.reduce((s, h) => [s[0] + h.applied[0], s[1] + h.applied[1]], [0, 0]);
      const n = Math.hypot(m[0], m[1]) || 1;
      p = [-0.04 * m[1] / n, 0.04 * m[0] / n];
    }
    if (last && last.limited && Array.isArray(last.command) && Math.hypot(last.applied[0], last.applied[1]) <= 1e-4 &&
        last.command[0] * p[0] + last.command[1] * p[1] > 0) p = [-p[0], -p[1]];
    return {action: 'move', u: p};
  };
  if (!J) return probe();
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return probe();
  const gain = Math.min(0.8, 30 / err);
  const g = [e[0] * gain, e[1] * gain];
  let u = [(J[1][1] * g[0] - J[0][1] * g[1]) / det, (-J[1][0] * g[0] + J[0][0] * g[1]) / det];
  const scale = Math.min(1, lim / Math.max(1e-9, Math.abs(u[0]), Math.abs(u[1])));
  u = u.map(v => v * scale);
  if (!u.every(Number.isFinite)) return probe();
  return {action: 'move', u};
}`;

  function validateDecision(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTROLLER_OUTPUT: control(state) must return an object.');
    if (value.action === 'verify') return {action: 'verify'};
    if (value.action === 'stop') return {action: 'stop', reason: String(value.reason || '').slice(0, 300)};
    if (value.action === 'move') {
      const u = value.u;
      if (!Array.isArray(u) || u.length !== 2 || !u.every(finite) || u.some(v => Math.abs(v) > LIMIT + 1e-12))
        throw new Error('CONTROLLER_OUTPUT: move.u must be two finite numbers within ±0.1.');
      return {action: 'move', u: u.slice()};
    }
    throw new Error('CONTROLLER_OUTPUT: action must be move, verify or stop.');
  }

  function state({tip, target, history, step, maxActions}) {
    return {tip: tip.slice(), target: target.slice(), errorPx: Math.hypot(target[0] - tip[0], target[1] - tip[1]),
      tolerancePx: TOLERANCE, inputLimit: LIMIT, step, maxActions, history: copy(history.slice(-HISTORY))};
  }

  // Synthetic isolation cases. These are not the evaluated device: they are a
  // gate that a candidate must clear before any real (simulated) actuation.
  const CASES = [
    {name: '旋轉 0.3 rad、正向通道', theta: 0.3, gains: [150, 170], swap: false, signs: [1, 1], start: [200, 300], targets: [[420, 180]]},
    {name: '通道交換且 A 反向', theta: -0.6, gains: [120, 190], swap: true, signs: [-1, 1], start: [480, 120], targets: [[260, 330]]},
    {name: '大角度旋轉與 B 反向', theta: 2.2, gains: [200, 110], swap: false, signs: [1, -1], start: [320, 380], targets: [[150, 140]]},
    {name: '位置相依的非線性映射', theta: 0.9, gains: [160, 160], swap: false, signs: [1, 1], curvature: 0.6, start: [120, 120], targets: [[500, 360]]},
    {name: '到達後通道 A 反向的恢復', theta: -1.2, gains: [140, 175], swap: true, signs: [1, 1], start: [300, 200], targets: [[460, 320], [180, 140]], flipAfterFirst: 0},
    {name: '起點貼近行程邊界', theta: Math.PI, gains: [150, 150], swap: false, signs: [1, 1], start: [21, 240], targets: [[300, 260]]}
  ];

  function simulateCase(spec) {
    const signs = spec.signs.slice();
    const map = (tip, u) => {
      const theta = spec.theta + (spec.curvature || 0) * (tip[0] - 320) / 320;
      const c = Math.cos(theta), s = Math.sin(theta);
      const ordered = spec.swap ? [u[1], u[0]] : u;
      const w = [ordered[0] * spec.gains[0] * signs[0], ordered[1] * spec.gains[1] * signs[1]];
      return [c * w[0] - s * w[1], s * w[0] + c * w[1]];
    };
    return {
      signs, map,
      step(tip, command) {
        let applied = command.slice(), limited = false, delta = map(tip, applied);
        const next = [tip[0] + delta[0], tip[1] + delta[1]];
        let scale = 1;
        for (const [value, low, high, base] of [[next[0], 20, 620, tip[0]], [next[1], 20, 460, tip[1]]]) {
          if (value < low) scale = Math.min(scale, Math.max(0, (low - base) / (value - base)));
          if (value > high) scale = Math.min(scale, Math.max(0, (high - base) / (value - base)));
        }
        if (scale < 1) { applied = applied.map(v => v * scale); limited = true; delta = map(tip, applied); }
        return {applied, limited, tip: [tip[0] + delta[0], tip[1] + delta[1]], delta};
      }
    };
  }

  // Reference action counts per case, used only to report efficiency. The
  // reference is the trusted, hand-written baseline above, so it runs on the
  // host; generated code never does.
  let referenceRun = null;
  function referenceCounts() {
    if (!referenceRun) {
      const control = new Function('"use strict";\n' + REFERENCE_SOURCE + '\n;return control;')();
      referenceRun = runCases(async value => control(value), {}).then(result => result.cases.map(c => c.passed ? c.actions : null));
    }
    return referenceRun;
  }

  // decide(state) is the sandboxed generated controller call. Pass/fail is
  // decided only by reaching every target; efficiency is informational.
  async function isolationTest(decide, options = {}) {
    const result = await runCases(decide, options), reference = await referenceCounts();
    let actions = 0, referenceActions = 0;
    result.cases.forEach((c, i) => {
      const ref = reference[i];
      c.referenceActions = ref;
      c.actionRatio = c.passed && ref ? Number((c.actions / ref).toFixed(2)) : null;
      if (c.passed && ref) { actions += c.actions; referenceActions += ref; }
    });
    result.efficiency = {actions, referenceActions, ratio: referenceActions ? Number((actions / referenceActions).toFixed(2)) : null,
      note: 'passed cases only; reference = offline hand-written module; informational, not a pass criterion'};
    return result;
  }

  async function runCases(decide, {maxActionsPerTarget = 60, maxCallsPerCase = 160} = {}) {
    const cases = [];
    for (const spec of CASES) {
      const plant = simulateCase(spec), history = [];
      let tip = spec.start.slice(), calls = 0, actions = 0, reached = [], failure = null, failedVerifies = 0;
      for (let t = 0; t < spec.targets.length && !failure; t++) {
        const target = spec.targets[t];
        let goalActions = 0, done = false;
        while (!done && !failure) {
          if (calls >= maxCallsPerCase) { failure = '呼叫次數超過上限'; break; }
          if (goalActions >= maxActionsPerTarget) { failure = `目標 ${t + 1} 未在 ${maxActionsPerTarget} 次動作內到達`; break; }
          calls++;
          let decision;
          try { decision = validateDecision(await decide(state({tip, target, history, step: goalActions, maxActions: maxActionsPerTarget}))); }
          catch (error) { failure = String(error.message || error).slice(0, 240); break; }
          if (decision.action === 'stop') { failure = '控制程式選擇停止：' + decision.reason; break; }
          if (decision.action === 'verify') {
            const error = Math.hypot(target[0] - tip[0], target[1] - tip[1]);
            if (error <= TOLERANCE) { reached.push({target: t + 1, actions: goalActions, errorPx: error}); done = true; }
            else if (++failedVerifies > 3) failure = '多次在未到達時要求驗證';
            continue;
          }
          const result = plant.step(tip, decision.u);
          history.push({command: decision.u.slice(), applied: result.applied, delta: result.delta, limited: result.limited});
          if (history.length > HISTORY) history.shift();
          tip = result.tip; actions++; goalActions++;
        }
        if (done && spec.flipAfterFirst != null && t === 0) plant.signs[spec.flipAfterFirst] *= -1;
      }
      cases.push({name: spec.name, passed: !failure && reached.length === spec.targets.length, actions, calls, reached, failure});
    }
    return {passed: cases.every(c => c.passed), cases, tolerancePx: TOLERANCE, maxActionsPerTarget,
      scope: 'synthetic host simulation only; no device command was sent'};
  }

  global.VlabControllerModule = {CONTRACT, REFERENCE_SOURCE, LIMIT, TOLERANCE, HISTORY, validateDecision, state, isolationTest, cases: () => copy(CASES)};
})(globalThis);
