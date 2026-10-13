function encode(command) {
  var frame;
  if (Array.isArray(command)) {
    if (command.length !== 2) throw new Error("step requires two channels");
    var a = Number(command[0]);
    var b = Number(command[1]);
    if (!isFinite(a) || !isFinite(b)) throw new Error("non-finite channel");
    if (Math.abs(a) > 0.1 || Math.abs(b) > 0.1) throw new Error("channel out of range");
    frame = { op: "step", channels: [a, b] };
  } else if (command && typeof command === "object" && command.op === "lift") {
    if (command.position !== "up" && command.position !== "down") throw new Error("invalid lift position");
    frame = { op: "lift", position: command.position };
  } else if (command && typeof command === "object" && command.op === "grip") {
    if (command.state !== "open" && command.state !== "closed") throw new Error("invalid grip state");
    frame = { op: "grip", state: command.state };
  } else {
    throw new Error("unsupported command");
  }
  return JSON.stringify(frame) + "\n";
}

function decode(rawReply) {
  if (typeof rawReply !== "string") throw new Error("reply must be a string");
  if (rawReply.length === 0 || rawReply.length > 1024) throw new Error("reply length invalid");
  if (rawReply.charAt(rawReply.length - 1) !== "\n") throw new Error("reply missing LF terminator");
  var body = rawReply.slice(0, -1);
  if (body.indexOf("\n") !== -1 || body.indexOf("\r") !== -1) throw new Error("reply must be exactly one line");
  var reply;
  try {
    reply = JSON.parse(body);
  } catch (e) {
    throw new Error("malformed JSON reply");
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("reply must be an object");
  if (reply.ok === false) {
    throw new Error(reply.error ? String(reply.error) : "device returned ok:false");
  }
  if (reply.ok !== true) throw new Error("reply ok field must be true");
  if (reply.error !== undefined) throw new Error("ok reply must not carry error");
  if (typeof reply.limited !== "boolean") throw new Error("limited field must be boolean");
  if (!Object.prototype.hasOwnProperty.call(reply, "accepted")) throw new Error("accepted field missing");
  var acc = reply.accepted;
  if (Array.isArray(acc)) {
    if (acc.length !== 2) throw new Error("step reply must have two channels");
    for (var i = 0; i < 2; i++) {
      if (typeof acc[i] !== "number" || !isFinite(acc[i])) throw new Error("non-finite accepted channel");
      if (Math.abs(acc[i]) > 0.1 + 1e-12) throw new Error("accepted channel out of range");
    }
    return { applied: [acc[0], acc[1]], limited: reply.limited };
  }
  if (acc && typeof acc === "object") {
    if (acc.op === "lift" && (acc.position === "up" || acc.position === "down")) {
      return { applied: { op: "lift", position: acc.position }, limited: reply.limited };
    }
    if (acc.op === "grip" && (acc.state === "open" || acc.state === "closed")) {
      return { applied: { op: "grip", state: acc.state }, limited: reply.limited };
    }
  }
  throw new Error("accepted payload invalid");
}
