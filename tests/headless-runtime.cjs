'use strict';
// Deterministic, offline integration transport for the production lab scripts.
// Rasterizes the REAL plant drawing commands; never substitutes detections or
// attachment/placement truth. This deliberately does NOT certify browser CSP,
// native Worker isolation, text rendering, antialiasing, UI layout or real APIs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));

function color(value) {
  if (typeof value !== 'string') throw new Error('Headless canvas supports solid colors only.');
  if (/^#[\da-f]{6}$/i.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(255);
  if (/^#[\da-f]{3}$/i.test(value)) return [1, 2, 3].map(i => parseInt(value[i] + value[i], 16)).concat(255);
  const parts = /^rgba?\(([^)]+)\)$/.exec(value)?.[1].split(',').map(Number);
  if (parts) return [parts[0], parts[1], parts[2], parts.length === 4 ? Math.round(parts[3] * 255) : 255];
  throw new Error('Unsupported canvas color: ' + value);
}

class SoftwareCanvas {
  constructor() { this._width = 300; this._height = 150; this._pixels = new Uint8ClampedArray(300 * 150 * 4); this._context = new SoftwareContext(this); }
  get width() { return this._width; }
  set width(v) { this._width = Math.floor(v); this._pixels = new Uint8ClampedArray(this.width * this.height * 4); }
  get height() { return this._height; }
  set height(v) { this._height = Math.floor(v); this._pixels = new Uint8ClampedArray(this.width * this.height * 4); }
  getContext(kind) { if (kind !== '2d') throw new Error('Only software 2D canvas is supported.'); return this._context; }
  toDataURL() { throw new Error('Headless integration must use recordFrames:false; PNG encoding is not emulated.'); }
}
class SoftwareContext {
  constructor(canvas) { this.canvas = canvas; this.fillStyle = '#000000'; this.strokeStyle = '#000000'; this.lineWidth = 1; this._path = []; this._stack = []; }
  _paint(x, y, rgba) {
    const c = this.canvas;
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
    const i = (y * c.width + x) * 4, p = c._pixels, alpha = rgba[3] / 255;
    if (alpha === 1) { p[i] = rgba[0]; p[i + 1] = rgba[1]; p[i + 2] = rgba[2]; p[i + 3] = 255; return; }
    const destAlpha = p[i + 3] / 255, outAlpha = alpha + destAlpha * (1 - alpha);
    for (let k = 0; k < 3; k++) p[i + k] = outAlpha ? (rgba[k] * alpha + p[i + k] * destAlpha * (1 - alpha)) / outAlpha : 0;
    p[i + 3] = outAlpha * 255;
  }
  _box(x0, y0, x1, y1, predicate, rgba) {
    const c = this.canvas;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(c.height, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(c.width, Math.ceil(x1)); x++)
        if (predicate(x + .5, y + .5)) this._paint(x, y, rgba);
  }
  _disk(x, y, radius, rgba, inner = 0) {
    this._box(x - radius, y - radius, x + radius, y + radius, (px, py) => {
      const square = (px - x) ** 2 + (py - y) ** 2;
      return square <= radius ** 2 && square >= inner ** 2;
    }, rgba);
  }
  _line(a, b, width, rgba) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2));
    for (let i = 0; i <= steps; i++) this._disk(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps, Math.max(.55, width / 2), rgba);
  }
  clearRect(x, y, w, h) {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.canvas.height, y + h); yy++)
      this.canvas._pixels.fill(0, (yy * this.canvas.width + Math.max(0, Math.floor(x))) * 4, (yy * this.canvas.width + Math.min(this.canvas.width, Math.ceil(x + w))) * 4);
  }
  fillRect(x, y, w, h) { this._box(x, y, x + w, y + h, (px, py) => px >= x && px < x + w && py >= y && py < y + h, color(this.fillStyle)); }
  strokeRect(x, y, w, h) {
    const rgba = color(this.strokeStyle);
    for (const [a, b] of [[[x, y], [x + w, y]], [[x + w, y], [x + w, y + h]], [[x + w, y + h], [x, y + h]], [[x, y + h], [x, y]]]) this._line(a, b, this.lineWidth, rgba);
  }
  beginPath() { this._path = []; this._last = null; this._first = null; }
  moveTo(x, y) { this._last = [x, y]; if (!this._first) this._first = this._last; }
  lineTo(x, y) { const point = [x, y]; if (this._last) this._path.push({ type: 'line', a: this._last, b: point }); this._last = point; }
  closePath() { if (this._first && this._last) this.lineTo(...this._first); }
  arc(x, y, r, start, end) {
    if (Math.abs(end - start) < Math.PI * 2 - 1e-6) throw new Error('Only full-circle plant arcs are currently supported.');
    this._path.push({ type: 'arc', x, y, r });
  }
  stroke() {
    const rgba = color(this.strokeStyle);
    for (const part of this._path) {
      if (part.type === 'line') this._line(part.a, part.b, this.lineWidth, rgba);
      else this._disk(part.x, part.y, part.r + this.lineWidth / 2, rgba, Math.max(0, part.r - this.lineWidth / 2));
    }
  }
  fill() {
    const rgba = color(this.fillStyle), lines = this._path.filter(p => p.type === 'line');
    for (const part of this._path) if (part.type === 'arc') this._disk(part.x, part.y, part.r, rgba);
    if (lines.length) {
      const xs = lines.flatMap(p => [p.a[0], p.b[0]]), ys = lines.flatMap(p => [p.a[1], p.b[1]]);
      this._box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (x, y) => {
        let inside = false;
        for (const { a, b } of lines) if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        return inside;
      }, rgba);
    }
  }
  fillText() {} // Neutral nameplate text is irrelevant to the offline color detector.
  save() { this._stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); }
  restore() { Object.assign(this, this._stack.pop() || {}); }
  setLineDash(values) { if (values.length) throw new Error('Dashed raster paths are not supported.'); }
  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) data.set(this.canvas._pixels.subarray(((y + row) * this.canvas.width + x) * 4, ((y + row) * this.canvas.width + x + width) * 4), row * width * 4);
    return { width, height, data };
  }
  putImageData(image, x, y) {
    for (let row = 0; row < image.height; row++) this.canvas._pixels.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * this.canvas.width + x) * 4);
  }
}

