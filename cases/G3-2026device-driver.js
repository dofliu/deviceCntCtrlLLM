var ERR = {1:"FRAME",2:"CHECKSUM",3:"NOT_READY",4:"LIMIT",5:"OPCODE",6:"ARGUMENT",7:"COLLISION"};

function toHex(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length < 2) h = "0" + h;
    s += h;
  }
  return s;
}

function fromHex(s) {
  if (typeof s !== "string") throw new Error("FRAME");
  var t = s.trim().toLowerCase();
  if (t.length === 0 || t.length % 2 !== 0 || !/^[0-9a-f]+$/.test(t)) throw new Error("FRAME");
  var out = [];
  for (var i = 0; i < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
  return out;
}

function frame(payload) {
  var len = payload.length;
  var x = len;
  for (var i = 0; i < len; i++) x ^= payload[i];
  var bytes = [0xA5, len].concat(payload, [x & 0xff]);
  return toHex(bytes);
}

function encode(command) {
  var payload;
  if (Array.isArray(command)) {
    if (command.length !== 2) throw new Error("ARGUMENT");
    var vals = [];
    for (var k = 0; k < 2; k++) {
      var v = command[k];
      if (typeof v !== "number" || !isFinite(v) || Math.abs(v) > 0.1 + 1e-9) throw new Error("ARGUMENT");
      var q = Math.round(v * 10000);
      if (q < -32768 || q > 32767) throw new Error("ARGUMENT");
      vals.push(q);
    }
    var a = vals[0], b = vals[1];
    payload = [0x10, (a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff];
  } else if (command && typeof command === "object" && command.op === "lift") {
    if (command.position !== "up" && command.position !== "down") throw new Error("ARGUMENT");
    payload = [0x20, command.position === "up" ? 1 : 0];
  } else if (command && typeof command === "object" && command.op === "grip") {
    if (command.state !== "open" && command.state !== "closed") throw new Error("ARGUMENT");
    payload = [0x21, command.state === "closed" ? 1 : 0];
  } else {
    throw new Error("ARGUMENT");
  }
  return frame(payload);
}

function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) v = v - 0x10000;
  return v;
}

function decode(rawReply) {
  var b = fromHex(rawReply);
  if (b.length < 4) throw new Error("FRAME");
  if (b[0] !== 0xA5) throw new Error("FRAME");
  var len = b[1];
  if (b.length !== len + 3) throw new Error("FRAME");
  var x = len;
  for (var i = 2; i < 2 + len; i++) x ^= b[i];
  if ((x & 0xff) !== b[b.length - 1]) throw new Error("CHECKSUM");
  var p = b.slice(2, 2 + len);
  if (p.length < 2) throw new Error("FRAME");
  var status = p[0];
  if (status !== 0) {
    throw new Error("DEVICE_ERROR:" + (ERR[status] || String(status)));
  }
  var op = p[1];
  if (op === 0x10) {
    if (p.length !== 7) throw new Error("FRAME");
    return {
      applied: [s16(p[2], p[3]) / 10000, s16(p[4], p[5]) / 10000],
      limited: (p[6] & 1) === 1
    };
  }
  if (op === 0x20) {
    if (p.length !== 4) throw new Error("FRAME");
    if (p[2] !== 0 && p[2] !== 1) throw new Error("FRAME");
    return {
      applied: {op: "lift", position: p[2] === 1 ? "up" : "down"},
      limited: (p[3] & 1) === 1
    };
  }
  if (op === 0x21) {
    if (p.length !== 4) throw new Error("FRAME");
    if (p[2] !== 0 && p[2] !== 1) throw new Error("FRAME");
    return {
      applied: {op: "grip", state: p[2] === 1 ? "closed" : "open"},
      limited: (p[3] & 1) === 1
    };
  }
  throw new Error("OPCODE");
}
