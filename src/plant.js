(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const wrap = value => ((value + Math.PI) % TAU + TAU) % TAU - Math.PI;

  // Only this plant owns geometry, joint positions and camera calibration.
  // The controller runs in a separate worker and receives frame pixels and
  // actuation acknowledgements. diagnostics() belongs to the evaluator/UI.
  class VirtualPlant {
    #width; #height; #canvas; #context; #seed; #random;
    #lengths; #q; #mapping; #gains; #camera; #target;
    #occluded = false; #cameraVersion = 0; #motorFlips = 0;
    #object; #destination; #lift = 'up'; #grip = 'open'; #attached = false;
    #objectHeight = 0; #graspCount = 0; #releaseCount = 0;
    #scenario = null; #destinationHeight = 0; #liftHeight = 1;
    #platformRadius = 24; #kinematics = '2r'; #travel = null;
    #backlash = 0; #motor = [0, 0]; #belt = [0, 0];
    #five = null; #lastPoint = [0, 0];

    // kinematics '2r' is the original two-link arm; 'gantry' is a Cartesian
    // two-axis carriage with travel limits; 'corexy' (held-out VLAB-X) moves the
    // same kind of carriage with two coupled belt motors that have reversal
    // backlash; 'fivebar' (held-out VLAB-Y) is a closed-chain parallel arm whose
    // two base motors meet at the tip through two passive distal links. All hide
    // mapping, signs and gains.
    constructor({ seed = 42, width = 640, height = 480, kinematics = '2r' } = {}) {
      if (!['2r', 'gantry', 'corexy', 'fivebar'].includes(kinematics)) throw new Error('PLANT: unknown kinematics.');
      this.#kinematics = kinematics;
      this.#width = Math.max(160, Math.round(width));
      this.#height = Math.max(120, Math.round(height));
      this.#canvas = document.createElement('canvas');
      this.#canvas.width = this.#width;
      this.#canvas.height = this.#height;
      this.#context = this.#canvas.getContext('2d', { willReadFrequently: true });
      this.reset(seed);
    }

    reset(seed = 42) {
      this.#seed = (Number.isFinite(Number(seed)) ? Number(seed) : 42) >>> 0;
      let state = this.#seed;
      this.#random = () => {
        state += 0x6D2B79F5;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const between = (low, high) => low + this.#random() * (high - low);
      const fit = Math.min(this.#width / 640, this.#height / 480);
      if (this.#kinematics === 'gantry') {
        this.#travel = [between(125, 140), between(110, 122)];
        this.#lengths = this.#travel.slice();
        this.#q = [between(-60, 60), between(-50, 50)];
        this.#mapping = this.#random() < 0.5 ? [0, 1] : [1, 0];
        this.#gains = [0, 1].map(() => between(125, 165) * (this.#random() < 0.5 ? -1 : 1));
      } else if (this.#kinematics === 'corexy') {
        // Each motor moves the carriage diagonally: x = (A+B)/2, y = (A-B)/2
        // in the frame's own axes; mapping swaps which sum drives world x.
        this.#travel = [between(125, 140), between(110, 122)];
        this.#lengths = this.#travel.slice();
        this.#q = [between(-60, 60), between(-50, 50)];
        this.#mapping = this.#random() < 0.5 ? [0, 1] : [1, 0];
        this.#gains = [0, 1].map(() => between(150, 190) * (this.#random() < 0.5 ? -1 : 1));
        this.#backlash = between(0.012, 0.02);
        this.#motor = [0, 0]; this.#belt = [0, 0];
      } else if (this.#kinematics === 'fivebar') {
        // Left and right motors sit on a base bar; each drives a proximal link,
        // and two passive distal links join at the tip (elbows outward, tip
        // above the elbow line). Slightly unequal sides; the whole mechanism
        // is rotated by a hidden base angle about the work-area centre.
        // Proportions (distal/proximal about 1.2, narrow motor spacing) and a
        // task circle near the singularity margin make the local channel
        // mapping turn and rescale along every transfer.
        const proximal = [between(128, 138), between(128, 138)];
        this.#five = {proximal, distal: proximal.map(v => v * between(1.15, 1.25)),
          spacing: (proximal[0] + proximal[1]) / 2 * between(0.27, 0.33), baseAngle: between(-Math.PI, Math.PI), centre: 0, radius: 0};
        this.#lengths = [this.#five.proximal[0], this.#five.distal[0]];
        this.#mapping = this.#random() < 0.5 ? [0, 1] : [1, 0];
        this.#gains = [0, 1].map(() => between(1.05, 1.4) * (this.#random() < 0.5 ? -1 : 1));
        this.#fiveBarWorkspace();
        const start = between(-Math.PI, Math.PI);
        this.#q = this.#fiveBarIK([Math.cos(start) * this.#five.radius * .5, Math.sin(start) * this.#five.radius * .5]);
        this.#lastPoint = this.#point();
      } else {
        this.#lengths = [between(82, 104), between(66, 82)];
        this.#q = [between(-2.1, -0.3), between(1.0, 1.9)];
        this.#mapping = this.#random() < 0.5 ? [0, 1] : [1, 0];
        this.#gains = [0, 1].map(() => between(1.05, 1.4) * (this.#random() < 0.5 ? -1 : 1));
      }
      this.#camera = {
        angle: between(-0.4, 0.4),
        scale: between(0.92, 1.03) * fit,
        x: this.#width / 2 + between(-12, 12) * fit,
        y: this.#height / 2 + between(-6, 6) * fit,
        fit
      };
      this.#occluded = false;
      this.#cameraVersion = 0;
      this.#motorFlips = 0;
      this.newTarget();
      this.#object = this.#target.slice();
      // Both locations are sampled from reachable poses. The agent receives
      // only their rendered pixels, never these world coordinates.
      const origin = this.#target.slice();
      for (let attempt = 0; attempt < 40; attempt++) {
        this.newTarget();
        if (Math.hypot(this.#target[0] - origin[0], this.#target[1] - origin[1]) > 55) break;
      }
      this.#destination = this.#target.slice();
      this.#target = origin;
      this.#lift = 'up'; this.#grip = 'open'; this.#attached = false;
      this.#objectHeight = 0; this.#graspCount = 0; this.#releaseCount = 0;
      this.#scenario = null; this.#destinationHeight = 0; this.#liftHeight = 1;
    }

    // Experiment setup only: neither these reachable poses nor the camera
    // transform are exposed to the controller. Repositioning objects does not
    // rebuild the robot, change its channels, or move its current joints.
    configureTrial(index, { initialPose = false } = {}) {
      if (!Number.isInteger(index) || index < 0 || index > 4) throw new Error('TRIAL: index must be 0 through 4.');
      if (this.#attached) throw new Error('TRIAL: release the held object before changing the scene.');
      const pairs = [[-135,-25],[30,-90],[-145,-15],[35,155],[100,-30]];
      const heights = [0,.35,.65,.35,0];
      const radius = this.#cartesian() ? Math.min(...this.#travel) * .84 : this.#kinematics === 'fivebar' ? this.#five.radius * .92 : (this.#lengths[0] + this.#lengths[1]) * .77;
      const jitter = Math.sin(this.#seed * .173 + index * 2.1) * 3;
      const pointAt = degrees => {
        const angle = (degrees + jitter) * Math.PI / 180 - this.#camera.angle;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      };
      if (initialPose && this.#cartesian()) {
        this.#q = pointAt(135);
        this.#lift = 'up'; this.#liftHeight = 1; this.#grip = 'open';
      } else if (initialPose && this.#kinematics === 'fivebar') {
        this.#q = this.#fiveBarIK(pointAt(135)); this.#lastPoint = this.#point();
        this.#lift = 'up'; this.#liftHeight = 1; this.#grip = 'open';
      } else if (initialPose) {
        const start = pointAt(135), [l1,l2] = this.#lengths;
        const q2 = Math.acos(clamp((radius * radius - l1*l1 - l2*l2)/(2*l1*l2),-1,1));
        this.#q = [wrap(Math.atan2(start[1],start[0])-Math.atan2(l2*Math.sin(q2),l1+l2*Math.cos(q2))),q2];
        this.#lift = 'up'; this.#liftHeight = 1; this.#grip = 'open';
      }
      this.#object = pointAt(pairs[index][0]);
      this.#destination = pointAt(pairs[index][1]);
      this.#target = this.#object.slice();
      this.#objectHeight = 0; this.#destinationHeight = heights[index];
      const tip = this.#project(this.#point()), a = this.#project(this.#object), b = this.#project(this.#destination);
      this.#scenario = {
        type:'five-trial-series',trialIndex:index,trialNumber:index+1,totalTrials:5,
        label:['遠距桌面取放','更換物件位置・低平台','更換物件位置・高平台','不同方向・低平台','回到桌面・另一組位置'][index],
        destinationHeight:this.#destinationHeight,liftSafeHeight:1,heightUnits:'relative-to-safe-lift',
        initialDistancePx:Math.hypot(tip[0]-a[0],tip[1]-a[1]),
        transferDistancePx:Math.hypot(a[0]-b[0],a[1]-b[1]),
        platformMode:'compliant-surface-stop'
      };
      return {...this.#scenario};
    }

    #supportHeight(point) {
      return this.#scenario && Math.hypot(point[0]-this.#destination[0],point[1]-this.#destination[1]) <= this.#platformRadius
        ? this.#destinationHeight : 0;
    }

    #cartesian() { return this.#kinematics === 'gantry' || this.#kinematics === 'corexy'; }

    // Five-bar geometry in the mechanism frame: motors at (-s/2, 0) and
    // (s/2, 0); q = absolute proximal angles. Returns null when the distal
    // circles do not meet. The tip is the intersection left of e1 -> e2.
    #fiveBarSolve(q) {
      const f = this.#five, [la, lb] = f.proximal, [da, db] = f.distal, h0 = f.spacing / 2;
      const e1 = [-h0 + la * Math.cos(q[0]), la * Math.sin(q[0])], e2 = [h0 + lb * Math.cos(q[1]), lb * Math.sin(q[1])];
      const vx = e2[0] - e1[0], vy = e2[1] - e1[1], s = Math.hypot(vx, vy);
      if (!(s > 1e-9) || s >= da + db || s <= Math.abs(da - db)) return null;
      const a = (da * da - db * db + s * s) / (2 * s), h = Math.sqrt(Math.max(0, da * da - a * a));
      const m = [e1[0] + a * vx / s, e1[1] + a * vy / s];
      return {tip: [m[0] - h * vy / s, m[1] + h * vx / s], e1, e2, a1: [-h0, 0], a2: [h0, 0]};
    }

    // Signed link angles in degrees: elbow angles (proximal vs distal, per
    // side) and the tip angle between the distal links. Near 0 or 180 the arm
    // is at a serial or parallel singularity.
    #fiveBarAngles(solution) {
      const angle = (u, v) => Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * 180 / Math.PI;
      const {tip, e1, e2, a1, a2} = solution, sub = (p, o) => [p[0] - o[0], p[1] - o[1]];
      return {left: angle(sub(a1, e1), sub(tip, e1)), right: angle(sub(a2, e2), sub(tip, e2)), tip: angle(sub(e1, tip), sub(e2, tip))};
    }

    // Motion stops at 8 degrees from a serial (elbow) and 18 degrees from a
    // parallel (tip) singularity; the task area keeps 14 and 24 degrees.
    #fiveBarOK(q, elbow = 8, tip = 18) {
      const solution = this.#fiveBarSolve(q);
      if (!solution) return false;
      const angles = this.#fiveBarAngles(solution);
      return angles.left >= elbow && angles.left <= 180 - elbow && -angles.right >= elbow && -angles.right <= 180 - elbow && angles.tip >= tip && angles.tip <= 180 - tip;
    }

    // Mechanism frame <-> device frame (work-area centre at the origin).
    #fiveBarToDevice(p) {
      const f = this.#five, x = p[0], y = p[1] - f.centre, c = Math.cos(f.baseAngle), s = Math.sin(f.baseAngle);
      return [c * x - s * y, s * x + c * y];
    }
    #fiveBarToMechanism(p) {
      const f = this.#five, c = Math.cos(f.baseAngle), s = Math.sin(f.baseAngle);
      return [c * p[0] + s * p[1], -s * p[0] + c * p[1] + f.centre];
    }

    // Elbows-outward inverse kinematics; point in the device frame.
    #fiveBarIK(point, mechanism = false) {
      const f = this.#five, p = mechanism ? point : this.#fiveBarToMechanism(point), q = [];
      for (let side = 0; side < 2; side++) {
        const ax = side ? f.spacing / 2 : -f.spacing / 2, dx = p[0] - ax, dy = p[1], r = Math.hypot(dx, dy);
        const l1 = f.proximal[side], l2 = f.distal[side], cosine = (l1 * l1 + r * r - l2 * l2) / (2 * l1 * r);
        if (!(r > 1e-9) || Math.abs(cosine) > 1) return null;
        const phi = Math.atan2(dy, dx), alpha = Math.acos(cosine);
        q.push(side ? phi - alpha : phi + alpha);
      }
      return q;
    }

    // Largest disk (centre on the symmetry axis) whose poses all keep a wider
    // design margin than the motion stop; the task uses 92% of its radius.
    #fiveBarWorkspace() {
      const f = this.#five, rings = [1, .5], angles = 36;
      const inside = (centre, radius) => {
        for (let k = 0; k < angles; k++) for (const ring of rings) {
          const a = 2 * Math.PI * k / angles, p = [Math.cos(a) * radius * ring, centre + Math.sin(a) * radius * ring];
          const q = this.#fiveBarIK(p, true), solution = q && this.#fiveBarSolve(q);
          if (!solution || Math.hypot(solution.tip[0] - p[0], solution.tip[1] - p[1]) > 1e-6 || !this.#fiveBarOK(q, 14, 24)) return false;
        }
        return true;
      };
      let best = {centre: 0, radius: 0};
      for (let centre = 100; centre <= 300; centre += 4) {
        if (!inside(centre, 10)) continue;
        let low = 10, high = 260;
        for (let i = 0; i < 14; i++) { const mid = (low + high) / 2; if (inside(centre, mid)) low = mid; else high = mid; }
        if (low > best.radius) best = {centre, radius: low};
      }
      f.centre = best.centre; f.radius = best.radius;
    }

    #fiveBarSegment(from, to) {
      for (let k = 1; k <= 8; k++) if (!this.#fiveBarOK(from.map((v, j) => v + (to[j] - v) * k / 8))) return false;
      return true;
    }

    // Both motors stop together before a singular or unreachable pose; the
    // ACK reports the accepted fraction and limited:true.
    #actFiveBar(action) {
      const amount = [0, 1].map(c => { const r = Number(action && action[c]); return clamp(Number.isFinite(r) ? r : 0, -0.10, 0.10); });
      let limited = [0, 1].some(c => !Number.isFinite(Number(action && action[c])) || amount[c] !== Number(action[c]));
      const after = scale => { const q = this.#q.slice(); for (let c = 0; c < 2; c++) q[this.#mapping[c]] += amount[c] * scale * this.#gains[c]; return q; };
      let scale = 1, nextQ = after(1);
      if (!this.#fiveBarSegment(this.#q, nextQ)) {
        let low = 0, high = 1;
        for (let i = 0; i < 30; i++) { const mid = (low + high) / 2; if (this.#fiveBarSegment(this.#q, after(mid))) low = mid; else high = mid; }
        scale = low; nextQ = after(low); limited = true;
      }
      if (this.#scenario && this.#liftHeight < this.#destinationHeight - 1e-9) this.#checkSweep(nextQ);
      this.#q = nextQ; this.#lastPoint = this.#point();
      if (this.#attached) this.#object = this.#point();
      return { applied: amount.map(v => v * scale), limited };
    }

    // CoreXY with per-motor backlash: the belt follows the motor only after the
    // motor has taken up the slack w. The ACK reports the motor command the
    // controller accepted; the carriage moves by the belt displacement.
    #coreXY(amount, scale) {
      const motor = this.#motor.slice(), belt = this.#belt.slice(), half = this.#backlash / 2, moved = [0, 0];
      for (let c = 0; c < 2; c++) {
        motor[c] += amount[c] * scale;
        const before = belt[c];
        if (motor[c] - belt[c] > half) belt[c] = motor[c] - half;
        else if (belt[c] - motor[c] > half) belt[c] = motor[c] + half;
        moved[c] = (belt[c] - before) * this.#gains[c];
      }
      const frame = [(moved[0] + moved[1]) / 2, (moved[0] - moved[1]) / 2];
      const delta = this.#mapping[0] === 0 ? frame : [frame[1], frame[0]];
      return {motor, belt, next: [this.#q[0] + delta[0], this.#q[1] + delta[1]]};
    }

    act(action) {
      if (action && !Array.isArray(action)) return this.#manipulate(action);
      if (this.#kinematics === 'corexy') return this.#actCoreXY(action);
      if (this.#kinematics === 'fivebar') return this.#actFiveBar(action);
      const applied = [0, 0];
      const nextQ = this.#q.slice();
      let limited = false;
      for (let channel = 0; channel < 2; channel++) {
        const requested = Number(action && action[channel]);
        const valid = Number.isFinite(requested) ? requested : 0;
        let amount = clamp(valid, -0.10, 0.10);
        if (!Number.isFinite(requested) || amount !== requested) limited = true;
        const joint = this.#mapping[channel];
        const before = nextQ[joint];
        const desired = before + amount * this.#gains[channel];
        if (this.#kinematics === 'gantry') {
          nextQ[joint] = clamp(desired, -this.#travel[joint], this.#travel[joint]);
          if (Math.abs(nextQ[joint] - desired) > 1e-12) {
            amount = (nextQ[joint] - before) / this.#gains[channel];
            limited = true;
          }
        } else if (joint === 0) {
          nextQ[0] = wrap(desired);
        } else {
          nextQ[1] = clamp(desired, 0.25, 2.85);
          if (Math.abs(nextQ[1] - desired) > 1e-12) {
            amount = (nextQ[1] - before) / this.#gains[channel];
            limited = true;
          }
        }
        applied[channel] = amount;
      }
      // Validate the whole requested sweep before committing either channel.
      // A rejected low-height move must never partly move and then report an
      // error. Joint-zero interpolation uses its short wrapped displacement.
      if (this.#scenario && this.#liftHeight < this.#destinationHeight - 1e-9) {
        this.#checkSweep(nextQ);
      }
      this.#q = nextQ;
      if (this.#attached) this.#object = this.#point();
      return { applied, limited };
    }

    #checkSweep(nextQ) {
      const delta = [this.#cartesian() ? nextQ[0]-this.#q[0] : wrap(nextQ[0]-this.#q[0]),nextQ[1]-this.#q[1]];
      const clearance = this.#platformRadius + (this.#attached ? 8 : 0);
      for (let sample=0; sample<=16; sample++) {
        const point = this.#point(this.#q.map((value,j)=>value+delta[j]*sample/16));
        if (Math.hypot(point[0]-this.#destination[0],point[1]-this.#destination[1]) < clearance) {
          throw new Error('COLLISION: raise the end effector before crossing the elevated platform; no channels moved.');
        }
      }
    }

    #actCoreXY(action) {
      const amount = [0, 1].map(c => { const r = Number(action && action[c]); return clamp(Number.isFinite(r) ? r : 0, -0.10, 0.10); });
      let limited = [0, 1].some(c => !Number.isFinite(Number(action && action[c])) || amount[c] !== Number(action[c]));
      const inside = q => Math.abs(q[0]) <= this.#travel[0] + 1e-9 && Math.abs(q[1]) <= this.#travel[1] + 1e-9;
      let scale = 1, result = this.#coreXY(amount, 1);
      if (!inside(result.next)) {
        // Both motors stop together at the travel limit (largest feasible fraction).
        let low = 0, high = 1;
        for (let i = 0; i < 30; i++) { const mid = (low + high) / 2; if (inside(this.#coreXY(amount, mid).next)) low = mid; else high = mid; }
        scale = low; result = this.#coreXY(amount, scale); limited = true;
      }
      if (this.#scenario && this.#liftHeight < this.#destinationHeight - 1e-9) this.#checkSweep(result.next);
      this.#motor = result.motor; this.#belt = result.belt; this.#q = result.next;
      if (this.#attached) this.#object = this.#point();
      return { applied: amount.map(v => v * scale), limited };
    }

    #manipulate(command) {
      if (command.op === 'lift' && ['up', 'down'].includes(command.position)) {
        this.#lift = command.position;
        // Known firmware behavior: down stops compliantly at the local
        // supporting surface. This is not learned or arbitrary Z control.
        this.#liftHeight = this.#lift === 'up' ? 1 : this.#supportHeight(this.#point());
        if (this.#attached) this.#objectHeight = this.#liftHeight;
        return {applied:{op:'lift',position:this.#lift},limited:false};
      }
      if (command.op === 'grip' && ['open', 'closed'].includes(command.state)) {
        const wasOpen = this.#grip === 'open';
        this.#grip = command.state;
        if (this.#grip === 'open' && this.#attached) {
          // Quasi-static release: the object falls vertically onto whichever
          // table/platform surface is actually below its current XY position.
          // It stays at the release XY location and never snaps to the goal.
          this.#attached = false; this.#objectHeight = this.#supportHeight(this.#object); this.#releaseCount++;
        } else if (wasOpen && this.#grip === 'closed' && this.#lift === 'down') {
          const tip = this.#point();
          if (Math.hypot(tip[0] - this.#object[0], tip[1] - this.#object[1]) <= 10 && Math.abs(this.#liftHeight-this.#objectHeight) < 1e-9) {
            this.#object = tip.slice(); this.#attached = true; this.#graspCount++;
          }
        }
        return {applied:{op:'grip',state:this.#grip},limited:false};
      }
      throw new Error('Unsupported manipulation command.');
    }

    operate(command) { return this.#manipulate(command); }

    #point(q = this.#q) {
      if (this.#cartesian()) return [q[0], q[1]];
      if (this.#kinematics === 'fivebar') { const solution = this.#fiveBarSolve(q); return solution ? this.#fiveBarToDevice(solution.tip) : this.#lastPoint.slice(); }
      return [
        this.#lengths[0] * Math.cos(q[0]) + this.#lengths[1] * Math.cos(q[0] + q[1]),
        this.#lengths[0] * Math.sin(q[0]) + this.#lengths[1] * Math.sin(q[0] + q[1])
      ];
    }

    #project(point) {
      const c = this.#camera;
      const cosine = Math.cos(c.angle), sine = Math.sin(c.angle);
      return [
        c.x + c.scale * (cosine * point[0] - sine * point[1]),
        c.y + c.scale * (sine * point[0] + cosine * point[1])
      ];
    }

    #unproject(point) {
      const c = this.#camera;
      const x = (point[0] - c.x) / c.scale, y = (point[1] - c.y) / c.scale;
      return [Math.cos(c.angle) * x + Math.sin(c.angle) * y,
        -Math.sin(c.angle) * x + Math.cos(c.angle) * y];
    }

    newTarget() {
      const tip = this.#point();
      let candidate;
      // Sample reachable joint configurations; never supply their coordinates
      // to the controller. Goals are useful local-to-medium reaches, not a
      // fixed animation trajectory, and exclude poorly conditioned extremes.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (this.#kinematics === 'fivebar') {
          const a = this.#random() * 2 * Math.PI, r = Math.sqrt(this.#random()) * this.#five.radius * .9;
          candidate = [Math.cos(a) * r, Math.sin(a) * r];
        } else {
          const q = this.#cartesian()
            ? [(this.#random() * 2 - 1) * this.#travel[0] * .85, (this.#random() * 2 - 1) * this.#travel[1] * .85]
            : [this.#q[0] + (this.#random() * 2 - 1) * 0.95, 0.65 + this.#random() * 1.6];
          candidate = this.#point(q);
        }
        const distance = Math.hypot(candidate[0] - tip[0], candidate[1] - tip[1]);
        if (distance > 45 && distance < 175) break;
      }
      this.#target = candidate;
    }

    setTargetPixel(x, y) {
      if (Number.isFinite(x) && Number.isFinite(y)) this.#target = this.#unproject([x, y]);
    }

    perturbCamera() {
      const c = this.#camera;
      c.angle = wrap(c.angle + (this.#random() < 0.5 ? -1 : 1) * (0.38 + this.#random() * 0.1));
      c.scale = clamp(c.scale * (this.#random() < 0.5 ? 0.90 : 1.10), 0.82 * c.fit, 1.08 * c.fit);
      c.x = this.#width / 2 + (this.#random() * 2 - 1) * 20 * c.fit;
      c.y = this.#height / 2 + (this.#random() * 2 - 1) * 10 * c.fit;
      this.#cameraVersion++;
    }

    perturbMotor() {
      const channel = this.#random() < 0.5 ? 0 : 1;
      this.#gains[channel] *= -1;
      this.#motorFlips++;
    }

    setOccluded(value) { this.#occluded = Boolean(value); }

    frame() {
      const ctx = this.#context, w = this.#width, h = this.#height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#08131c';
      ctx.fillRect(0, 0, w, h);

      // Table markings are rendered through the same camera transform as the
      // robot, making a camera perturbation visible in the complete scene.
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#152a38';
      ctx.beginPath();
      for (let coordinate = -500; coordinate <= 500; coordinate += 32) {
        let a = this.#project([coordinate, -500]), b = this.#project([coordinate, 500]);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        a = this.#project([-500, coordinate]); b = this.#project([500, coordinate]);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();

      const base = this.#project([0, 0]);
      const elbow = this.#project([this.#lengths[0] * Math.cos(this.#q[0]),
        this.#lengths[0] * Math.sin(this.#q[0])]);
      const tip = this.#project(this.#point());
      const target = this.#project(this.#target);
      const objectGround = this.#project(this.#object);
      const destination = this.#project(this.#destination);
      const fit = this.#camera.fit;
      const destinationSurface = [destination[0],destination[1]-this.#destinationHeight*18*fit];
      const disk = (point, radius, color) => {
        ctx.beginPath(); ctx.arc(point[0], point[1], radius, 0, TAU);
        ctx.fillStyle = color; ctx.fill();
      };
      const line = (a, b, width, color) => {
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke();
      };

      // Unpainted endpoint underlay is deliberately neutral. In the marker-loss
      // experiment only the colored marker disappears, so the allowed simple
      // vision algorithm must report missing evidence instead of inferring it.
      if (this.#cartesian()) {
        // Two fixed rails along world x and a bridge that follows the carriage.
        // Neutral greys only: the colour detector must not see these parts.
        const [tx, ty] = this.#travel.map(v => v + 18), point = this.#point();
        for (const y of [-ty, ty]) line(this.#project([-tx, y]), this.#project([tx, y]), 10 * fit, '#314758');
        for (const y of [-ty, ty]) line(this.#project([-tx, y]), this.#project([tx, y]), 4 * fit, '#a0afbb');
        line(this.#project([point[0], -ty]), this.#project([point[0], ty]), 14 * fit, '#314758');
        line(this.#project([point[0], -ty]), this.#project([point[0], ty]), 7 * fit, '#8294a4');
        disk(tip, 11 * fit, '#263a4b');
        disk(tip, 9 * fit, '#152838');
      } else if (this.#kinematics === 'fivebar') {
        // Base bar, two driven proximal links and two passive distal links.
        const s = this.#fiveBarSolve(this.#q), to = p => this.#project(this.#fiveBarToDevice(p));
        const a1 = to([-this.#five.spacing / 2, 0]), a2 = to([this.#five.spacing / 2, 0]);
        line(a1, a2, 18 * fit, '#233c4b');
        if (s) {
          const e1 = to(s.e1), e2 = to(s.e2);
          for (const [a, e] of [[a1, e1], [a2, e2]]) { line(a, e, 16 * fit, '#314758'); line(a, e, 10 * fit, '#a0afbb'); }
          for (const e of [e1, e2]) { line(e, tip, 14 * fit, '#314758'); line(e, tip, 8 * fit, '#8294a4'); }
          for (const e of [e1, e2]) { disk(e, 10 * fit, '#263a4b'); disk(e, 6 * fit, '#c1cad1'); }
        }
        for (const a of [a1, a2]) { disk(a, 9 * fit, '#d0d6dc'); disk(a, 3 * fit, '#263a4b'); }
        disk(tip, 9 * fit, '#152838');
      } else {
        disk(base, 23 * fit, '#233c4b');
        disk(base, 16 * fit, '#0b1923');
        line(base, elbow, 16 * fit, '#314758');
        line(base, elbow, 10 * fit, '#a0afbb');
        line(elbow, tip, 14 * fit, '#314758');
        line(elbow, tip, 8 * fit, '#8294a4');
        disk(base, 9 * fit, '#d0d6dc');
        disk(base, 3 * fit, '#263a4b');
        disk(elbow, 10 * fit, '#263a4b');
        disk(elbow, 6 * fit, '#c1cad1');
        disk(tip, 9 * fit, '#152838');
      }

      // A fixed placement zone and an independently simulated object are
      // visible before any decision. Blue/orange occur only on these markers.
      if (this.#scenario && this.#destinationHeight > 0) {
        line(destination,destinationSurface,52*fit,'#1d2c3e');
        disk(destinationSurface,26*fit,'#293950');
      }
      ctx.beginPath(); ctx.arc(destination[0], destination[1], (this.#scenario ? 34 : 24) * fit, 0, TAU);
      ctx.lineWidth = 4 * fit; ctx.strokeStyle = '#4977ef'; ctx.stroke();
      if (this.#scenario) {
        // Purple is the visible top-surface marker; the larger blue ground
        // reference stays fixed for XY navigation. Their separation is the
        // camera evidence for height, including the zero-height trial.
        ctx.beginPath(); ctx.arc(destinationSurface[0],destinationSurface[1],18*fit,0,TAU);
        ctx.lineWidth = 3*fit; ctx.strokeStyle = '#9b7df4'; ctx.stroke();
      }
      ctx.font = `${Math.round(12 * fit)}px sans-serif`; ctx.fillStyle = '#d4deee';
      ctx.fillText('B', destination[0] + (this.#scenario ? 40 : 29) * fit, destination[1] + 4 * fit);

      // Full target ring is drawn above links and below endpoint. The ring
      // remains visible and symmetric when the two centroids coincide.
      ctx.beginPath(); ctx.arc(target[0], target[1], 15 * fit, 0, TAU);
      ctx.lineWidth = 3 * fit; ctx.strokeStyle = '#f64cc3'; ctx.stroke();
      ctx.lineWidth = 1 * fit; ctx.strokeStyle = '#f64cc3';
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        ctx.moveTo(target[0] + Math.cos(a) * 19 * fit, target[1] + Math.sin(a) * 19 * fit);
        ctx.lineTo(target[0] + Math.cos(a) * 23 * fit, target[1] + Math.sin(a) * 23 * fit);
      }
      ctx.stroke();
      if (this.#objectHeight > 0) {
        disk(objectGround, 10 * fit, 'rgba(0,0,0,0.65)');
        line(objectGround, [objectGround[0], objectGround[1] - this.#objectHeight*18*fit], 2 * fit, '#abb6bd');
      }
      const objectCenter = [objectGround[0], objectGround[1] - this.#objectHeight * 18 * fit];
      ctx.fillStyle = '#ffad35';
      ctx.fillRect(objectCenter[0] - 8 * fit, objectCenter[1] - 8 * fit, 16 * fit, 16 * fit);
      ctx.strokeStyle = '#6c471f'; ctx.lineWidth = 1.5 * fit;
      ctx.strokeRect(objectCenter[0] - 8 * fit, objectCenter[1] - 8 * fit, 16 * fit, 16 * fit);
      const jawSpan = (this.#grip === 'open' ? 14 : 9) * fit;
      for (const side of [-1, 1]) {
        line([tip[0] + side * jawSpan, tip[1] - 9 * fit], [tip[0] + side * jawSpan, tip[1] + 9 * fit], 3 * fit, '#d0d8df');
      }
      if (!this.#occluded) {
        disk(tip, 7.5 * fit, '#071b23');
        disk(tip, 6 * fit, '#2de2df');
      }

      return { width: w, height: h, pixels: ctx.getImageData(0, 0, w, h).data };
    }

    diagnostics() {
      const tip = this.#project(this.#point()), target = this.#project(this.#target);
      return {
        seed: this.#seed,
        tip: tip.slice(),
        target: target.slice(),
        trueError: Math.hypot(tip[0] - target[0], tip[1] - target[1]),
        cameraVersion: this.#cameraVersion,
        motorFlips: this.#motorFlips,
        occluded: this.#occluded,
        scenario: this.#scenario ? {...this.#scenario} : null,
        pickPlace: {
          object:this.#object.slice(),destination:this.#destination.slice(),
          lift:this.#lift,gripper:this.#grip,held:this.#attached,objectHeight:this.#objectHeight,
          liftHeight:this.#liftHeight,destinationHeight:this.#destinationHeight,platformRadius:this.#platformRadius,
          graspCount:this.#graspCount,releaseCount:this.#releaseCount,
          placed:!this.#attached && Math.abs(this.#objectHeight-this.#destinationHeight) < 1e-9 &&
            Math.hypot(this.#object[0]-this.#destination[0],this.#object[1]-this.#destination[1]) <= 12
        },
        manipulation: {
          lift:this.#lift, gripper:this.#grip, attached:this.#attached,
          objectHeight:this.#objectHeight,liftHeight:this.#liftHeight,destinationHeight:this.#destinationHeight,
          object:this.#project(this.#object),
          objectVisual:this.#project(this.#object).map((v,i)=>v-(i===1?this.#objectHeight*18*this.#camera.fit:0)),
          destination:this.#project(this.#destination),
          destinationSurface:this.#project(this.#destination).map((v,i)=>v-(i===1?this.#destinationHeight*18*this.#camera.fit:0)),
          graspCount:this.#graspCount, releaseCount:this.#releaseCount,
          placed:!this.#attached && Math.abs(this.#objectHeight-this.#destinationHeight) < 1e-9 &&
            Math.hypot(this.#object[0]-this.#destination[0],this.#object[1]-this.#destination[1]) <= 12
        },
        description: `裝置 #${this.#seed} · ${{gantry:'直角座標龍門機構',corexy:'CoreXY 皮帶機構',fivebar:'五連桿平行機構'}[this.#kinematics] || '二連桿平面機構'} · 相機變更 ${this.#cameraVersion} · 馬達反轉 ${this.#motorFlips}${this.#scenario ? ` · 第 ${this.#scenario.trialNumber}/5 回合 · B 相對高度 ${this.#destinationHeight}` : ''}`,
        // Debug/evaluation only. Never include this object in worker messages.
        geometry: { kinematics: this.#kinematics, lengths: this.#lengths.slice(), jointAngles: this.#q.slice(),
          channelToJoint: this.#mapping.slice(), channelGains: this.#gains.slice(), ...(this.#kinematics === 'corexy' ? {backlash: this.#backlash, motor: this.#motor.slice(), belt: this.#belt.slice()} : {}), ...(this.#kinematics === 'fivebar' ? {fiveBar: {...this.#five, proximal: this.#five.proximal.slice(), distal: this.#five.distal.slice()}} : {}),
          camera: { ...this.#camera }, object:this.#object.slice(), destination:this.#destination.slice(),destinationHeight:this.#destinationHeight,platformRadius:this.#platformRadius }
      };
    }
  }

  global.VirtualPlant = VirtualPlant;
})(globalThis);
