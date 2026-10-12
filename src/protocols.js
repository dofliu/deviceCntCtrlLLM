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

  const PROFILES = {[P2]: jsonProfile, [G3]: binaryProfile};
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
