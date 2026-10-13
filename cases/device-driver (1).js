function xorSum(bytes) {
  var c = 0;
  for (var i = 0; i < bytes.length; i++) c ^= bytes[i];
  return c & 0xff;
}

function hex2(b) {
  var s = (b & 0xff).toString(16);
  return s.length < 2 ? '0' + s : s;
}

function frame(payload) {
  var body = [payload.length].concat(payload);
  var c = xorSum(body);
  var out = [0xA5].concat(body, [c]);
  var s = '';
  for (var i = 0; i < out.length; i++) s += hex2(out[i]);
  return s;
}

function i16(v) {
  var n = Math.round(v * 10000);
  if (n < 0) n += 65536;
  return [(n >> 8) & 0xff, n & 0xff];
}

function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v >= 32768) v -= 65536;
  return v;
}

function encode(command) {
  if (Array.isArray(command)) {
    if (command.length !== 2) throw new Error('step needs 2 channels');
    var a = command[0], b = command[1];
    if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) throw new Error('non-finite');
    if (Math.abs(a) > 0.1 + 1e-9 || Math.abs(b) > 0.1 + 1e-9) throw new Error('out of range');
    var pa = i16(a), pb = i16(b);
    return frame([0x10, pa[0], pa[1], pb[0], pb[1]]);
  }
  if (command && command.op === 'lift') {
    var lv;
    if (command.position === 'up') lv = 1;
    else if (command.position === 'down') lv = 0;
    else throw new Error('bad lift position');
    return frame([0x20, lv]);
  }
  if (command && command.op === 'grip') {
    var gv;
    if (command.state === 'closed') gv = 1;
    else if (command.state === 'open') gv = 0;
    else throw new Error('bad grip state');
    return frame([0x21, gv]);
  }
  throw new Error('unsupported command');
}

function decode(rawReply) {
  if (typeof rawReply !== 'string' || rawReply.length % 2 !== 0 || !/^[0-9a-f]*$/.test(rawReply)) throw new Error('FRAME: bad hex');
  var bytes = [];
  for (var i = 0; i < rawReply.length; i += 2) bytes.push(parseInt(rawReply.substr(i, 2), 16));
  if (bytes.length < 4) throw new Error('FRAME: too short');
  if (bytes[0] !== 0xA5) throw new Error('FRAME: bad sync');
  var len = bytes[1];
  if (bytes.length !== len + 3) throw new Error('FRAME: bad length');
  var body = bytes.slice(1, 2 + len);
  if (xorSum(body) !== bytes[bytes.length - 1]) throw new Error('CHECKSUM');
  var payload = bytes.slice(2, 2 + len);
  var status = payload[0];
  if (status !== 0) throw new Error('device error status ' + status);
  var op = payload[1];
  if (op === 0x10) {
    if (len !== 7) throw new Error('FRAME: bad step length');
    var a = s16(payload[2], payload[3]) / 10000;
    var b = s16(payload[4], payload[5]) / 10000;
    return { applied: [a, b], limited: (payload[6] & 1) === 1 };
  }
  if (op === 0x20) {
    if (len !== 4) throw new Error('FRAME: bad lift length');
    var pos;
    if (payload[2] === 1) pos = 'up';
    else if (payload[2] === 0) pos = 'down';
    else throw new Error('bad lift state');
    return { applied: { op: 'lift', position: pos }, limited: (payload[3] & 1) === 1 };
  }
  if (op === 0x21) {
    if (len !== 4) throw new Error('FRAME: bad grip length');
    var st;
    if (payload[2] === 1) st = 'closed';
    else if (payload[2] === 0) st = 'open';
    else throw new Error('bad grip state');
    return { applied: { op: 'grip', state: st }, limited: (payload[3] & 1) === 1 };
  }
  throw new Error('OPCODE: unexpected reply opcode ' + op);
}
