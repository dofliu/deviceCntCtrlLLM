(function (global) {
  'use strict';

  // This module deliberately knows only pixels and acknowledged channel inputs.
  // The application runs it in a worker, without a reference to the plant.
  const norm = v => Math.hypot(v[0], v[1]);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mul = (J, u) => [J[0][0] * u[0] + J[0][1] * u[1], J[1][0] * u[0] + J[1][1] * u[1]];
  const copyMatrix = J => J ? J.map(row => row.slice()) : null;
  const finitePair = v => v && v.length === 2 && v.every(Number.isFinite);

  function locateMarkers(width, height, pixels) {
    let cx = 0, cy = 0, cn = 0, tx = 0, ty = 0, tn = 0;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
        !pixels || pixels.length < width * height * 4) return { tip: null, target: null };
    for (let y = 0, offset = 0; y < height; y++) {
      for (let x = 0; x < width; x++, offset += 4) {
        if (pixels[offset + 3] < 128) continue;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        if (r < 90 && g > 175 && b > 150) { cx += x; cy += y; cn++; }
        if (r > 190 && g < 135 && b > 110) { tx += x; ty += y; tn++; }
      }
    }
    return { tip: cn >= 8 ? [cx / cn, cy / cn] : null, target: tn >= 12 ? [tx / tn, ty / tn] : null };
  }

  class VisualController {
    // Read-only image inspection for the UI's separate observation/result steps.
    // This function never chooses actions, fits a model or changes agent state.
    static inspect({ width, height, pixels } = {}) {
      const observation = locateMarkers(width, height, pixels);
      return { ...observation, error: observation.tip && observation.target
        ? norm(sub(observation.target, observation.tip)) : null };
    }

    constructor(options = {}) {
      this.tolerance = Number.isFinite(options.tolerance) ? Math.max(1, options.tolerance) : 7;
      this.maxActions = Number.isFinite(options.maxActions) ? Math.max(1, Math.floor(options.maxActions)) : 180;
      this.reset();
    }

    reset() {
      this._J = null;
      this.setGoal();
    }

    setGoal() {
      this.actions = 0;
      this.probes = 0;
      this.recalibrations = 0;
      this._pending = null;
      this._probe = null;
      this._lastTarget = null;
      this._history = [];
      this._terminal = null;
      this._lost = false;
      this._trust = 0.09;
      this._reason = this._J ? '沿用先前學到的局部映射，觀察新目標。' : '尚無動作模型；以小幅度試動建立視覺映射。';
    }

    _beginProbe(reason, recalibration) {
      if (recalibration) this.recalibrations++;
      const h = 0.045;
      // Each channel visits both sides of the current pose and comes back.
      // Actual acknowledgements, rather than requested inputs, fit the model.
      this._probe = {
        sequence: [[h, 0], [-2 * h, 0], [h, 0], [0, h], [0, -2 * h], [0, h]],
        next: 0, denominator: [0, 0], numerator: [[0, 0], [0, 0]],
        recalibration
      };
      this._pending = null;
      this._history = [];
      this._reason = reason;
    }

    _result(observation, status, phase, action, reason) {
      const { tip, target } = observation;
      const displacement = action && this._J ? mul(this._J, action) : null;
      return {
        action,
        status,
        phase,
        tip: tip && tip.slice(),
        target: target && target.slice(),
        error: tip && target ? norm(sub(target, tip)) : null,
        predicted: tip && displacement ? [tip[0] + displacement[0], tip[1] + displacement[1]] : null,
        jacobian: copyMatrix(this._J),
        actions: this.actions,
        probes: this.probes,
        recalibrations: this.recalibrations,
        reason: reason || this._reason
      };
    }

    _issue(observation, action, mode) {
      action = action.map(v => Math.max(-0.10, Math.min(0.10, v)));
      const prediction = this._J ? mul(this._J, action) : null;
      this._pending = { tip: observation.tip.slice(), action, mode, prediction };
      this.actions++;
      if (mode === 'probe') this.probes++;
      const phase = mode === 'probe' ? (this._probe.recalibration ? 'recalibrate' : 'probe') : 'move';
      return this._result(observation, 'running', phase, action);
    }

    _consumeProbe(pending, applied, tip) {
      const delta = sub(tip, pending.tip);
      for (let channel = 0; channel < 2; channel++) {
        const u = applied[channel];
        if (Math.abs(u) < 0.00001) continue;
        this._probe.denominator[channel] += u * u;
        this._probe.numerator[0][channel] += delta[0] * u;
        this._probe.numerator[1][channel] += delta[1] * u;
      }
      if (this._probe.next < this._probe.sequence.length) return;
      const fit = this._probe;
      if (fit.denominator.some(d => d < 0.00001)) {
        this._J = null;
        this._probe = null;
        this._terminal = 'failed';
        this._reason = '試動未取得足夠的有效輸入，無法建立兩個通道的映射。';
        return;
      }
      this._J = fit.numerator.map(row => row.map((n, c) => n / fit.denominator[c]));
      this._probe = null;
      this._reason = '已由試動影像估計局部映射；開始視覺閉迴圈控制。';
    }

    _consumeMove(pending, applied, tip, error) {
      const displacement = sub(tip, pending.tip);
      const expected = mul(this._J, applied);
      const residual = sub(displacement, expected);
      const inputSquared = applied[0] ** 2 + applied[1] ** 2;
      if (norm(residual) > Math.max(6, norm(expected) * 0.65)) {
        this._trust = Math.max(0.045, this._trust * 0.7);
        this._beginProbe('實際位移與預測不符，重新試動辨識目前的控制關係。', true);
        return;
      }
      // A damped Broyden secant update follows gradual local nonlinear changes.
      // It updates only the input direction actually exercised in this step.
      if (inputSquared > 0.00002) {
        const learningRate = 0.55;
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < 2; c++) {
            this._J[r][c] += learningRate * residual[r] * applied[c] / inputSquared;
          }
        }
      }
      this._trust = Math.min(0.09, this._trust + 0.005);
      this._history.push(error);
      if (this._history.length > 10) this._history.shift();
      if (this._history.length === 10 && Math.min(...this._history.slice(5)) >= Math.min(...this._history.slice(0, 5)) - 1.5) {
        this._beginProbe('誤差改善停滯，重新量測局部映射。', true);
      }
    }

    _move(errorVector) {
      const J = this._J;
      // Solve J^T (J J^T + damping^2 I)^-1 e. This remains bounded near
      // a singular visual mapping and does not assume any robot geometry.
      const c0 = Math.hypot(J[0][0], J[1][0]);
      const c1 = Math.hypot(J[0][1], J[1][1]);
      const determinant = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      const quality = Math.abs(determinant) / Math.max(1, c0 * c1);
      const damping = 4 + Math.max(0, 0.18 - quality) * 80;
      const a = J[0][0] ** 2 + J[0][1] ** 2 + damping ** 2;
      const b = J[0][0] * J[1][0] + J[0][1] * J[1][1];
      const d = J[1][0] ** 2 + J[1][1] ** 2 + damping ** 2;
      const det = a * d - b * b;
      const eScale = Math.min(0.72, 28 / Math.max(1, norm(errorVector)));
      const e = errorVector.map(v => v * eScale);
      const v = [(d * e[0] - b * e[1]) / det, (a * e[1] - b * e[0]) / det];
      const u = [J[0][0] * v[0] + J[1][0] * v[1], J[0][1] * v[0] + J[1][1] * v[1]];
      const scale = Math.min(1, this._trust / Math.max(0.000001, Math.abs(u[0]), Math.abs(u[1])));
      return u.map(value => value * scale);
    }

    step({ width, height, pixels, applied } = {}) {
      const observation = locateMarkers(width, height, pixels);
      if (this._terminal) return this._result(observation, this._terminal, 'verify', null);
      const { tip, target } = observation;
      if (!tip || !target) {
        // A hidden marker cannot supply a trustworthy state. Stop emitting
        // commands immediately, and re-identify if observations later resume.
        this._pending = null;
        this._probe = null;
        this._lost = true;
        return this._result(observation, 'lost', 'observe', null,
          !tip ? '看不到青色末端標記，已停止動作；恢復可見後可重新開始。' : '看不到洋紅目標標記，已停止動作。');
      }

      const targetMoved = this._lastTarget && norm(sub(target, this._lastTarget)) > 5;
      this._lastTarget = target.slice();
      if (this._lost || targetMoved) {
        this._beginProbe(this._lost ? '標記重新可見，重新試動確認映射。' : '影像中的目標位置改變，重新辨識相機與控制的關係。', Boolean(this._J));
        this._lost = false;
      }

      const errorVector = sub(target, tip);
      const error = norm(errorVector);
      if (this._pending) {
        const pending = this._pending;
        this._pending = null;
        const ack = finitePair(applied) ? applied.slice() : pending.action.slice();
        if (pending.mode === 'probe' && this._probe) this._consumeProbe(pending, ack, tip);
        else if (pending.mode === 'move' && this._J) this._consumeMove(pending, ack, tip, error);
      }

      if (error <= this.tolerance) {
        this._terminal = 'success';
        this._pending = null;
        this._probe = null;
        this._reason = '影像確認末端與目標的距離已進入容許誤差。';
        return this._result(observation, 'success', 'verify', null);
      }
      if (this._terminal) return this._result(observation, this._terminal, 'verify', null);
      if (this.actions >= this.maxActions) {
        this._terminal = 'failed';
        this._reason = '已達動作預算仍未到達目標；目標可能不可達，或目前模型不足。';
        return this._result(observation, 'failed', 'verify', null);
      }
      if (!this._J && !this._probe) this._beginProbe('依序小幅試動兩個通道，從影像估計各自的位移效果。', false);
      if (this._probe) {
        const action = this._probe.sequence[this._probe.next++];
        return this._issue(observation, action, 'probe');
      }
      const action = this._move(errorVector);
      if (!finitePair(action)) {
        this._J = null;
        this._beginProbe('局部映射無法產生有限的控制量，重新辨識。', true);
        return this._issue(observation, this._probe.sequence[this._probe.next++], 'probe');
      }
      this._reason = '依據影像誤差與學到的映射移動，並用下一張影像修正模型。';
      return this._issue(observation, action, 'move');
    }
  }

  global.VisualController = VisualController;
})(typeof self !== 'undefined' ? self : globalThis);