function createRuntime({ extraSources = [] } = {}) {
  const blobs = new Map(), listeners = new Set(), workers = new Set();
  let sequence = 0;
  class ScriptBlob { constructor(parts) { this.source = parts.join(''); } }
  const scriptURLs = { createObjectURL(blob) { const key = 'headless:blob:' + (++sequence); blobs.set(key, blob.source); return key; }, revokeObjectURL(key) { blobs.delete(key); } };
  class VMWorker {
    constructor(url) {
      this.terminated = false; workers.add(this);
      const source = blobs.get(url);
      if (typeof source !== 'string') throw new Error('Unknown worker source URL.');
      this.context = vm.createContext({ Uint8ClampedArray, Uint32Array, structuredClone });
      this.context.self = this.context;
      this.context.postMessage = data => queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: structuredClone(data) }); });
      vm.runInContext(source, this.context, { timeout: 1000, filename: 'production-worker.js' });
    }
    postMessage(data) {
      queueMicrotask(() => {
        if (this.terminated) return;
        try {
          this.context.__event = { data: structuredClone(data) };
          const task = vm.runInContext('self.onmessage(__event)', this.context, { timeout: 1000 });
          task?.catch?.(error => this.onerror?.({ message: error.message, preventDefault() {} }));
        } catch (error) { this.onerror?.({ message: error.message, preventDefault() {} }); }
      });
    }
    terminate() { this.terminated = true; workers.delete(this); }
  }
  const dispatch = event => { for (const listener of listeners) listener(event); };
  function iframe() {
    const frame = { setAttribute() {}, remove() { this._removed = true; }, srcdoc: '' }, innerListeners = new Set();
    const parent = { postMessage(data) { queueMicrotask(() => { if (!frame._removed) dispatch({ source: frame.contentWindow, data: structuredClone(data) }); }); } };
    frame.contentWindow = { postMessage(data) {
      queueMicrotask(() => { if (!frame._removed) for (const listener of innerListeners) listener({ source: parent, data: structuredClone(data) }); });
    } };
    frame._append = () => {
      const script = /<script>([\s\S]*)<\/script>/.exec(frame.srcdoc)?.[1];
      if (!script) throw new Error('Missing generated driver broker script.');
      const context = vm.createContext({ parent, Blob: ScriptBlob, URL: scriptURLs, Worker: VMWorker, addEventListener(name, listener) { if (name === 'message') innerListeners.add(listener); } });
      vm.runInContext(script, context, { timeout: 1000, filename: 'production-driver-broker.js' });
    };
    return frame;
  }
  const document = {
    createElement(name) { if (name === 'canvas') return new SoftwareCanvas(); if (name === 'iframe') return iframe(); throw new Error('Unexpected element: ' + name); },
    getElementById(id) {
      const file = { 'controller-source': 'controller.js', 'agent-source': 'agent-core.js' }[id];
      return file ? { textContent: fs.readFileSync(path.join(root, 'src', file), 'utf8') } : null;
    },
    body: { append(frame) { frame._append(); } }
  };
  const context = vm.createContext({ document, Blob: ScriptBlob, URL: scriptURLs, Worker: VMWorker,
    ImageData: class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    Uint8ClampedArray, Uint32Array, setTimeout, clearTimeout, performance,
    crypto: { getRandomValues(array) { return crypto.randomFillSync(array); } },
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); }
  });
  for (const file of ['plant.js', 'claude-provider.js', 'controller.js', 'agent-core.js', 'device-link.js', 'driver-runtime.js', 'engine.js', 'onboarding.js', 'pick-place.js', ...extraSources])
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file, timeout: 1000 });
  return { global: context, close() { for (const worker of workers) worker.terminate(); listeners.clear(); blobs.clear(); } };
}
module.exports = { createRuntime, SoftwareCanvas, plain, root };
