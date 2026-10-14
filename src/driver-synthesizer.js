(function (global) {
  'use strict';
  // Offline, rule-based driver generator for the no-template experiment. It
  // reads ONLY the machine-readable manual.protocolSpec and emits encode/decode
  // source. It is deterministic code generation from a specification, not a
  // language model; reports label its output 'offline-spec-synthesizer'.
  // Supported framing families: json-line, binary-frame and modbus-rtu.
  const LIMIT = 0.1;
  const lit = value => JSON.stringify(value);

  function fromJsonLine(spec) {
    const commands = spec.commands || {}, reply = spec.reply || {};
    for (const name of ['step', 'lift', 'grip']) if (!commands[name] || typeof commands[name].fields !== 'object') throw new Error(`SPEC: json-line spec lacks ${name}.fields.`);
    for (const key of ['okField', 'appliedField', 'limitedField']) if (typeof reply[key] !== 'string') throw new Error(`SPEC: json-line reply lacks ${key}.`);
    const max = Number.isFinite(commands.step.xy?.max) ? commands.step.xy.max : LIMIT;
    const liftValues = commands.lift.values || ['up', 'down'], gripValues = commands.grip.values || ['open', 'closed'];
    return `// Generated offline from manual.protocolSpec (${spec.name || 'json-line'}); no driver template used.
const SPEC = ${lit({step: commands.step.fields, lift: commands.lift.fields, grip: commands.grip.fields, max, liftValues, gripValues, terminator: spec.wire?.terminator ?? '\n', reply})};
function fill(template, values) {
  const out = {};
  for (const key of Object.keys(template)) {
    const value = template[key];
    out[key] = typeof value === 'string' && value[0] === '$' ? values[value.slice(1)] : value;
  }
  return out;
}
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(','); }
function encode(command) {
  let packet;
  if (Array.isArray(command) && command.length === 2 && command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SPEC.max)) {
    packet = fill(SPEC.step, {xy: command.slice()});
  } else if (exactKeys(command, ['op', 'position']) && command.op === 'lift' && SPEC.liftValues.includes(command.position)) {
    packet = fill(SPEC.lift, {position: command.position});
  } else if (exactKeys(command, ['op', 'state']) && command.op === 'grip' && SPEC.gripValues.includes(command.state)) {
    packet = fill(SPEC.grip, {state: command.state});
  } else throw new Error('Unsupported or out-of-range command.');
  return JSON.stringify(packet) + SPEC.terminator;
}
function decode(rawReply) {
  if (typeof rawReply !== 'string') throw new Error('Reply must be text.');
  const reply = JSON.parse(rawReply);
  if (!reply || typeof reply !== 'object' || reply[SPEC.reply.okField] !== true) throw new Error('Device rejected the command.');
  const applied = reply[SPEC.reply.appliedField], limited = reply[SPEC.reply.limitedField];
  const xy = Array.isArray(applied) && applied.length === 2 && applied.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SPEC.max + 1e-12);
  const lift = exactKeys(applied, ['op', 'position']) && applied.op === 'lift' && SPEC.liftValues.includes(applied.position);
  const grip = exactKeys(applied, ['op', 'state']) && applied.op === 'grip' && SPEC.gripValues.includes(applied.state);
  if (!(xy || lift || grip) || typeof limited !== 'boolean') throw new Error('Malformed acknowledgement.');
  return {applied, limited};
}`;
  }

  function fromBinaryFrame(spec) {
    const frame = spec.frame || {}, commands = spec.commands || {}, reply = spec.reply || {};
    if (spec.wire?.text !== 'hex') throw new Error('SPEC: binary-frame synthesizer supports hex wire text only.');
    if (!Array.isArray(frame.sync) || frame.lengthBytes !== 1 || frame.checksum !== 'xor') throw new Error('SPEC: unsupported frame layout.');
    for (const name of ['step', 'lift', 'grip']) if (!Number.isInteger(commands[name]?.opcode) || !Array.isArray(commands[name].args)) throw new Error(`SPEC: binary spec lacks ${name}.opcode/args.`);
    for (const name of ['step', 'lift', 'grip']) if (!Array.isArray(reply.layouts?.[name])) throw new Error(`SPEC: binary reply lacks ${name} layout.`);
    const table = {sync: frame.sync, upper: spec.wire.case === 'upper', commands: {step: commands.step, lift: commands.lift, grip: commands.grip},
      reply: {statusOffset: reply.statusOffset, okStatus: reply.okStatus, opcodeOffset: reply.opcodeOffset, layouts: {step: reply.layouts.step, lift: reply.layouts.lift, grip: reply.layouts.grip}}, max: LIMIT};
    return `// Generated offline from manual.protocolSpec (${spec.name || 'binary-frame'}); no driver template used.
const SPEC = ${lit(table)};
function toHex(bytes) { const text = bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join(''); return SPEC.upper ? text.toUpperCase() : text; }
function checksum(bytes) { return bytes.reduce((x, b) => x ^ b, 0) & 255; }
function frame(payload) { const body = [payload.length, ...payload]; return toHex([...SPEC.sync, ...body, checksum(body)]); }
function field(arg, value) {
  if (arg.type === 'int16be') {
    const n = Math.round(value * arg.scale);
    if (!Number.isInteger(n) || n < -32768 || n > 32767) throw new Error('int16 overflow');
    const u = n < 0 ? n + 65536 : n; return [(u >> 8) & 255, u & 255];
  }
  if (arg.type === 'uint8') {
    const n = arg.map ? arg.map[value] : value;
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('uint8 argument out of range');
    return [n];
  }
  throw new Error('Unsupported field type ' + arg.type);
}
function pick(command, path) {
  const m = /^([a-z]+)\\[(\\d+)\\]$/i.exec(path);
  return m ? command[Number(m[2])] : command[path];
}
function encode(command) {
  let kind, source;
  if (Array.isArray(command) && command.length === 2 && command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SPEC.max)) { kind = 'step'; source = command; }
  else if (command && !Array.isArray(command) && Object.keys(command).sort().join(',') === 'op,position' && command.op === 'lift') { kind = 'lift'; source = command; }
  else if (command && !Array.isArray(command) && Object.keys(command).sort().join(',') === 'op,state' && command.op === 'grip') { kind = 'grip'; source = command; }
  else throw new Error('Unsupported or out-of-range command.');
  const spec = SPEC.commands[kind], payload = [spec.opcode];
  for (const arg of spec.args) {
    const from = kind === 'step' ? arg.from.replace(/^channels/, 'xy') : arg.from;
    const value = kind === 'step' ? source[Number(/\\[(\\d+)\\]/.exec(from)[1])] : pick(source, from);
    if (value === undefined) throw new Error('Missing command field ' + arg.from);
    payload.push(...field(arg, value));
  }
  return frame(payload);
}
function decode(rawReply) {
  if (typeof rawReply !== 'string' || rawReply.length < 8 || rawReply.length % 2 || !/^[0-9a-fA-F]+$/.test(rawReply)) throw new Error('Reply is not hex bytes.');
  if (!SPEC.upper && /[A-F]/.test(rawReply)) throw new Error('Reply must use lowercase hex.');
  const bytes = [];
  for (let i = 0; i < rawReply.length; i += 2) bytes.push(parseInt(rawReply.slice(i, i + 2), 16));
  for (let i = 0; i < SPEC.sync.length; i++) if (bytes[i] !== SPEC.sync[i]) throw new Error('Missing sync.');
  const start = SPEC.sync.length, length = bytes[start];
  if (bytes.length !== start + length + 2) throw new Error('Length mismatch.');
  const body = bytes.slice(start, -1);
  if (checksum(body) !== bytes[bytes.length - 1]) throw new Error('Checksum mismatch.');
  const payload = bytes.slice(start + 1, -1);
  if (payload[SPEC.reply.statusOffset] !== SPEC.reply.okStatus) throw new Error('Device reported error code ' + payload[SPEC.reply.statusOffset]);
  const opcode = payload[SPEC.reply.opcodeOffset];
  const kind = Object.keys(SPEC.commands).find(name => SPEC.commands[name].opcode === opcode);
  if (!kind) throw new Error('Unknown reply opcode.');
  const layout = SPEC.reply.layouts[kind];
  let offset = Math.max(SPEC.reply.statusOffset, SPEC.reply.opcodeOffset) + 1;
  const out = {}, applied = [];
  for (const item of layout) {
    if (item.type === 'int16be') {
      if (offset + 2 > payload.length) throw new Error('Reply too short.');
      const raw = (payload[offset] << 8) | payload[offset + 1], value = (raw >= 32768 ? raw - 65536 : raw) / item.scale;
      offset += 2;
      const m = /^applied\\[(\\d+)\\]$/.exec(item.to); if (m) applied[Number(m[1])] = value; else out[item.to] = value;
    } else if (item.type === 'uint8') {
      if (offset + 1 > payload.length) throw new Error('Reply too short.');
      const raw = payload[offset++], value = item.map ? item.map[raw] : raw;
      if (value === undefined) throw new Error('Unknown reply value.');
      out[item.to] = value;
    } else if (item.type === 'flag') {
      if (offset + 1 > payload.length) throw new Error('Reply too short.');
      const raw = payload[offset++]; if (raw > 1) throw new Error('Invalid flag byte.'); out[item.to] = raw === 1;
    } else throw new Error('Unsupported reply field.');
  }
  if (offset !== payload.length) throw new Error('Unexpected trailing reply bytes.');
  if (typeof out.limited !== 'boolean') throw new Error('Missing limited flag.');
  if (kind === 'step') {
    if (applied.length !== 2 || !applied.every(v => Number.isFinite(v) && Math.abs(v) <= SPEC.max + 1e-12)) throw new Error('Applied step out of range.');
    return {applied, limited: out.limited};
  }
  if (kind === 'lift') return {applied: {op: 'lift', position: out.position}, limited: out.limited};
  return {applied: {op: 'grip', state: out.state}, limited: out.limited};
}`;
  }

  function fromModbus(spec) {
    const frame = spec.frame || {}, commands = spec.commands || {}, reply = spec.reply || {};
    if (spec.wire?.text !== 'hex') throw new Error('SPEC: modbus synthesizer supports hex wire text only.');
    if (!Number.isInteger(frame.unit) || !/CRC-16\/MODBUS/.test(String(frame.crc || ''))) throw new Error('SPEC: unsupported Modbus frame.');
    const step = commands.step, lift = commands.lift, grip = commands.grip;
    if (!step || !Number.isInteger(step.function) || !Array.isArray(step.values) || step.values.length !== 2) throw new Error('SPEC: modbus spec lacks step layout.');
    for (const c of [lift, grip]) if (!c || !Number.isInteger(c.function) || !Number.isInteger(c.register) || !c.map) throw new Error('SPEC: modbus spec lacks lift/grip register.');
    if (!reply.step || !Array.isArray(reply.step.values) || !reply.exception) throw new Error('SPEC: modbus reply layout missing.');
    const table = {unit: frame.unit, upper: spec.wire.case === 'upper', step, lift, grip, reply: {step: reply.step, lift: reply.lift, grip: reply.grip, exceptionFlag: reply.exception.functionFlag}, max: LIMIT};
    return `// Generated offline from manual.protocolSpec (${spec.name || 'modbus-rtu'}); no driver template used.
const SPEC = ${lit(table)};
function crc16(bytes) { let c = 0xffff; for (const b of bytes) { c ^= b & 255; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; } return c & 0xffff; }
function toHex(bytes) { const text = bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join(''); return SPEC.upper ? text.toUpperCase() : text; }
function rtu(body) { const c = crc16(body); return toHex([...body, c & 255, (c >> 8) & 255]); }
function u16(v) { return [(v >> 8) & 255, v & 255]; }
function s16(value, scale) { const n = Math.round(value * scale); if (!Number.isInteger(n) || n < -32768 || n > 32767) throw new Error('s16 overflow'); return u16(n < 0 ? n + 65536 : n); }
function encode(command) {
  if (Array.isArray(command) && command.length === 2 && command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SPEC.max)) {
    const st = SPEC.step, data = [];
    for (let i = 0; i < 2; i++) data.push(...s16(command[i], st.values[i].scale));
    return rtu([SPEC.unit, st.function, ...u16(st.readStart), ...u16(st.readCount), ...u16(st.writeStart), ...u16(st.writeCount), st.byteCount, ...data]);
  }
  if (command && !Array.isArray(command) && Object.keys(command).sort().join(',') === 'op,position' && command.op === 'lift' && command.position in SPEC.lift.map)
    return rtu([SPEC.unit, SPEC.lift.function, ...u16(SPEC.lift.register), ...u16(SPEC.lift.map[command.position])]);
  if (command && !Array.isArray(command) && Object.keys(command).sort().join(',') === 'op,state' && command.op === 'grip' && command.state in SPEC.grip.map)
    return rtu([SPEC.unit, SPEC.grip.function, ...u16(SPEC.grip.register), ...u16(SPEC.grip.map[command.state])]);
  throw new Error('Unsupported or out-of-range command.');
}
function decode(rawReply) {
  if (typeof rawReply !== 'string' || rawReply === '') throw new Error('Device did not reply.');
  if (rawReply.length % 2 || !/^[0-9a-fA-F]+$/.test(rawReply) || (!SPEC.upper && /[A-F]/.test(rawReply))) throw new Error('Reply is not hex bytes.');
  const b = []; for (let i = 0; i < rawReply.length; i += 2) b.push(parseInt(rawReply.slice(i, i + 2), 16));
  if (b.length < 5) throw new Error('Reply too short.');
  const c = crc16(b.slice(0, -2));
  if (b[b.length - 2] !== (c & 255) || b[b.length - 1] !== ((c >> 8) & 255)) throw new Error('CRC mismatch.');
  if (b[0] !== SPEC.unit) throw new Error('Wrong unit address.');
  if (b[1] & SPEC.reply.exceptionFlag) throw new Error('Device exception ' + b[2]);
  const read = i => (b[i] << 8) | b[i + 1];
  if (b[1] === SPEC.reply.step.function) {
    const values = SPEC.reply.step.values, bytes = values.length * 2;
    if (b[2] !== SPEC.reply.step.byteCount || b.length !== 3 + bytes + 2) throw new Error('Step reply length mismatch.');
    const applied = [], out = {};
    values.forEach((item, k) => {
      const raw = read(3 + k * 2);
      if (item.type === 's16') { const v = (raw >= 32768 ? raw - 65536 : raw) / item.scale; const m = /^applied\\[(\\d+)\\]$/.exec(item.to); if (m) applied[Number(m[1])] = v; }
      else if (item.type === 'u16') out[item.to] = raw;
    });
    if (!(out.flags === 0 || out.flags === 1)) throw new Error('Unknown flags.');
    if (applied.length !== 2 || !applied.every(v => Number.isFinite(v) && Math.abs(v) <= SPEC.max + 1e-12)) throw new Error('Applied step out of range.');
    return {applied, limited: out.flags === 1};
  }
  for (const [kind, key] of [['lift', 'position'], ['grip', 'state']]) {
    const layout = SPEC.reply[kind];
    if (b[1] === layout.function && b.length === 8 && read(2) === layout.register) {
      const value = layout.map[read(4)];
      if (value === undefined) throw new Error('Unknown ' + kind + ' value.');
      return {applied: {op: kind, [key]: value}, limited: false};
    }
  }
  throw new Error('Unexpected reply layout.');
}`;
  }

  function fromSpec(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('SPEC: manual.protocolSpec is missing.');
    if (spec.family === 'json-line') return fromJsonLine(spec);
    if (spec.family === 'binary-frame') return fromBinaryFrame(spec);
    if (spec.family === 'modbus-rtu') return fromModbus(spec);
    throw new Error('SPEC: unsupported framing family ' + String(spec.family).slice(0, 40));
  }
  global.VlabDriverSynthesizer = {fromSpec, families: ['json-line', 'binary-frame', 'modbus-rtu']};
})(globalThis);
