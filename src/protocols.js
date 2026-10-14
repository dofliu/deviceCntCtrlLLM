(function (global) {
  'use strict';
  // Trusted host-side protocol profiles. They describe how the HOST verifies an
  // encoded frame and an acknowledgement independently of generated drivers,
  // and how the simulated devices answer. Generated driver code never receives
  // these functions; it only sees the manual (with or without a template).
  const MAX_STEP = 0.1;
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { const error = new Error(code + ': ' + message); error.protocolCode = code; return error; };
  const validXY = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_STEP + 1e-12);
  const validAuxiliary = value => value && !Array.isArray(value) && typeof value === 'object' &&
    ((value.op === 'lift' && ['up','down'].includes(value.position) && Object.keys(value).sort().join(',') === 'op,position') ||
     (value.op === 'grip' && ['open','closed'].includes(value.state) && Object.keys(value).sort().join(',') === 'op,state'));

  // ---------------------------------------------------------------- JSON line
  const P2 = 'vlab-p2-json/1';
  function parseJsonLine(wire, limit) {
    if (typeof wire !== 'string' || wire.length > limit || !wire.endsWith('\n') || /[\r\n]/.test(wire.slice(0, -1)))
      throw fail('FRAME', 'expected one JSON line, ending in LF.');
    let value;
    try { value = JSON.parse(wire); } catch { throw fail('FRAME', 'invalid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('FRAME', 'expected JSON object.');
    return value;
  }
  const jsonProfile = {
    name: P2, family: 'json-line', resolution: 0, maxWire: 1024,
    // Host verification of a generated encode() result.
    commandFromWire(wire) {
      const packet = parseJsonLine(wire, 1024);
      if (packet.op === 'step') {
        if (Object.keys(packet).sort().join(',') !== 'channels,op' || !validXY(packet.channels)) throw fail('COMMAND', 'step packet must contain exactly two bounded channels.');
        return packet.channels.slice();
      }
      if (validAuxiliary(packet)) return copy(packet);
      throw fail('COMMAND', 'unknown or malformed command packet.');
    },
    // Independent acknowledgement parsing. Returns {ok, accepted, limited, error}.
    parseReply(wire) {
      if (typeof wire !== 'string' || wire.length > 2048) throw fail('ACK_FRAME', 'invalid acknowledgement frame.');
      let raw;
      try { raw = JSON.parse(wire); } catch { throw fail('ACK_FRAME', 'acknowledgement is not JSON.'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('ACK_FRAME', 'acknowledgement is not an object.');
      return raw;
    },
    hello: '{"op":"hello"}\n',
    fixtures: {
      limited: {command: [0.02, 0], reply: '{"ok":true,"accepted":[0.01,0],"limited":true}\n'},
      malformedReplies: ['not-json\n', '{"ok":false,"error":"REJECTED"}\n', '{"ok":true,"accepted":["bad",0],"limited":false}\n', '{"ok":true,"accepted":{"op":"lift","position":"sideways"},"limited":false}\n'],
      invalidFrames: ['{"op":"step","channels":[0.2,0]}\n', '{"op":"step","channels":[0,0]}', '{"op":"step","channels":[0,0]}\n{"op":"step","channels":[0,0]}\n', '{"op":"lift","position":"sideways"}\n', '{"op":"grip","state":"open","extra":1}\n']
    },
    spec: {
      family: 'json-line', name: P2,
      wire: {text: 'UTF-8 JSON object', terminator: '\n', maxCharacters: 1024, oneObjectPerFrame: true},
      commands: {
        hello: {fields: {op: 'hello'}},
        step: {fields: {op: 'step', channels: '$xy'}, xy: {count: 2, min: -MAX_STEP, max: MAX_STEP}},
        lift: {fields: {op: 'lift', position: '$position'}, values: ['up', 'down']},
        grip: {fields: {op: 'grip', state: '$state'}, values: ['open', 'closed']}
      },
      reply: {okField: 'ok', appliedField: 'accepted', limitedField: 'limited', errorField: 'error',
        applied: {step: 'array of two numbers', lift: '{op:"lift",position}', grip: '{op:"grip",state}'}}
    }
  };

  // ---------------------------------------------------------- binary frames
  const G3 = 'vlab-g3-bin/1';
  const SYNC = 0xa5, OP = {hello: 0x01, step: 0x10, lift: 0x20, grip: 0x21}, SCALE = 10000;
  const ERROR = {1: 'FRAME', 2: 'CHECKSUM', 3: 'NOT_READY', 4: 'LIMIT', 5: 'OPCODE', 6: 'ARGUMENT', 7: 'COLLISION'};
  const LIFT = {down: 0, up: 1}, GRIP = {open: 0, closed: 1};
  const hexToBytes = (hex, code) => {
    if (typeof hex !== 'string' || hex.length < 2 || hex.length > 512 || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) throw fail(code, 'expected lowercase hex bytes without separators.');
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  };
  const bytesToHex = bytes => bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join('');
  const checksum = bytes => bytes.reduce((x, b) => x ^ b, 0) & 255;
  function frame(payload) { const body = [payload.length, ...payload]; return bytesToHex([SYNC, ...body, checksum(body)]); }
  function unframe(hex, code) {
    const bytes = hexToBytes(hex, code);
    if (bytes[0] !== SYNC) throw fail(code, 'missing 0xa5 sync byte.');
    if (bytes.length < 4 || bytes[1] !== bytes.length - 3) throw fail(code, 'length byte does not match the frame.');
    const body = bytes.slice(1, -1);
    if (checksum(body) !== bytes.at(-1)) throw fail(code, 'checksum mismatch.');
    return bytes.slice(2, -1);
  }
  const int16 = value => { const v = value < 0 ? value + 65536 : value; return [(v >> 8) & 255, v & 255]; };
  const readInt16 = (bytes, i) => { const v = (bytes[i] << 8) | bytes[i + 1]; return v >= 32768 ? v - 65536 : v; };
  const quantum = value => Math.round(value * SCALE);
  function binaryRequestCommand(payload, code) {
    const op = payload[0];
    if (op === OP.hello && payload.length === 1) return {op: 'hello'};
    if (op === OP.step && payload.length === 5) return {op: 'step', channels: [readInt16(payload, 1) / SCALE, readInt16(payload, 3) / SCALE], raw: [readInt16(payload, 1), readInt16(payload, 3)]};
    if (op === OP.lift && payload.length === 2) { const position = Object.keys(LIFT).find(k => LIFT[k] === payload[1]); if (!position) throw fail(code, 'lift argument must be 0 (down) or 1 (up).'); return {op: 'lift', position}; }
    if (op === OP.grip && payload.length === 2) { const state = Object.keys(GRIP).find(k => GRIP[k] === payload[1]); if (!state) throw fail(code, 'grip argument must be 0 (open) or 1 (closed).'); return {op: 'grip', state}; }
    throw fail(code, 'unknown opcode or wrong payload length.');
  }
  const binaryProfile = {
    name: G3, family: 'binary-frame', resolution: 1 / SCALE, maxWire: 512,
    commandFromWire(wire) {
      const request = binaryRequestCommand(unframe(wire, 'FRAME'), 'COMMAND');
      if (request.op === 'step') {
        if (request.raw.some(v => Math.abs(v) > MAX_STEP * SCALE)) throw fail('COMMAND', 'step exceeds the 0.1 input limit.');
        return request.channels;
      }
      if (request.op === 'hello') throw fail('COMMAND', 'hello is not an actuation command.');
      return request;
    },
    parseReply(wire) {
      const payload = unframe(wire, 'ACK_FRAME');
      if (payload.length < 2) throw fail('ACK_FRAME', 'reply payload too short.');
      if (payload[0] !== 0) return {ok: false, error: (ERROR[payload[0]] || 'DEVICE_ERROR_' + payload[0]) + ' (opcode 0x' + payload[1].toString(16).padStart(2, '0') + ')'};
      const op = payload[1];
      if (op === OP.hello && payload.length >= 7) {
        return {ok: true, protocolVersion: payload[2], channels: payload[3], maxStep: readInt16(payload, 4) / SCALE,
          model: String.fromCharCode(...payload.slice(6)), protocol: G3};
      }
      if (op === OP.step && payload.length === 7 && payload[6] <= 1)
        return {ok: true, accepted: [readInt16(payload, 2) / SCALE, readInt16(payload, 4) / SCALE], limited: payload[6] === 1};
      if (op === OP.lift && payload.length === 4 && payload[3] <= 1) { const position = Object.keys(LIFT).find(k => LIFT[k] === payload[2]); if (position) return {ok: true, accepted: {op: 'lift', position}, limited: payload[3] === 1}; }
      if (op === OP.grip && payload.length === 4 && payload[3] <= 1) { const state = Object.keys(GRIP).find(k => GRIP[k] === payload[2]); if (state) return {ok: true, accepted: {op: 'grip', state}, limited: payload[3] === 1}; }
      throw fail('ACK_FRAME', 'reply layout does not match the echoed opcode.');
    },
    // Simulated-device helpers.
    deviceRequest(wire) {
      let payload;
      try { payload = unframe(wire, 'FRAME'); } catch (error) { return {error: /checksum/.test(error.message) ? 2 : 1, op: 0}; }
      try {
        const request = binaryRequestCommand(payload, 'ARGUMENT');
        if (request.op === 'step' && request.raw.some(v => Math.abs(v) > MAX_STEP * SCALE)) return {error: 4, op: payload[0]};
        return {request};
      } catch { return {error: [OP.hello, OP.step, OP.lift, OP.grip].includes(payload[0]) ? 6 : 5, op: payload[0] || 0}; }
    },
    replyHello(model, maxStep) { return frame([0, OP.hello, 1, 2, ...int16(quantum(maxStep)), ...Array.from(model, c => c.charCodeAt(0) & 127)]); },
    replyStep(applied, limited) { return frame([0, OP.step, ...int16(quantum(applied[0])), ...int16(quantum(applied[1])), limited ? 1 : 0]); },
    replyAuxiliary(command, limited) {
      return command.op === 'lift' ? frame([0, OP.lift, LIFT[command.position], limited ? 1 : 0]) : frame([0, OP.grip, GRIP[command.state], limited ? 1 : 0]);
    },
    replyError(code, op) { return frame([code, op & 255]); },
    encodeCommand(command) {
      if (Array.isArray(command)) return frame([OP.step, ...int16(quantum(command[0])), ...int16(quantum(command[1]))]);
      if (command.op === 'hello') return frame([OP.hello]);
      return command.op === 'lift' ? frame([OP.lift, LIFT[command.position]]) : frame([OP.grip, GRIP[command.state]]);
    },
    hello: frame([OP.hello]),
    fixtures: null,
    spec: {
      family: 'binary-frame', name: G3,
      wire: {text: 'hex', case: 'lower', separator: '', terminator: '', note: '每個位元組以兩個小寫十六進位字元表示（序列埠監看格式），不加空白或換行。'},
      frame: {sync: [SYNC], lengthBytes: 1, lengthCovers: 'payload', checksum: 'xor', checksumCovers: 'length byte and every payload byte', layout: 'sync | length | payload... | checksum'},
      integer: {int16be: "big-endian two's complement"},
      commands: {
        hello: {opcode: OP.hello, args: []},
        step: {opcode: OP.step, args: [{type: 'int16be', scale: SCALE, from: 'channels[0]'}, {type: 'int16be', scale: SCALE, from: 'channels[1]'}], range: [-MAX_STEP, MAX_STEP], note: '值 = round(輸入 × 10000)；主機會先把輸入量化到 0.0001。'},
        lift: {opcode: OP.lift, args: [{type: 'uint8', from: 'position', map: {...LIFT}}]},
        grip: {opcode: OP.grip, args: [{type: 'uint8', from: 'state', map: {...GRIP}}]}
      },
      reply: {statusOffset: 0, okStatus: 0, opcodeOffset: 1, errors: {...ERROR},
        layouts: {
          step: [{type: 'int16be', scale: SCALE, to: 'applied[0]'}, {type: 'int16be', scale: SCALE, to: 'applied[1]'}, {type: 'flag', to: 'limited'}],
          lift: [{type: 'uint8', to: 'position', map: {0: 'down', 1: 'up'}}, {type: 'flag', to: 'limited'}],
          grip: [{type: 'uint8', to: 'state', map: {0: 'open', 1: 'closed'}}, {type: 'flag', to: 'limited'}],
          hello: [{type: 'uint8', to: 'protocolVersion'}, {type: 'uint8', to: 'channels'}, {type: 'int16be', scale: SCALE, to: 'maxStep'}, {type: 'ascii', to: 'model'}]
        }}
    }
  };
  binaryProfile.fixtures = {
    limited: {command: [0.02, 0], reply: binaryProfile.replyStep([0.01, 0], true)},
    malformedReplies: [
      'zz00',
      binaryProfile.replyError(4, OP.step),
      binaryProfile.replyStep([0.01, 0], false).slice(0, -2) + '00',
      frame([0, OP.lift, 7, 0]),
      frame([0, OP.step, 0, 0]),
      frame([0, 0x7f, 0, 0])
    ],
    invalidFrames: [
      frame([OP.step, ...int16(2000), 0, 0]),
      frame([OP.step, 0, 0, 0, 0]).slice(0, -2) + 'ff',
      frame([OP.step, 0, 0]),
      frame([OP.lift, 9]),
      frame([0x7e]),
      frame([OP.grip, 0]) + frame([OP.grip, 0])
    ]
  };

  // ------------------------------------------------- Modbus-RTU style (VLAB-X)
  // Register protocol with CRC-16/MODBUS. Held-out device: not in the default
  // manual library; experiments enable it explicitly.
  const X = 'vlab-x-modbus/1';
  const UNIT = 0x11, FN = {read: 0x03, write: 0x06, readWrite: 0x17};
  const REG = {identity: 0x0000, identityCount: 6, enable: 0x0100, home: 0x0101, status: 0x0102, lift: 0x0200, grip: 0x0201, step: 0x0300, result: 0x0310};
  const EXCEPTION = {1: 'ILLEGAL_FUNCTION', 2: 'ILLEGAL_DATA_ADDRESS', 3: 'ILLEGAL_DATA_VALUE', 4: 'DEVICE_FAILURE', 6: 'DEVICE_BUSY_NOT_READY'};
  const MODEL_X = 'VLAB-X';
  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) { crc ^= b & 255; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
    return crc & 0xffff;
  }
  const u16 = v => [(v >> 8) & 255, v & 255];
  const readU16 = (b, i) => (b[i] << 8) | b[i + 1];
  function rtu(body) { const c = crc16(body); return bytesToHex([...body, c & 255, (c >> 8) & 255]); }
  // Returns the PDU bytes (unit address and CRC removed) or throws.
  function unrtu(hex, code) {
    const bytes = hexToBytes(hex, code);
    if (bytes.length < 4) throw fail(code, 'frame shorter than address, function and CRC.');
    const c = crc16(bytes.slice(0, -2));
    if (bytes.at(-2) !== (c & 255) || bytes.at(-1) !== ((c >> 8) & 255)) throw fail(code, 'CRC-16 mismatch.');
    if (bytes[0] !== UNIT) throw fail(code, 'unit address must be 0x11.');
    return bytes.slice(1, -2);
  }
  const s16 = v => { const n = Math.round(v * SCALE); return n < 0 ? n + 65536 : n; };
  const fromS16 = v => (v >= 32768 ? v - 65536 : v);
  // Parse a request PDU into {kind, ...}. kind: step | lift | grip | enable | home | read.
  function modbusRequest(pdu, code) {
    const fn = pdu[0];
    if (fn === FN.readWrite) {
      if (pdu.length !== 14 || readU16(pdu, 1) !== REG.result || readU16(pdu, 3) !== 3 || readU16(pdu, 5) !== REG.step || readU16(pdu, 7) !== 2 || pdu[9] !== 4) throw fail(code, 'step must be function 0x17 reading 0x0310 x3 and writing 0x0300 x2 (4 bytes).');
      const raw = [fromS16(readU16(pdu, 10)), fromS16(readU16(pdu, 12))];
      return {kind: 'step', raw, channels: raw.map(v => v / SCALE)};
    }
    if (fn === FN.write) {
      if (pdu.length !== 5) throw fail(code, 'write single register needs address and value.');
      const reg = readU16(pdu, 1), value = readU16(pdu, 3);
      if (reg === REG.lift) { if (value > 1) throw fail(code, 'lift value must be 0 or 1.'); return {kind: 'lift', reg, value, op: 'lift', position: value ? 'up' : 'down'}; }
      if (reg === REG.grip) { if (value > 1) throw fail(code, 'grip value must be 0 or 1.'); return {kind: 'grip', reg, value, op: 'grip', state: value ? 'closed' : 'open'}; }
      if (reg === REG.enable || reg === REG.home) { if (value !== 1) throw fail(code, 'enable/home value must be 1.'); return {kind: reg === REG.enable ? 'enable' : 'home', reg, value}; }
      const error = fail(code, 'unknown register.'); error.exception = 2; throw error;
    }
    if (fn === FN.read) {
      if (pdu.length !== 5) throw fail(code, 'read holding registers needs start and count.');
      const start = readU16(pdu, 1), count = readU16(pdu, 3);
      if (!((start === REG.identity && count === REG.identityCount) || (start === REG.status && count === 1))) { const error = fail(code, 'unsupported register range.'); error.exception = 2; throw error; }
      return {kind: 'read', start, count};
    }
    const error = fail(code, 'unsupported function code.'); error.exception = 1; throw error;
  }
  const modbusProfile = {
    name: X, family: 'modbus-rtu', resolution: 1 / SCALE, maxWire: 128,
    commandFromWire(wire) {
      const request = modbusRequest(unrtu(wire, 'FRAME'), 'COMMAND');
      if (request.kind === 'step') {
        if (request.raw.some(v => Math.abs(v) > MAX_STEP * SCALE)) throw fail('COMMAND', 'step exceeds the 0.1 input limit.');
        return request.channels;
      }
      if (request.kind === 'lift') return {op: 'lift', position: request.position};
      if (request.kind === 'grip') return {op: 'grip', state: request.state};
      throw fail('COMMAND', 'not an actuation command.');
    },
    parseReply(wire) {
      // A Modbus slave stays silent on a bad CRC or another unit address.
      if (wire === '') return {ok: false, error: 'NO_RESPONSE (bad CRC or unit address; device stays silent)'};
      const pdu = unrtu(wire, 'ACK_FRAME'), fn = pdu[0];
      if (fn & 0x80) { if (pdu.length !== 2) throw fail('ACK_FRAME', 'exception reply must carry one code.'); return {ok: false, error: (EXCEPTION[pdu[1]] || 'EXCEPTION_' + pdu[1]) + ' (function 0x' + (fn & 0x7f).toString(16).padStart(2, '0') + ')'}; }
      if (fn === FN.readWrite && pdu.length === 8 && pdu[1] === 6) {
        const flags = readU16(pdu, 6);
        if (flags > 1) throw fail('ACK_FRAME', 'unknown result flags.');
        return {ok: true, accepted: [fromS16(readU16(pdu, 2)) / SCALE, fromS16(readU16(pdu, 4)) / SCALE], limited: flags === 1};
      }
      if (fn === FN.write && pdu.length === 5) {
        const reg = readU16(pdu, 1), value = readU16(pdu, 3);
        if (reg === REG.lift && value <= 1) return {ok: true, accepted: {op: 'lift', position: value ? 'up' : 'down'}, limited: false};
        if (reg === REG.grip && value <= 1) return {ok: true, accepted: {op: 'grip', state: value ? 'closed' : 'open'}, limited: false};
        if ((reg === REG.enable || reg === REG.home) && value === 1) return {ok: true, written: {register: reg, value}};
        throw fail('ACK_FRAME', 'write echo for an unknown register or value.');
      }
      if (fn === FN.read && pdu.length === 2 + REG.identityCount * 2 && pdu[1] === REG.identityCount * 2) {
        const regs = Array.from({length: REG.identityCount}, (_, i) => readU16(pdu, 2 + i * 2));
        const model = regs.slice(3).flatMap(v => [v >> 8, v & 255]).filter(Boolean).map(c => String.fromCharCode(c & 127)).join('');
        return {ok: true, protocolVersion: regs[0], channels: regs[1], maxStep: regs[2] / SCALE, model, protocol: X};
      }
      if (fn === FN.read && pdu.length === 4 && pdu[1] === 2) return {ok: true, status: readU16(pdu, 2), enabled: Boolean(readU16(pdu, 2) & 1), homed: Boolean(readU16(pdu, 2) & 2)};
      throw fail('ACK_FRAME', 'reply layout does not match the function code.');
    },
    // Simulated-device side: {request} | {exception, fn} | {silent: true}.
    deviceRequest(wire) {
      let pdu;
      try { pdu = unrtu(wire, 'FRAME'); } catch { return {silent: true}; }
      try {
        const request = modbusRequest(pdu, 'ARGUMENT');
        if (request.kind === 'step' && request.raw.some(v => Math.abs(v) > MAX_STEP * SCALE)) return {exception: 3, fn: pdu[0]};
        return {request};
      } catch (error) { return {exception: error.exception || 3, fn: pdu[0] || 0}; }
    },
    replyIdentity(model, maxStep) {
      const name = Array.from(model.padEnd(6, '\0').slice(0, 6), c => c.charCodeAt(0) & 127);
      const regs = [1, 2, Math.round(maxStep * SCALE), (name[0] << 8) | name[1], (name[2] << 8) | name[3], (name[4] << 8) | name[5]];
      return rtu([UNIT, FN.read, regs.length * 2, ...regs.flatMap(u16)]);
    },
    replyStatus(status) { return rtu([UNIT, FN.read, 2, ...u16(status)]); },
    replyStep(applied, limited) { return rtu([UNIT, FN.readWrite, 6, ...u16(s16(applied[0])), ...u16(s16(applied[1])), ...u16(limited ? 1 : 0)]); },
    replyWrite(reg, value) { return rtu([UNIT, FN.write, ...u16(reg), ...u16(value)]); },
    replyAuxiliary(command) { return command.op === 'lift' ? this.replyWrite(REG.lift, command.position === 'up' ? 1 : 0) : this.replyWrite(REG.grip, command.state === 'closed' ? 1 : 0); },
    replyException(fn, code) { return rtu([UNIT, (fn | 0x80) & 255, code]); },
    encodeCommand(command) {
      if (Array.isArray(command)) return rtu([UNIT, FN.readWrite, ...u16(REG.result), ...u16(3), ...u16(REG.step), ...u16(2), 4, ...u16(s16(command[0])), ...u16(s16(command[1]))]);
      if (command.op === 'lift') return rtu([UNIT, FN.write, ...u16(REG.lift), ...u16(command.position === 'up' ? 1 : 0)]);
      return rtu([UNIT, FN.write, ...u16(REG.grip), ...u16(command.state === 'closed' ? 1 : 0)]);
    },
    // The host runs this documented start-up sequence during handshake:
    // read identity, enable drives, home, then confirm status bits 0 and 1.
    hello: rtu([UNIT, FN.read, ...u16(REG.identity), ...u16(REG.identityCount)]),
    startup: [
      {name: 'enable', wire: rtu([UNIT, FN.write, ...u16(REG.enable), ...u16(1)])},
      {name: 'home', wire: rtu([UNIT, FN.write, ...u16(REG.home), ...u16(1)])},
      {name: 'status', wire: rtu([UNIT, FN.read, ...u16(REG.status), ...u16(1)]), expectStatus: 3}
    ],
    registers: {...REG}, unit: UNIT, crc16,
    fixtures: null,
    spec: {
      family: 'modbus-rtu', name: X,
      wire: {text: 'hex', case: 'lower', separator: '', terminator: '', note: '每個位元組以兩個小寫十六進位字元表示，不加空白或換行。'},
      frame: {unit: UNIT, layout: 'unit | function | data... | crcLo | crcHi', crc: 'CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF), low byte first', crcCovers: 'unit, function and data bytes'},
      integer: {u16: 'big-endian unsigned', s16: "big-endian two's complement"},
      registers: {identity: {start: REG.identity, count: REG.identityCount, layout: ['protocolVersion', 'channels', 'maxStep x10000', 'model ascii (2 chars per register)']},
        enable: REG.enable, home: REG.home, status: {address: REG.status, bits: {0: 'enabled', 1: 'homed'}}, lift: REG.lift, grip: REG.grip, step: REG.step, result: REG.result},
      commands: {
        step: {function: FN.readWrite, readStart: REG.result, readCount: 3, writeStart: REG.step, writeCount: 2, byteCount: 4,
          values: [{type: 's16', scale: SCALE, from: 'channels[0]'}, {type: 's16', scale: SCALE, from: 'channels[1]'}], range: [-MAX_STEP, MAX_STEP], note: '值 = round(輸入 × 10000)；主機會先把輸入量化到 0.0001。'},
        lift: {function: FN.write, register: REG.lift, map: {down: 0, up: 1}},
        grip: {function: FN.write, register: REG.grip, map: {open: 0, closed: 1}}
      },
      reply: {
        step: {function: FN.readWrite, byteCount: 6, values: [{type: 's16', scale: SCALE, to: 'applied[0]'}, {type: 's16', scale: SCALE, to: 'applied[1]'}, {type: 'u16', to: 'flags', bits: {0: 'limited'}}]},
        lift: {function: FN.write, echo: true, register: REG.lift, map: {0: 'down', 1: 'up'}, limited: false},
        grip: {function: FN.write, echo: true, register: REG.grip, map: {0: 'open', 1: 'closed'}, limited: false},
        exception: {functionFlag: 0x80, codes: {...EXCEPTION}},
        silence: '位址不符或 CRC 錯誤時設備不回覆（空字串）。'
      },
      startup: 'handshake 時主機依序讀取識別暫存器 0x0000×6、寫 0x0100=1（啟用驅動）、寫 0x0101=1（歸零），再讀 0x0102 確認 bit0 與 bit1 皆為 1；完成前任何動作命令回覆例外碼 6。'
    }
  };
  modbusProfile.fixtures = {
    limited: {command: [0.02, 0], reply: modbusProfile.replyStep([0.01, 0], true)},
    malformedReplies: [
      '',
      modbusProfile.replyException(FN.readWrite, 3),
      modbusProfile.replyException(FN.readWrite, 6),
      modbusProfile.replyStep([0.01, 0], false).slice(0, -2) + '00',
      rtu([0x12, FN.readWrite, 6, 0, 0, 0, 0, 0, 0]),
      rtu([UNIT, FN.readWrite, 4, 0, 0, 0, 0]),
      rtu([UNIT, FN.write, ...u16(REG.lift), ...u16(7)]),
      'zz00'
    ],
    invalidFrames: [
      modbusProfile.encodeCommand([0, 0]).slice(0, -4) + modbusProfile.encodeCommand([0, 0]).slice(-4).split('').reverse().join(''),
      rtu([UNIT, FN.readWrite, ...u16(REG.result), ...u16(3), ...u16(REG.step), ...u16(2), 4, ...u16(2000), 0, 0]),
      rtu([0x12, FN.write, ...u16(REG.lift), ...u16(1)]),
      rtu([UNIT, FN.write, ...u16(REG.lift), ...u16(9)]),
      rtu([UNIT, FN.write, ...u16(0x0777), ...u16(1)]),
      rtu([UNIT, 0x2b, 0, 0])
    ]
  };

  const PROFILES = {[P2]: jsonProfile, [G3]: binaryProfile, [X]: modbusProfile};
  global.VlabProtocols = {
    MAX_STEP,
    get(name) { const profile = PROFILES[name]; if (!profile) throw new Error('PROTOCOL: unknown protocol ' + String(name).slice(0, 60)); return profile; },
    names() { return Object.keys(PROFILES); },
    spec(name) { return copy(this.get(name).spec); },
    // Quantize a host XY command to the device resolution before encoding.
    quantize(command, profile) {
      if (!Array.isArray(command) || !profile.resolution) return command;
      return command.map(v => { const q = Math.round(v / profile.resolution) * profile.resolution; return Math.abs(q) < 1e-12 ? 0 : Number(q.toFixed(10)); });
    },
    validXY, validAuxiliary
  };
})(globalThis);
