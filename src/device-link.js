(function (global) {
  'use strict';
  const PROTOCOL = 'vlab-p2-json/1';
  const MAX_STEP = 0.1;
  const copy = value => JSON.parse(JSON.stringify(value));
  const SAMPLE_DRIVER = `function encode(command) {
  let packet;
  if (Array.isArray(command) && command.length === 2 &&
      command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 0.1)) {
    packet = {op:'step',channels:command};
  } else if (command && command.op === 'lift' && ['up','down'].includes(command.position) && Object.keys(command).sort().join(',') === 'op,position') {
    packet = {op:'lift',position:command.position};
  } else if (command && command.op === 'grip' && ['open','closed'].includes(command.state) && Object.keys(command).sort().join(',') === 'op,state') {
    packet = {op:'grip',state:command.state};
  } else {
    throw new Error('Expected bounded XY array, lift position, or grip state.');
  }
  return JSON.stringify(packet) + '\\n';
}
function decode(rawReply) {
  const reply = JSON.parse(rawReply);
  const value = reply.accepted;
  const xy = Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 0.100000000001);
  const lift = value && value.op === 'lift' && ['up','down'].includes(value.position) && Object.keys(value).sort().join(',') === 'op,position';
  const grip = value && value.op === 'grip' && ['open','closed'].includes(value.state) && Object.keys(value).sort().join(',') === 'op,state';
  if (reply.ok !== true || !(xy || lift || grip) || typeof reply.limited !== 'boolean') {
    throw new Error('Invalid device acknowledgement.');
  }
  return {applied:value,limited:reply.limited};
}`;

  const SAMPLE_DRIVER_G3 = `function encode(command) {
  const hex = bytes => bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join('');
  const frame = payload => { const body = [payload.length, ...payload]; return hex([0xa5, ...body, body.reduce((x, b) => x ^ b, 0)]); };
  const int16 = v => { const n = Math.round(v * 10000); const u = n < 0 ? n + 65536 : n; return [(u >> 8) & 255, u & 255]; };
  if (Array.isArray(command) && command.length === 2 && command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 0.1)) {
    return frame([0x10, ...int16(command[0]), ...int16(command[1])]);
  }
  if (command && command.op === 'lift' && ['up','down'].includes(command.position) && Object.keys(command).sort().join(',') === 'op,position') return frame([0x20, command.position === 'up' ? 1 : 0]);
  if (command && command.op === 'grip' && ['open','closed'].includes(command.state) && Object.keys(command).sort().join(',') === 'op,state') return frame([0x21, command.state === 'closed' ? 1 : 0]);
  throw new Error('Expected bounded XY array, lift position, or grip state.');
}
function decode(rawReply) {
  if (typeof rawReply !== 'string' || rawReply.length % 2 || !/^[0-9a-f]+$/.test(rawReply)) throw new Error('Reply is not lowercase hex.');
  const bytes = []; for (let i = 0; i < rawReply.length; i += 2) bytes.push(parseInt(rawReply.slice(i, i + 2), 16));
  if (bytes[0] !== 0xa5 || bytes.length < 4 || bytes[1] !== bytes.length - 3) throw new Error('Bad frame.');
  const body = bytes.slice(1, -1); if (body.reduce((x, b) => x ^ b, 0) !== bytes[bytes.length - 1]) throw new Error('Bad checksum.');
  const p = bytes.slice(2, -1), i16 = i => { const v = (p[i] << 8) | p[i + 1]; return v >= 32768 ? v - 65536 : v; };
  if (p[0] !== 0) throw new Error('Device error ' + p[0]);
  if (p[1] === 0x10 && p.length === 7 && p[6] <= 1) { const a = [i16(2) / 10000, i16(4) / 10000]; if (a.some(v => Math.abs(v) > 0.1)) throw new Error('Out of range.'); return {applied:a,limited:p[6] === 1}; }
  if (p[1] === 0x20 && p.length === 4 && p[2] <= 1 && p[3] <= 1) return {applied:{op:'lift',position:p[2] ? 'up' : 'down'},limited:p[3] === 1};
  if (p[1] === 0x21 && p.length === 4 && p[2] <= 1 && p[3] <= 1) return {applied:{op:'grip',state:p[2] ? 'closed' : 'open'},limited:p[3] === 1};
  throw new Error('Unexpected reply layout.');
}`;
  const SAMPLE_DRIVER_X = `function encode(command) {
  const crc = bytes => { let c = 0xffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; } return c; };
  const hex = bytes => bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join('');
  const rtu = body => { const c = crc(body); return hex([...body, c & 255, (c >> 8) & 255]); };
  const u16 = v => [(v >> 8) & 255, v & 255];
  const s16 = v => { const n = Math.round(v * 10000); return u16(n < 0 ? n + 65536 : n); };
  if (Array.isArray(command) && command.length === 2 && command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 0.1)) {
    return rtu([0x11, 0x17, ...u16(0x0310), ...u16(3), ...u16(0x0300), ...u16(2), 4, ...s16(command[0]), ...s16(command[1])]);
  }
  if (command && command.op === 'lift' && ['up','down'].includes(command.position) && Object.keys(command).sort().join(',') === 'op,position') return rtu([0x11, 0x06, ...u16(0x0200), ...u16(command.position === 'up' ? 1 : 0)]);
  if (command && command.op === 'grip' && ['open','closed'].includes(command.state) && Object.keys(command).sort().join(',') === 'op,state') return rtu([0x11, 0x06, ...u16(0x0201), ...u16(command.state === 'closed' ? 1 : 0)]);
  throw new Error('Expected bounded XY array, lift position, or grip state.');
}
function decode(rawReply) {
  if (typeof rawReply !== 'string' || rawReply === '') throw new Error('No reply from device.');
  if (rawReply.length % 2 || !/^[0-9a-f]+$/.test(rawReply)) throw new Error('Reply is not lowercase hex.');
  const b = []; for (let i = 0; i < rawReply.length; i += 2) b.push(parseInt(rawReply.slice(i, i + 2), 16));
  if (b.length < 5) throw new Error('Reply too short.');
  let c = 0xffff; for (const x of b.slice(0, -2)) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; }
  if (b[b.length - 2] !== (c & 255) || b[b.length - 1] !== ((c >> 8) & 255)) throw new Error('Bad CRC.');
  if (b[0] !== 0x11) throw new Error('Wrong unit address.');
  if (b[1] & 0x80) throw new Error('Device exception ' + b[2]);
  const u16 = i => (b[i] << 8) | b[i + 1], s16 = i => { const v = u16(i); return (v >= 32768 ? v - 65536 : v) / 10000; };
  if (b[1] === 0x17 && b.length === 11 && b[2] === 6) {
    const flags = u16(7); if (flags > 1) throw new Error('Bad flags.');
    const applied = [s16(3), s16(5)]; if (applied.some(v => Math.abs(v) > 0.1)) throw new Error('Out of range.');
    return {applied, limited: flags === 1};
  }
  if (b[1] === 0x06 && b.length === 8) {
    const reg = u16(2), value = u16(4);
    if (reg === 0x0200 && value <= 1) return {applied: {op: 'lift', position: value ? 'up' : 'down'}, limited: false};
    if (reg === 0x0201 && value <= 1) return {applied: {op: 'grip', state: value ? 'closed' : 'open'}, limited: false};
  }
  throw new Error('Unexpected reply layout.');
}`;
  const DEVICES = {
    'VLAB-P2': {protocol:PROTOCOL, kinematics:'2r', serialBaud:115200, tcpPort:7402, endpoint:'arm', product:'VLAB-P2 virtual arm interface', firmware:'sim-2.0'},
    'VLAB-G3': {protocol:'vlab-g3-bin/1', kinematics:'gantry', serialBaud:57600, tcpPort:7410, endpoint:'gantry', product:'VLAB-G3 virtual gantry controller', firmware:'sim-g3-1.0'},
    // Held-out evaluation device: excluded from the default manual library and
    // from development; experiments must enable it explicitly (includeHoldout).
    'VLAB-X': {protocol:'vlab-x-modbus/1', kinematics:'corexy', serialBaud:19200, tcpPort:502, endpoint:'corexy', product:'VLAB-X virtual CoreXY motion controller', firmware:'sim-x-1.0', holdout:true}
  };

  function validCommand(command) {
    return Array.isArray(command) && command.length === 2 &&
      command.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_STEP);
  }
  function validManipulation(command) {
    if (!command || Array.isArray(command)) return false;
    return (command.op === 'lift' && ['up','down'].includes(command.position) && Object.keys(command).sort().join(',') === 'op,position') ||
      (command.op === 'grip' && ['open','closed'].includes(command.state) && Object.keys(command).sort().join(',') === 'op,state');
  }
  function parseWire(wire) {
    if (typeof wire !== 'string' || wire.length > 1024 || !wire.endsWith('\n') ||
        /[\r\n]/.test(wire.slice(0, -1))) throw new Error('FRAME: expected one JSON line, ending in LF.');
    const value = JSON.parse(wire);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FRAME: expected JSON object.');
    return value;
  }

  class SimulatedDeviceLink {
    #plant; #seed; #transport; #connected = null; #hello = false; #traffic = []; #sequence = 0; #enabled = false; #homed = false;
    #canvas; #context; #model; #device; #includeTemplate;
    constructor({plant, seed = 42, model = 'VLAB-P2', includeTemplate = true} = {}) {
      if (!plant || typeof plant.act !== 'function' || typeof plant.frame !== 'function') throw new Error('A virtual plant is required.');
      if (!DEVICES[model]) throw new Error('DEVICE: unknown simulated device model.');
      this.#plant = plant;
      this.#seed = Number(seed) >>> 0;
      this.#model = model; this.#device = DEVICES[model]; this.#includeTemplate = Boolean(includeTemplate);
      this.#transport = this.#seed % 3 === 1 ? 'tcp' : 'serial';
      this.#canvas = document.createElement('canvas');
      this.#context = this.#canvas.getContext('2d', {willReadFrequently:true});
    }
    get model() { return this.#model; }
    get protocol() { return this.#connected?.protocol || null; }
    get includeTemplate() { return this.#includeTemplate; }
    static models({includeHoldout = false} = {}) { return Object.keys(DEVICES).filter(id => includeHoldout || !DEVICES[id].holdout); }
    static isHoldout(model) { return Boolean(DEVICES[model]?.holdout); }
    inventory() {
      const d = this.#device, serial = this.#transport === 'serial', tag = d.endpoint;
      return [
        {endpointId:'sim-serial-logger', transport:'serial', deviceModel:'LOGGER-1', product:'LOGGER-1 virtual recorder', manufacturer:'Virtual Lab', address:'SIM-COM3', simulated:true},
        {endpointId:serial ? 'sim-serial-' + tag : 'sim-tcp-' + tag, transport:this.#transport, deviceModel:this.#model, product:d.product, manufacturer:'Virtual Lab', address:serial ? ({'VLAB-P2':'SIM-COM7','VLAB-G3':'SIM-COM9'}[this.#model] || 'SIM-COM5') : 'SIM-NET-' + tag.toUpperCase() + ':' + d.tcpPort, simulated:true}
      ];
    }
    // The host manual library holds every simulated model. Reading the wrong
    // document yields a wrong protocol, which the connection check rejects.
    manual(documentId) {
      if (!DEVICES[documentId]) throw new Error('找不到該模擬設備文件。');
      const transport = documentId === this.#model ? this.#transport : 'serial';
      const manual = documentId === 'VLAB-X' ? this.#manualX(transport) : documentId === 'VLAB-G3' ? this.#manualG3(transport) : this.#manualP2(transport);
      manual.protocolSpec = global.VlabProtocols ? global.VlabProtocols.spec(manual.connection.protocol) : null;
      if (!this.#includeTemplate) {
        delete manual.sampleDriver; delete manual.sampleDriverSource;
        manual.templateIncluded = false;
        manual.templateNote = '本次實驗的手冊不提供驅動範本；請依 protocol 說明與 protocolSpec 自行撰寫 encode/decode。';
      } else manual.templateIncluded = true;
      return manual;
    }
    #manualP2(transport) {
      return {
        documentId:'VLAB-P2', model:'VLAB-P2', title:'VLAB-P2 模擬設備通訊手冊', simulated:true,
        disclaimer:'這是虛擬設備的內建測試手冊，並非實體產品規格。相機只提供外觀假設，連線身分須由握手確認。',
        deviceClass:'兩個未知旋轉通道，搭配已知升降與夾爪命令的桌面手臂', channels:2, channelKind:'rotary',
        manipulation:{lift:['up','down'],grip:['open','closed'],
          constraints:'夾爪僅在下降、靠近物件、高度一致且由開轉閉時可能抓住物件。閉爪回覆不代表抓取成功；必須從影像驗證提起與跟隨。張開時物件垂直落至當地桌面或平台，位置不會吸附至 B。低於平台頂面的平面穿越會整筆拒絕，不執行任何通道。',
          liftSemantics:'up 是固定安全高度 1；down 是設備內建的順應式下降，停止於夾具 XY 正下方的支撐面，可能是桌面 0 或已設置的平台。這是已知設備功能，並非代理學會任意 Z 軸控制。ACK 只確認指令，不回傳平台、物件或實际抓取高度。',
          cameraHeightEvidence:'連續取放場景中，藍色大圈是 B 的地面 XY 參考，紫色小圈是平台頂面參考；兩個圈在影像中的垂直差可用於驗證放置高度。搬運到 B 使用藍圈中心，放置完成須確認物件在紫圈位置且釋放後沒有掉回桌面。'},
        connection:{transport, baudRate:transport === 'serial' ? 115200 : 0, protocol:PROTOCOL},
        selection:'從已列出的模擬介面，選擇 deviceModel 為 VLAB-P2 且 transport 符合 connection 的端點。',
        protocol:{name:PROTOCOL, framing:'每筆 UTF-8 JSON 物件後加一個 LF 換行，不允許多筆串接。', hello:'{"op":"hello"}\n',
          command:'{"op":"step","channels":[0.02,0]}\n', reply:'{"ok":true,"accepted":[0.02,0],"limited":false}\n',
          liftCommand:'{"op":"lift","position":"up"}\n',
          liftReply:'{"ok":true,"accepted":{"op":"lift","position":"up"},"limited":false}\n',
          gripCommand:'{"op":"grip","state":"closed"}\n',
          gripReply:'{"ok":true,"accepted":{"op":"grip","state":"closed"},"limited":false}\n',
          limits:{channels:2,min:-MAX_STEP,max:MAX_STEP,units:'相對致動指令；未知的角度增益與通道方向須由觀察取得。'},
          errors:'ok:false 表示不執行。accepted 是設備實際接受的指令；遇機械行程限制時 limited:true。'},
        hiddenProperties:['連桿長度','通道對應','正負方向','角度增益','相機轉換'],
        driverContract:'定義 JavaScript encode(command) 回傳 LF 結尾 JSON 字串；command 可為 [a,b]（轉成 step 封包）、{op:"lift",position:"up"|"down"} 或 {op:"grip",state:"open"|"closed"}。decode(rawReply) 回傳 {applied:reply.accepted,limited:reply.limited}；applied 可為陣列或原升降／夾爪命令物件。函式每次獨立執行，不可依賴全域狀態或網路。三類命令都須通過測試。',
        sampleDriver:SAMPLE_DRIVER, sampleDriverSource:SAMPLE_DRIVER
      };
    }
    #manualG3(transport) {
      const example = global.VlabProtocols.get('vlab-g3-bin/1');
      return {
        documentId:'VLAB-G3', model:'VLAB-G3', title:'VLAB-G3 模擬龍門設備通訊手冊', simulated:true,
        disclaimer:'這是虛擬設備的內建測試手冊，並非實體產品規格。相機只提供外觀假設，連線身分須由握手確認。',
        deviceClass:'兩個未知直線軸（龍門／直角座標），搭配已知升降與夾爪命令', channels:2, channelKind:'linear',
        manipulation:{lift:['up','down'],grip:['open','closed'],
          constraints:'夾爪僅在下降、靠近物件、高度一致且由開轉閉時可能抓住物件。閉爪回覆不代表抓取成功；必須從影像驗證提起與跟隨。張開時物件垂直落至當地桌面或平台。低於平台頂面的平面穿越會整筆拒絕，不執行任何通道。',
          liftSemantics:'up 是固定安全高度 1；down 停止於夾具 XY 正下方的支撐面（桌面 0 或平台）。這是已知設備功能，不是任意 Z 軸控制。',
          cameraHeightEvidence:'藍色大圈是 B 的地面 XY 參考，紫色小圈是平台頂面參考；兩圈的影像垂直差可驗證放置高度。'},
        connection:{transport, baudRate:transport === 'serial' ? 57600 : 0, protocol:'vlab-g3-bin/1'},
        selection:'從已列出的模擬介面，選擇 deviceModel 為 VLAB-G3 且 transport 符合 connection 的端點。',
        protocol:{name:'vlab-g3-bin/1',
          framing:'二進位框架：0xA5 同步位元組 | 長度 LEN（payload 位元組數）| payload | 檢查碼（LEN 與所有 payload 位元組的 XOR）。線上以小寫十六進位字串表示每個位元組，不加空白或換行。',
          hello:example.hello, helloReply:example.replyHello('VLAB-G3', MAX_STEP),
          command:example.encodeCommand([0.02, 0]), reply:example.replyStep([0.02, 0], false),
          commandLayout:'STEP payload = 0x10, int16be(A×10000), int16be(B×10000)；LIFT = 0x20, 0 下降／1 升起；GRIP = 0x21, 0 張開／1 合攏；HELLO = 0x01。',
          replyLayout:'回覆 payload[0] 為狀態（0 成功，非 0 為錯誤碼），payload[1] 回傳原 opcode。STEP 回覆再接 int16be A、int16be B（實際接受值×10000）與旗標（bit0=受限）；LIFT／GRIP 回覆再接狀態碼與旗標。HELLO 回覆再接協定版本、通道數、int16be 最大步幅×10000 與 ASCII 型號。',
          liftCommand:example.encodeCommand({op:'lift', position:'up'}), liftReply:example.replyAuxiliary({op:'lift', position:'up'}, false),
          gripCommand:example.encodeCommand({op:'grip', state:'closed'}), gripReply:example.replyAuxiliary({op:'grip', state:'closed'}, false),
          limits:{channels:2,min:-MAX_STEP,max:MAX_STEP,resolution:0.0001,units:'相對直線軸位移指令；軸向對應、正負方向與增益未知，須由觀察取得。'},
          errors:'錯誤碼：1 FRAME、2 CHECKSUM、3 NOT_READY、4 LIMIT、5 OPCODE、6 ARGUMENT、7 COLLISION（低於平台頂面的穿越，整筆拒絕）；錯誤時不執行。遇行程限制時旗標 bit0=1，回覆值為實際接受量。'},
        hiddenProperties:['軸向對應','正負方向','位移增益','行程範圍','相機轉換'],
        driverContract:'定義 JavaScript encode(command) 回傳小寫十六進位框架字串；command 可為 [a,b]（|a|,|b|≤0.1，主機已量化到 0.0001）、{op:"lift",position:"up"|"down"} 或 {op:"grip",state:"open"|"closed"}。decode(rawReply) 驗證同步、長度、檢查碼與狀態，回傳 {applied,limited}；applied 為 [a,b] 數值（÷10000）或原升降／夾爪命令物件。錯誤或毀損回覆必須 throw。函式每次獨立執行，不可依賴全域狀態或網路。',
        sampleDriver:SAMPLE_DRIVER_G3, sampleDriverSource:SAMPLE_DRIVER_G3
      };
    }
    #manualX(transport) {
      const p = global.VlabProtocols.get('vlab-x-modbus/1'), r = p.registers;
      const hex = n => '0x' + n.toString(16).padStart(4, '0');
      return {
        documentId:'VLAB-X', model:'VLAB-X', title:'VLAB-X 模擬 CoreXY 運動控制器通訊手冊', simulated:true,
        disclaimer:'這是虛擬設備的內建測試手冊，並非實體產品規格。相機只提供外觀假設，連線身分須由握手確認。',
        deviceClass:'CoreXY 平面機構：兩顆皮帶馬達通道共同驅動同一個滑座（每個通道都會同時改變兩個方向），搭配已知升降與夾爪命令', channels:2, channelKind:'linear',
        manipulation:{lift:['up','down'],grip:['open','closed'],
          constraints:'夾爪僅在下降、靠近物件、高度一致且由開轉閉時可能抓住物件。閉爪回覆不代表抓取成功；必須從影像驗證提起與跟隨。張開時物件垂直落至當地桌面或平台。低於平台頂面的平面穿越會整筆拒絕（例外碼 4），不執行任何通道。',
          liftSemantics:'up 是固定安全高度 1；down 停止於夾具 XY 正下方的支撐面（桌面 0 或平台）。這是已知設備功能，不是任意 Z 軸控制。',
          cameraHeightEvidence:'藍色大圈是 B 的地面 XY 參考，紫色小圈是平台頂面參考；兩圈的影像垂直差可驗證放置高度。'},
        connection:{transport, baudRate:transport === 'serial' ? 19200 : 0, protocol:'vlab-x-modbus/1'},
        selection:'從已列出的模擬介面，選擇 deviceModel 為 VLAB-X 且 transport 符合 connection 的端點。',
        protocol:{name:'vlab-x-modbus/1',
          framing:'Modbus-RTU 風格框架：單元位址 0x11 | 功能碼 | 資料 | CRC-16/MODBUS（多項式 0xA001 反射、初值 0xFFFF，低位元組在前）。線上以小寫十六進位字串表示每個位元組，不加空白或換行。位址不符或 CRC 錯誤時設備不回覆（空字串）。',
          hello:p.hello, helloReply:p.replyIdentity('VLAB-X', MAX_STEP),
          command:p.encodeCommand([0.02, 0]), reply:p.replyStep([0.02, 0], false),
          commandLayout:`暫存器：識別 ${hex(r.identity)}×6（協定版本、通道數、最大步幅×10000、ASCII 型號每暫存器 2 字元）、ENABLE ${hex(r.enable)}、HOME ${hex(r.home)}、STATUS ${hex(r.status)}（bit0 已啟用、bit1 已歸零）、LIFT ${hex(r.lift)}（0 下降／1 升起）、GRIP ${hex(r.grip)}（0 張開／1 合攏）、STEP ${hex(r.step)}–${hex(r.step + 1)}（s16，輸入×10000）、RESULT ${hex(r.result)}–${hex(r.result + 2)}（實際接受 A、B 與旗標）。STEP 用功能碼 0x17（讀寫多個暫存器）：讀起點 ${hex(r.result)}、讀 3 個、寫起點 ${hex(r.step)}、寫 2 個、位元組數 4、兩個 s16 值。LIFT／GRIP 用功能碼 0x06 寫單一暫存器。`,
          replyLayout:'0x17 回覆：位元組數 6，接 s16 A、s16 B（實際接受值×10000）與 u16 旗標（bit0=受限）。0x06 回覆原樣回送暫存器與值，代表已執行（未受限）。例外回覆：功能碼 | 0x80，接 1 位元組例外碼。',
          liftCommand:p.encodeCommand({op:'lift', position:'up'}), liftReply:p.replyAuxiliary({op:'lift', position:'up'}),
          gripCommand:p.encodeCommand({op:'grip', state:'closed'}), gripReply:p.replyAuxiliary({op:'grip', state:'closed'}),
          limits:{channels:2,min:-MAX_STEP,max:MAX_STEP,resolution:0.0001,units:'相對馬達步進指令；CoreXY 耦合、方向與增益未知，須由觀察取得。'},
          errors:'例外碼：1 ILLEGAL_FUNCTION、2 ILLEGAL_DATA_ADDRESS、3 ILLEGAL_DATA_VALUE（超出範圍）、4 DEVICE_FAILURE（低於平台頂面的穿越，整筆拒絕）、6 DEVICE_BUSY_NOT_READY（尚未啟用或歸零）；例外時不執行。啟動程序：handshake 時主機依序讀識別暫存器、寫 ENABLE=1、寫 HOME=1，並讀 STATUS 確認 bit0 與 bit1；完成前所有動作命令回覆例外碼 6。遇行程限制時旗標 bit0=1，回覆值為實際接受量。皮帶傳動有反向間隙：馬達改變方向後的最初一小段轉動不會移動滑座，ACK 仍回報馬達接受的指令。'},
        hiddenProperties:['CoreXY 通道與方向的組合','正負方向','皮帶增益','反向間隙大小','行程範圍','相機轉換'],
        driverContract:'定義 JavaScript encode(command) 回傳小寫十六進位 Modbus-RTU 框架字串（含單元位址 0x11 與 CRC-16，低位元組在前）；command 可為 [a,b]（|a|,|b|≤0.1，主機已量化到 0.0001，以 0x17 寫入 STEP 並讀回 RESULT）、{op:"lift",position:"up"|"down"} 或 {op:"grip",state:"open"|"closed"}（以 0x06 寫入 LIFT／GRIP）。decode(rawReply) 驗證位址、CRC、功能碼與長度，例外回覆、空字串（設備未回覆）或毀損回覆必須 throw；回傳 {applied,limited}，applied 為 [a,b] 數值（÷10000）或原升降／夾爪命令物件，0x06 回送的 limited 為 false。啟動程序由主機在 handshake 執行，驅動程式不需編碼 ENABLE／HOME。函式每次獨立執行，不可依賴全域狀態或網路。',
        sampleDriver:SAMPLE_DRIVER_X, sampleDriverSource:SAMPLE_DRIVER_X
      };
    }
    connect(args = {}) {
      if (this.#connected) throw new Error('ALREADY_CONNECTED: disconnect before changing endpoint.');
      const entry = this.inventory().find(item => item.endpointId === args.endpointId), d = this.#device;
      if (!entry) throw new Error('ENDPOINT: endpoint is not in the simulated inventory.');
      if (entry.deviceModel !== this.#model) throw new Error('DEVICE_IDENTITY_MISMATCH: selected interface belongs to ' + entry.deviceModel + '.');
      if (args.transport !== entry.transport) throw new Error('TRANSPORT: interface transport does not match.');
      if (args.protocol !== d.protocol) throw new Error('PROTOCOL: expected ' + d.protocol);
      if (entry.transport === 'serial' && args.baudRate !== d.serialBaud) throw new Error('BAUD: this virtual serial profile requires ' + d.serialBaud + '.');
      if (entry.transport === 'tcp' && args.baudRate !== 0) throw new Error('BAUD: TCP profile uses baudRate 0 (not applicable).');
      this.#connected = {...entry, baudRate:args.baudRate, protocol:d.protocol, connected:true};
      this.#hello = false;
      this.#log('event', 'OPEN ' + entry.address, false);
      return copy(this.#connected);
    }
    disconnect() { this.#connected = null; this.#hello = false; }
    // Drive enable and homing persist across reconnects of the same device.
    handshake() {
      if (this.#device.protocol !== PROTOCOL && global.VlabProtocols.get(this.#device.protocol).startup) {
        const profile = global.VlabProtocols.get(this.#device.protocol);
        const identity = profile.parseReply(this.exchange(profile.hello));
        if (!identity.ok || identity.model !== this.#model || identity.channels !== 2) throw new Error('HANDSHAKE: identity or capabilities failed.');
        const startup = [];
        for (const step of profile.startup) {
          const reply = profile.parseReply(this.exchange(step.wire));
          if (!reply.ok || (step.expectStatus !== undefined && reply.status !== step.expectStatus)) throw new Error('HANDSHAKE: start-up step ' + step.name + ' failed.');
          startup.push(step.name);
        }
        return {ok:true, model:identity.model, protocol:identity.protocol, protocolVersion:identity.protocolVersion, channels:identity.channels, maxStep:identity.maxStep, firmware:this.#device.firmware,
          capabilities:{xy:'relative-unknown-mapping',lift:['up','down'],grip:['open','closed']}, startup, simulated:true};
      }
      if (this.#device.protocol !== PROTOCOL) {
        const profile = global.VlabProtocols.get(this.#device.protocol);
        const reply = profile.parseReply(this.exchange(profile.hello));
        if (!reply.ok || reply.model !== this.#model || reply.channels !== 2) throw new Error('HANDSHAKE: identity or capabilities failed.');
        return {...reply, firmware:this.#device.firmware, capabilities:{xy:'relative-unknown-mapping',lift:['up','down'],grip:['open','closed']}, simulated:true};
      }
      const reply = JSON.parse(this.exchange('{"op":"hello"}\n'));
      if (!reply.ok || reply.model !== 'VLAB-P2' || reply.protocol !== PROTOCOL || reply.channels !== 2) throw new Error('HANDSHAKE: identity or capabilities failed.');
      return reply;
    }
    #exchangeBinary(wire, dryRun) {
      const profile = global.VlabProtocols.get(this.#device.protocol);
      const parsed = profile.deviceRequest(wire);
      let result;
      if (parsed.error) result = profile.replyError(parsed.error, parsed.op);
      else {
        const request = parsed.request;
        if (request.op === 'hello') { this.#hello = true; result = profile.replyHello(this.#model, MAX_STEP); }
        else if (!this.#hello) result = profile.replyError(3, request.op === 'step' ? 0x10 : request.op === 'lift' ? 0x20 : 0x21);
        else if (request.op === 'step') {
          try {
            const outcome = dryRun ? {applied:request.channels.slice(),limited:false} : this.#plant.act(request.channels.slice());
            result = profile.replyStep(outcome.applied, outcome.limited);
          } catch (error) { result = profile.replyError(/COLLISION/.test(String(error.message)) ? 7 : 4, 0x10); }
        } else {
          const command = request.op === 'lift' ? {op:'lift',position:request.position} : {op:'grip',state:request.state};
          const outcome = dryRun ? {applied:copy(command),limited:false} : this.#plant.act(copy(command));
          result = profile.replyAuxiliary(outcome.applied, outcome.limited);
        }
      }
      return result;
    }
    #exchangeModbus(wire, dryRun) {
      const profile = global.VlabProtocols.get(this.#device.protocol), r = profile.registers;
      const parsed = profile.deviceRequest(wire);
      if (parsed.silent) return '';
      if (parsed.exception) return profile.replyException(parsed.fn, parsed.exception);
      const request = parsed.request;
      if (request.kind === 'read') return request.start === r.identity ? profile.replyIdentity(this.#model, MAX_STEP) : profile.replyStatus((this.#enabled ? 1 : 0) | (this.#homed ? 2 : 0));
      if (request.kind === 'enable') { this.#enabled = true; return profile.replyWrite(r.enable, 1); }
      if (request.kind === 'home') {
        if (!this.#enabled) return profile.replyException(0x06, 6);
        this.#homed = true; this.#hello = true; return profile.replyWrite(r.home, 1);
      }
      const fn = request.kind === 'step' ? 0x17 : 0x06;
      if (!this.#enabled || !this.#homed) return profile.replyException(fn, 6);
      if (request.kind === 'step') {
        try {
          const outcome = dryRun ? {applied:request.channels.slice(),limited:false} : this.#plant.act(request.channels.slice());
          return profile.replyStep(outcome.applied, outcome.limited);
        } catch (error) { return profile.replyException(fn, /COLLISION/.test(String(error.message)) ? 4 : 3); }
      }
      const command = request.kind === 'lift' ? {op:'lift',position:request.position} : {op:'grip',state:request.state};
      const outcome = dryRun ? {applied:copy(command),limited:false} : this.#plant.act(copy(command));
      return profile.replyAuxiliary(outcome.applied);
    }
    exchange(wire, {dryRun = false} = {}) {
      if (!this.#connected) throw new Error('NOT_CONNECTED: connect to a simulated endpoint first.');
      this.#log('TX', typeof wire === 'string' ? wire.slice(0,1024) : '<non-string>', dryRun);
      if (this.#device.protocol !== PROTOCOL && global.VlabProtocols.get(this.#device.protocol).family === 'modbus-rtu') {
        const result = typeof wire === 'string' ? this.#exchangeModbus(wire, dryRun) : '';
        this.#log('RX', result, dryRun);
        return result;
      }
      if (this.#device.protocol !== PROTOCOL) {
        const result = typeof wire === 'string' ? this.#exchangeBinary(wire, dryRun) : global.VlabProtocols.get(this.#device.protocol).replyError(1, 0);
        this.#log('RX', result, dryRun);
        return result;
      }
      let reply;
      try {
        const request = parseWire(wire);
        if (request.op === 'hello' && Object.keys(request).length === 1) {
          this.#hello = true;
          reply = {ok:true,model:'VLAB-P2',protocol:PROTOCOL,firmware:'sim-2.0',channels:2,maxStep:MAX_STEP,
            capabilities:{xy:'relative-unknown-mapping',lift:['up','down'],grip:['open','closed']},simulated:true};
        } else if (request.op === 'step') {
          if (!this.#hello) throw new Error('NOT_READY: successful hello is required before movement.');
          if (Object.keys(request).sort().join(',') !== 'channels,op' || !validCommand(request.channels)) throw new Error('LIMIT: two finite channels in [-0.1,0.1] are required.');
          const outcome = dryRun ? {applied:request.channels.slice(),limited:false} : this.#plant.act(request.channels.slice());
          reply = {ok:true,accepted:outcome.applied,limited:Boolean(outcome.limited)};
        } else if (request.op === 'lift' || request.op === 'grip') {
          if (!this.#hello) throw new Error('NOT_READY: successful hello is required before manipulation.');
          if (!validManipulation(request)) throw new Error('COMMAND: invalid lift/grip state.');
          const outcome = dryRun ? {applied:copy(request),limited:false} : this.#plant.act(copy(request));
          // This acknowledgement confirms execution of an actuator command,
          // not attachment or successful placement. Those need image evidence.
          reply = {ok:true,accepted:outcome.applied,limited:Boolean(outcome.limited)};
        } else throw new Error('OP: unknown operation or malformed hello.');
      } catch (error) { reply = {ok:false,error:String(error.message || 'Invalid frame').slice(0,240)}; }
      const result = JSON.stringify(reply) + '\n';
      this.#log('RX', result, dryRun);
      return result;
    }
    #log(direction, wire, dryRun) {
      this.#traffic.push({sequence:++this.#sequence,direction,wire,dryRun:Boolean(dryRun),endpointId:this.#connected?.endpointId || null,transport:this.#transport});
      if (this.#traffic.length > 3000) this.#traffic.shift();
    }
    traffic() { return copy(this.#traffic); }
    get connected() { return Boolean(this.#connected); }
    get ready() { return this.#hello; }
    frame() {
      const frame = this.#plant.frame(), canvas = this.#canvas, ctx = this.#context;
      if (canvas.width !== frame.width || canvas.height !== frame.height) { canvas.width=frame.width; canvas.height=frame.height; }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);
      // A visible synthetic nameplate is part of the camera pixels. It contains
      // no geometry, joint state, channel gain, or other privileged telemetry.
      ctx.fillStyle='#243540'; ctx.fillRect(16,frame.height-49,150,33);
      ctx.strokeStyle='#879aa3'; ctx.lineWidth=1; ctx.strokeRect(16.5,frame.height-48.5,149,32);
      ctx.font='bold 18px monospace'; ctx.fillStyle='#eef3f4'; ctx.fillText(this.#model,29,frame.height-26);
      return {width:frame.width,height:frame.height,pixels:ctx.getImageData(0,0,frame.width,frame.height).data};
    }
    diagnostics() { return this.#plant.diagnostics(); }
  }
  global.SimulatedDeviceLink = SimulatedDeviceLink;
})(globalThis);
