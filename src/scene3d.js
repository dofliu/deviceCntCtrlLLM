(function (global) {
  'use strict';

  // Human observer view only. These diagnostics never enter the controller.
  // XY is the plant's two-link model. Discrete lift, grip and object states
  // below are read from diagnostics; this view never determines success.
  const UNIT = 0.01;
  const TAU = Math.PI * 2;
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));

  class DeviceScene {
    constructor(canvas) {
      if (!global.THREE) throw new Error('3D 元件未載入；仍可使用下方相機影像完成實驗。');
      const T = global.THREE;
      this.T = T;
      this.canvas = canvas;
      this.resources = new Set();
      this.disposed = false;
      this.azimuth = 0.65;
      this.elevation = 0.92;
      this.zoom = 1;
      this.armKey = '';
      this.diag = null;
      try {
        this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
      } catch (error) {
        throw new Error('這個瀏覽器無法啟用 WebGL；請使用下方相機影像繼續逐步實驗。');
      }
      this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      if ('outputColorSpace' in this.renderer) this.renderer.outputColorSpace = T.SRGBColorSpace;
      else this.renderer.outputEncoding = T.sRGBEncoding;
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.92;
      this.scene = new T.Scene();
      this.scene.background = new T.Color('#e9eeea');
      this.camera = new T.OrthographicCamera(-3, 3, 2, -2, 0.1, 35);
      this.materials = {
        table: this.material('#f2eee4', 0.05, 0.80),
        edge: this.material('#adb7ae', 0.3, 0.6),
        dark: this.material('#243c42', 0.50, 0.35),
        darkest: this.material('#172a2f', 0.45, 0.42),
        cover: this.material('#e1e5de', 0.50, 0.30),
        steel: this.material('#9cafad', 0.8, 0.25),
        mint: this.material('#65d8c3', 0.35, 0.32),
        coral: this.material('#ed719a', 0.1, 0.5),
        amber: this.material('#e9a627', 0.1, 0.48),
        cyan: this.material('#17beba', 0.15, 0.4),
        ground: this.material('#d8e0d9', 0.05, 0.95)
      };
      const sky = new T.HemisphereLight(0xffffff, 0x6d8585, 0.82);
      this.scene.add(sky);
      const key = new T.DirectionalLight(0xfff4dc, 1.2);
      key.position.set(-3, 7, 4);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 16 });
      key.shadow.normalBias = 0.025;
      key.shadow.bias = -0.0002;
      this.scene.add(key);
      const fill = new T.DirectionalLight(0xd0e8ff, 0.35);
      fill.position.set(4, 3, -4);
      this.scene.add(fill);
      this.makeStation();
      this.makeOverlays();
      this.bindInteraction();
      this.resize();
    }

    material(color, metalness, roughness) {
      const material = new this.T.MeshStandardMaterial({ color: this.displayColor(color), metalness, roughness });
      this.resources.add(material);
      return material;
    }

    displayColor(value) {
      const color = new this.T.Color(value);
      // The bundled Three r128 predates automatic sRGB input conversion.
      if (Number.parseInt(this.T.REVISION, 10) < 152) color.convertSRGBToLinear();
      return color;
    }

    mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
      const obj = new this.T.Mesh(geometry, material);
      obj.position.set(x, y, z);
      obj.castShadow = true;
      obj.receiveShadow = true;
      parent.add(obj);
      return obj;
    }

    box(w, h, d, mat, parent, x = 0, y = 0, z = 0) {
      return this.mesh(new this.T.BoxGeometry(w, h, d), mat, parent, x, y, z);
    }

    cylinder(radius, h, mat, parent, x = 0, y = 0, z = 0, segments = 40) {
      return this.mesh(new this.T.CylinderGeometry(radius, radius, h, segments), mat, parent, x, y, z);
    }

    ring(radius, tube, color, parent, x = 0, y = 0, z = 0) {
      const mat = new this.T.MeshBasicMaterial({ color: this.displayColor(color), toneMapped: false });
      this.resources.add(mat);
      const ring = this.mesh(new this.T.TorusGeometry(radius, tube, 8, 64), mat, parent, x, y, z);
      ring.rotation.x = Math.PI / 2;
      ring.castShadow = false;
      ring.receiveShadow = false;
      return ring;
    }

    label(text, parent, x, y, z, width = 0.68, color = '#203c41', background = '#f4f5ee') {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 112;
      const ctx = c.getContext('2d');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = 'rgba(20,50,60,.16)'; ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 59px Consolas, monospace';
      let fontSize=59;
      while(ctx.measureText(text).width>480&&fontSize>22){fontSize-=2;ctx.font=`700 ${fontSize}px Consolas, monospace`;}
      ctx.fillText(text, 256, 57);
      const texture = new this.T.CanvasTexture(c);
      if ('colorSpace' in texture) texture.colorSpace = this.T.SRGBColorSpace;
      else texture.encoding = this.T.sRGBEncoding;
      const material = new this.T.SpriteMaterial({ map: texture, depthTest: true, transparent: true, toneMapped: false });
      const label = new this.T.Sprite(material);
      label.scale.set(width, width * 112 / 512, 1);
      label.position.set(x, y, z);
      label.userData.ownMaterial = true;
      parent.add(label);
      return label;
    }

    makeStation() {
      const T = this.T, m = this.materials;
      this.station = new T.Group();
      this.scene.add(this.station);
      this.box(5.35, 0.16, 4.4, m.edge, this.station, 0, -0.16, 0);
      this.box(5.35, 0.07, 4.4, m.table, this.station, 0, -0.05, 0);
      const grid = new T.GridHelper(4.0, 16, this.displayColor('#b2bdb1'), this.displayColor('#c8d0c4'));
      this.resources.add(grid.material);
      grid.position.y = -0.012;
      grid.material.opacity = 0.56; grid.material.transparent = true;
      this.station.add(grid);
      for (const x of [-2.48, 2.48]) for (const z of [-2.0, 2.0]) {
        this.cylinder(0.025, 0.009, m.steel, this.station, x, -0.01, z, 12);
      }
      this.box(1.26, 0.018, 0.16, m.dark, this.station, -0.65, 0.002, 1.28);
      this.box(0.12, 0.02, 0.16, m.mint, this.station, -1.22, 0.004, 1.28);
      this.label('VLAB-P2 / PICK & PLACE', this.station, -0.55, 0.20, 1.28, 1.4);
      // A compact overhead camera fixture places the virtual image source in
      // context. It is illustrative; the actual image is the 2D camera panel.
      const post = new T.Group();
      post.position.set(-1.05, 0, -0.55);
      this.station.add(post);
      this.box(0.42, 0.07, 0.34, m.dark, post, 0, 0.025, 0);
      this.box(0.095, 1.1, 0.095, m.steel, post, 0, 0.59, 0);
      this.box(0.85, 0.075, 0.09, m.steel, post, 0.38, 1.18, 0);
      const cameraBody = this.box(0.24, 0.14, 0.21, m.dark, post, 0.72, 1.10, 0);
      cameraBody.castShadow = false;
      this.cylinder(0.065, 0.045, m.darkest, post, 0.72, 1.005, 0);
      const lens = this.cylinder(0.048, 0.012, m.mint, post, 0.72, 0.976, 0);
      lens.castShadow = false;
      this.label('CAMERA', post, 0.35, 1.37, 0, 0.62);
      this.box(0.19, 0.04, 0.29, m.dark, post, 0, 0.035, 0.47);
      this.box(0.14, 0.025, 0.05, m.mint, post, 0, 0.065, 0.57);
      // Base is fixed to the table while both joints move in the x-z plane.
      this.base = new T.Group();
      this.station.add(this.base);
      this.box(0.55, 0.075, 0.51, m.darkest, this.base, 0, 0.037, 0);
      for (const x of [-0.22, 0.22]) for (const z of [-0.2, 0.2]) {
        this.cylinder(0.026, 0.01, m.steel, this.base, x, 0.08, z, 6);
      }
      this.cylinder(0.195, 0.25, m.dark, this.base, 0, 0.20, 0);
      this.cylinder(0.205, 0.035, m.mint, this.base, 0, 0.30, 0);
      this.cylinder(0.16, 0.10, m.cover, this.base, 0, 0.36, 0);
      this.cylinder(0.11, 0.04, m.steel, this.base, 0, 0.425, 0);
    }

    capsule(length, width, height, material, parent, y = 0) {
      const radius = width / 2;
      this.box(length, height, width, material, parent, length / 2, y, 0);
      this.cylinder(radius, height, material, parent, 0, y, 0);
      this.cylinder(radius, height, material, parent, length, y, 0);
    }

    makeArm(geometry) {
      if (this.arm) {
        this.station.remove(this.arm);
        this.disposeGroup(this.arm);
      }
      const T = this.T, m = this.materials;
      const lengths = geometry.lengths.map(v => v * UNIT);
      this.arm = new T.Group();
      this.arm.position.y = 0.47;
      this.station.add(this.arm);
      this.link1 = new T.Group(); this.arm.add(this.link1);
      this.capsule(lengths[0], 0.24, 0.10, m.dark, this.link1);
      this.capsule(lengths[0] - 0.07, 0.17, 0.025, m.cover, this.link1, 0.060);
      this.box(Math.max(0.15, lengths[0] - 0.3), 0.026, 0.032, m.mint, this.link1, lengths[0] / 2, 0.078, 0);
      this.cylinder(0.12, 0.032, m.darkest, this.link1, 0, 0.092, 0);
      this.cylinder(0.063, 0.024, m.steel, this.link1, 0, 0.120, 0);
      this.cylinder(0.155, 0.125, m.darkest, this.link1, lengths[0], 0.035, 0);
      this.cylinder(0.155, 0.025, m.mint, this.link1, lengths[0], 0.098, 0);
      this.link2 = new T.Group();
      this.link2.position.set(lengths[0], 0.13, 0);
      this.link1.add(this.link2);
      this.capsule(lengths[1], 0.20, 0.085, m.dark, this.link2);
      this.capsule(lengths[1] - 0.06, 0.135, 0.021, m.cover, this.link2, 0.052);
      this.box(Math.max(0.15, lengths[1] - 0.28), 0.024, 0.025, m.mint, this.link2, lengths[1] / 2, 0.067, 0);
      this.cylinder(0.092, 0.025, m.darkest, this.link2, 0, 0.08, 0);
      this.cylinder(0.045, 0.022, m.steel, this.link2, 0, 0.099, 0);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        this.cylinder(0.012, 0.008, m.steel, this.link1, Math.cos(a) * 0.082, 0.112, Math.sin(a) * 0.082, 6);
        this.cylinder(0.010, 0.008, m.steel, this.link2, Math.cos(a) * 0.070, 0.098, Math.sin(a) * 0.070, 6);
      }
      // A discrete lifting end effector, rendered from actual plant state.
      this.cylinder(0.076, 0.15, m.dark, this.link2, lengths[1], -0.015, 0);
      this.liftRod=this.cylinder(0.027, 0.40, m.steel, this.link2, lengths[1], -0.20, 0);
      this.gripper=new T.Group();this.link2.add(this.gripper);this.gripper.position.set(lengths[1],-.30,0);
      this.box(.16,.08,.18,m.dark,this.gripper,0,.04,0);
      this.box(.11,.015,.13,m.mint,this.gripper,0,.086,0);
      this.jawA=this.box(.10,.16,.035,m.steel,this.gripper,0,-.065,.105);
      this.jawB=this.box(.10,.16,.035,m.steel,this.gripper,0,-.065,-.105);
      this.box(.055,.015,.035,m.cyan,this.jawA,0,-.076,0);
      this.box(.055,.015,.035,m.cyan,this.jawB,0,-.076,0);
      this.cylinder(0.064, 0.020, m.mint, this.link2, lengths[1], 0.082, 0);
      const jointChannel = j => geometry.channelToJoint.indexOf(j) === 0 ? 'CH A' : 'CH B';
      this.label(jointChannel(0), this.link1, 0, 0.34, 0, 0.60);
      this.label(jointChannel(1), this.link2, 0, 0.27, 0, 0.60);
    }

    makeOverlays() {
      const T = this.T;
      this.pickObject=new T.Group();this.station.add(this.pickObject);
      this.box(.15,.13,.15,this.materials.amber,this.pickObject,0,.065,0);
      this.box(.035,.006,.14,this.materials.dark,this.pickObject,0,.133,0);
      this.label('A / OBJECT',this.pickObject,0,.24,0,.65,'#805420','#fff3d4');
      this.destination=new T.Group();this.station.add(this.destination);
      this.platform=this.cylinder(.24,1,this.materials.dark,this.station,0,0,0);
      this.platform.visible=false;
      this.ring(.19,.011,'#4977ef',this.destination,0,.026,0);
      this.ring(.23,.003,'#4977ef',this.destination,0,.026,0);
      const destinationMat=new T.MeshBasicMaterial({color:this.displayColor('#4977ef'),transparent:true,opacity:.11,depthWrite:false});this.resources.add(destinationMat);
      this.mesh(new T.CylinderGeometry(.19,.19,.009,48),destinationMat,this.destination,0,.016,0);
      this.label('B / PLACE',this.destination,0,.12,-.25,.65,'#375696','#eef2ff');
      this.target = new T.Group(); this.station.add(this.target);
      this.ring(0.147, 0.011, '#e754a3', this.target, 0, 0.022, 0);
      this.ring(0.18, 0.003, '#e754a3', this.target, 0, 0.023, 0);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        const tick = this.box(0.065, 0.006, 0.008, this.materials.coral, this.target, Math.cos(a) * 0.205, 0.025, Math.sin(a) * 0.205);
        tick.rotation.y = -a;
      }
      this.actual = new T.Group(); this.station.add(this.actual);
      this.ring(0.065, 0.009, '#08b3b2', this.actual, 0, 0.030, 0);
      this.prediction = new T.Group(); this.station.add(this.prediction);
      this.ring(0.093, 0.012, '#e49b19', this.prediction, 0, 0.053, 0);
      const ghostMat = new T.MeshBasicMaterial({ color: this.displayColor('#f5b537'), transparent: true, opacity: 0.27, depthWrite: false });
      this.resources.add(ghostMat);
      this.mesh(new T.CylinderGeometry(0.037, 0.037, 0.22, 24), ghostMat, this.prediction, 0, 0.14, 0);
      this.label('PREDICT', this.prediction, 0, 0.42, 0, 0.54, '#684300', '#fff1c9');
      this.before = new T.Group(); this.station.add(this.before);
      this.ring(0.056, 0.007, '#6c8488', this.before, 0, 0.032, 0);
      this.motion = new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(), 1, this.displayColor('#05a8a3'), 0.07, 0.04);
      this.predictedArrow = new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(), 1, this.displayColor('#d7971b'), 0.065, 0.045);
      this.station.add(this.motion, this.predictedArrow);
      this.prediction.visible = this.before.visible = this.motion.visible = this.predictedArrow.visible = false;
    }

    unproject(point, camera) {
      if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) return null;
      const x = (point[0] - camera.x) / camera.scale;
      const z = (point[1] - camera.y) / camera.scale;
      return [(Math.cos(camera.angle) * x + Math.sin(camera.angle) * z) * UNIT,
        (-Math.sin(camera.angle) * x + Math.cos(camera.angle) * z) * UNIT];
    }

    place(group, point) {
      group.visible = !!point;
      if (point) group.position.set(point[0], 0, point[1]);
    }

    setArrow(arrow, before, after, height) {
      if (!before || !after) { arrow.visible = false; return; }
      const dx = after[0] - before[0], dz = after[1] - before[1], length = Math.hypot(dx, dz);
      arrow.visible = length > 0.006;
      if (!arrow.visible) return;
      arrow.position.set(before[0], height, before[1]);
      arrow.setDirection(new this.T.Vector3(dx / length, 0, dz / length));
      arrow.setLength(length, Math.min(0.075, length * 0.35), Math.min(0.045, length * 0.23));
    }

    update(diagnostics, { predicted = null, beforeTip = null, afterTip = null } = {}) {
      if (this.disposed || !diagnostics || !diagnostics.geometry) return;
      this.diag = diagnostics;
      const g = diagnostics.geometry;
      const key = JSON.stringify([g.lengths, g.channelToJoint]);
      if (key !== this.armKey) { this.makeArm(g); this.armKey = key; }
      // Three.js positive y rotation turns +x toward -z. Reverse it so the
      // same planar q used by the plant turns +x toward positive image/world y.
      this.link1.rotation.y = -g.jointAngles[0];
      this.link2.rotation.y = -g.jointAngles[1];
      const task=diagnostics.pickPlace;
      this.pickObject.visible=!!task;this.destination.visible=!!task;
      if(task){
        const liftHeight=Number.isFinite(task.liftHeight)?task.liftHeight:(task.lift==='up'?1:0);
        const surfaceHeight=Number.isFinite(task.destinationHeight)?task.destinationHeight:0;
        this.gripper.position.y=-.47+.22*liftHeight;
        this.liftRod.position.y=-.21+.11*liftHeight;
        this.liftRod.scale.y=1.03-.55*liftHeight;
        const separation=task.gripper==='closed'?.073:.12;
        this.jawA.position.z=separation;this.jawB.position.z=-separation;
        if(Array.isArray(task.object))this.pickObject.position.set(task.object[0]*UNIT,task.objectHeight*.22,task.object[1]*UNIT);
        this.platform.visible=surfaceHeight>0;
        if(Array.isArray(task.destination)){
          this.destination.position.set(task.destination[0]*UNIT,surfaceHeight*.22,task.destination[1]*UNIT);
          this.platform.position.set(task.destination[0]*UNIT,surfaceHeight*.11,task.destination[1]*UNIT);
          this.platform.scale.y=Math.max(.0001,surfaceHeight*.22);
        }
      }
      const actual = this.unproject(diagnostics.tip, g.camera);
      const target = this.unproject(diagnostics.target, g.camera);
      const p = this.unproject(predicted, g.camera);
      const b = this.unproject(beforeTip, g.camera);
      const a = this.unproject(afterTip, g.camera);
      this.place(this.actual, actual);
      this.actual.visible = !diagnostics.occluded && !!actual;
      this.place(this.target, target);
      this.place(this.prediction, p);
      this.place(this.before, b);
      this.setArrow(this.motion, b, a, 0.050);
      this.setArrow(this.predictedArrow, b || actual, p, 0.082);
      this.render();
    }

    bindInteraction() {
      this.canvas.style.touchAction = 'pan-y';
      this.canvas.style.cursor = 'grab';
      this.canvas.setAttribute('aria-label', '設備立體觀察圖，可用滑鼠拖曳旋轉，滾輪縮放；控制器不會讀取此圖。');
      let drag = null;
      this.onDown = e => {
        if (e.pointerType === 'touch') return;
        drag = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = 'grabbing';
      };
      this.onMove = e => {
        if (!drag) return;
        this.azimuth -= (e.clientX - drag.x) * 0.006;
        this.elevation = clamp(this.elevation + (e.clientY - drag.y) * 0.004, 0.48, 1.28);
        drag = { x: e.clientX, y: e.clientY };
        this.updateView(); this.render();
      };
      this.onUp = () => { drag = null; this.canvas.style.cursor = 'grab'; };
      this.onWheel = e => {
        e.preventDefault();
        this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0006), 0.8, 1.6);
        this.camera.zoom = this.zoom; this.camera.updateProjectionMatrix(); this.render();
      };
      this.onDoubleClick = () => {
        this.azimuth = 0.65; this.elevation = 0.92; this.zoom = 1;
        this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.updateView(); this.render();
      };
      this.canvas.addEventListener('pointerdown', this.onDown);
      this.canvas.addEventListener('pointermove', this.onMove);
      this.canvas.addEventListener('pointerup', this.onUp);
      this.canvas.addEventListener('pointercancel', this.onUp);
      this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
      this.canvas.addEventListener('dblclick', this.onDoubleClick);
      this.onResize = () => this.resize();
      if (global.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(this.onResize);
        this.resizeObserver.observe(this.canvas);
      } else global.addEventListener('resize', this.onResize);
    }

    updateView() {
      const horizontal = Math.cos(this.elevation) * 8;
      this.camera.position.set(Math.sin(this.azimuth) * horizontal, Math.sin(this.elevation) * 8 + 0.1, Math.cos(this.azimuth) * horizontal);
      this.camera.lookAt(0.10, 0.25, 0.04);
    }

    resize() {
      if (this.disposed) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 900));
      const h = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 540));
      this.renderer.setSize(w, h, false);
      const aspect = w / h, height = Math.max(3.5, 5.2 / aspect);
      Object.assign(this.camera, { left: -height * aspect / 2, right: height * aspect / 2, top: height / 2, bottom: -height / 2 });
      this.camera.updateProjectionMatrix();
      this.updateView(); this.render();
    }

    render() { if (!this.disposed) this.renderer.render(this.scene, this.camera); }

    disposeGroup(group) {
      group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.userData.ownMaterial && obj.material) {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      });
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      global.removeEventListener('resize', this.onResize);
      this.canvas.removeEventListener('pointerdown', this.onDown);
      this.canvas.removeEventListener('pointermove', this.onMove);
      this.canvas.removeEventListener('pointerup', this.onUp);
      this.canvas.removeEventListener('pointercancel', this.onUp);
      this.canvas.removeEventListener('wheel', this.onWheel);
      this.canvas.removeEventListener('dblclick', this.onDoubleClick);
      this.disposeGroup(this.scene);
      this.resources.forEach(resource => resource.dispose());
      for (const arrow of [this.motion, this.predictedArrow]) {
        if (arrow.line.material) arrow.line.material.dispose();
        if (arrow.cone.material) arrow.cone.material.dispose();
      }
      this.renderer.dispose();
    }
  }

  global.DeviceScene = DeviceScene;
})(globalThis);
