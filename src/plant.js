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

    // kinematics '2r' is the original two-link arm; 'gantry' is a Cartesian
    // two-axis carriage with travel limits. Both hide mapping, signs and gains.
    constructor({ seed = 42, width = 640, height = 480, kinematics = '2r' } = {}) {
      if (!['2r', 'gantry'].includes(kinematics)) throw new Error('PLANT: unknown kinematics.');
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
      const radius = this.#kinematics === 'gantry' ? Math.min(...this.#travel) * .84 : (this.#lengths[0] + this.#lengths[1]) * .77;
      const jitter = Math.sin(this.#seed * .173 + index * 2.1) * 3;
      const pointAt = degrees => {
        const angle = (degrees + jitter) * Math.PI / 180 - this.#camera.angle;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      };
      if (initialPose && this.#kinematics === 'gantry') {
        this.#q = pointAt(135);
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

    act(action) {
      if (action && !Array.isArray(action)) return this.#manipulate(action);
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
        const delta = [this.#kinematics === 'gantry' ? nextQ[0]-this.#q[0] : wrap(nextQ[0]-this.#q[0]),nextQ[1]-this.#q[1]];
        const clearance = this.#platformRadius + (this.#attached ? 8 : 0);
        for (let sample=0; sample<=16; sample++) {
          const point = this.#point(this.#q.map((value,j)=>value+delta[j]*sample/16));
          if (Math.hypot(point[0]-this.#destination[0],point[1]-this.#destination[1]) < clearance) {
            throw new Error('COLLISION: raise the end effector before crossing the elevated platform; no channels moved.');
          }
        }
      }
      this.#q = nextQ;
      if (this.#attached) this.#object = this.#point();
      return { applied, limited };
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
      if (this.#kinematics === 'gantry') return [q[0], q[1]];
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
        const q = this.#kinematics === 'gantry'
          ? [(this.#random() * 2 - 1) * this.#travel[0] * .85, (this.#random() * 2 - 1) * this.#travel[1] * .85]
          : [this.#q[0] + (this.#random() * 2 - 1) * 0.95, 0.65 + this.#random() * 1.6];
        candidate = this.#point(q);
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
      if (this.#kinematics === 'gantry') {
        // Two fixed rails along world x and a bridge that follows the carriage.
        // Neutral greys only: the colour detector must not see these parts.
        const [tx, ty] = this.#travel.map(v => v + 18), point = this.#point();
        for (const y of [-ty, ty]) line(this.#project([-tx, y]), this.#project([tx, y]), 10 * fit, '#314758');
        for (const y of [-ty, ty]) line(this.#project([-tx, y]), this.#project([tx, y]), 4 * fit, '#a0afbb');
        line(this.#project([point[0], -ty]), this.#project([point[0], ty]), 14 * fit, '#314758');
        line(this.#project([point[0], -ty]), this.#project([point[0], ty]), 7 * fit, '#8294a4');
        disk(tip, 11 * fit, '#263a4b');
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
        description: `裝置 #${this.#seed} · ${this.#kinematics === 'gantry' ? '直角座標龍門機構' : '二連桿平面機構'} · 相機變更 ${this.#cameraVersion} · 馬達反轉 ${this.#motorFlips}${this.#scenario ? ` · 第 ${this.#scenario.trialNumber}/5 回合 · B 相對高度 ${this.#destinationHeight}` : ''}`,
        // Debug/evaluation only. Never include this object in worker messages.
        geometry: { kinematics: this.#kinematics, lengths: this.#lengths.slice(), jointAngles: this.#q.slice(),
          channelToJoint: this.#mapping.slice(), channelGains: this.#gains.slice(),
          camera: { ...this.#camera }, object:this.#object.slice(), destination:this.#destination.slice(),destinationHeight:this.#destinationHeight,platformRadius:this.#platformRadius }
      };
    }
  }

  global.VirtualPlant = VirtualPlant;
})(globalThis);
