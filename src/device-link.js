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
    #plant; #seed; #transport; #connected = null; #hello = false; #traffic = []; #sequence = 0;
    #canvas; #context;
    constructor({plant, seed = 42} = {}) {
      if (!plant || typeof plant.act !== 'function' || typeof plant.frame !== 'function') throw new Error('A virtual plant is required.');
      this.#plant = plant;
      this.#seed = Number(seed) >>> 0;
      this.#transport = this.#seed % 3 === 1 ? 'tcp' : 'serial';
      this.#canvas = document.createElement('canvas');
      this.#context = this.#canvas.getContext('2d', {willReadFrequently:true});
    }
    inventory() {
      return [
        {endpointId:'sim-serial-logger', transport:'serial', deviceModel:'LOGGER-1', product:'LOGGER-1 virtual recorder', manufacturer:'Virtual Lab', address:'SIM-COM3', simulated:true},
        {endpointId:this.#transport === 'serial' ? 'sim-serial-arm' : 'sim-tcp-arm', transport:this.#transport, deviceModel:'VLAB-P2', product:'VLAB-P2 virtual arm interface', manufacturer:'Virtual Lab', address:this.#transport === 'serial' ? 'SIM-COM7' : 'SIM-NET-ARM:7402', simulated:true}
      ];
    }
    manual(documentId) {
      if (documentId !== 'VLAB-P2') throw new Error('找不到該模擬設備文件。');
      return {
        documentId:'VLAB-P2', model:'VLAB-P2', title:'VLAB-P2 模擬設備通訊手冊', simulated:true,
        disclaimer:'這是虛擬設備的內建測試手冊，並非實體產品規格。相機只提供外觀假設，連線身分須由握手確認。',
        deviceClass:'兩個未知旋轉通道，搭配已知升降與夾爪命令的桌面手臂', channels:2,
        manipulation:{lift:['up','down'],grip:['open','closed'],
          constraints:'夾爪僅在下降、靠近物件、高度一致且由開轉閉時可能抓住物件。閉爪回覆不代表抓取成功；必須從影像驗證提起與跟隨。張開時物件垂直落至當地桌面或平台，位置不會吸附至 B。低於平台頂面的平面穿越會整筆拒絕，不執行任何通道。',
          liftSemantics:'up 是固定安全高度 1；down 是設備內建的順應式下降，停止於夾具 XY 正下方的支撐面，可能是桌面 0 或已設置的平台。這是已知設備功能，並非代理學會任意 Z 軸控制。ACK 只確認指令，不回傳平台、物件或實际抓取高度。',
          cameraHeightEvidence:'連續取放場景中，藍色大圈是 B 的地面 XY 參考，紫色小圈是平台頂面參考；兩個圈在影像中的垂直差可用於驗證放置高度。搬運到 B 使用藍圈中心，放置完成須確認物件在紫圈位置且釋放後沒有掉回桌面。'},
        connection:{transport:this.#transport, baudRate:this.#transport === 'serial' ? 115200 : 0, protocol:PROTOCOL},
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
    connect(args = {}) {
      if (this.#connected) throw new Error('ALREADY_CONNECTED: disconnect before changing endpoint.');
      const entry = this.inventory().find(item => item.endpointId === args.endpointId);
      if (!entry) throw new Error('ENDPOINT: endpoint is not in the simulated inventory.');
      if (entry.deviceModel !== 'VLAB-P2') throw new Error('DEVICE_IDENTITY_MISMATCH: selected interface belongs to LOGGER-1.');
      if (args.transport !== entry.transport) throw new Error('TRANSPORT: interface transport does not match.');
      if (args.protocol !== PROTOCOL) throw new Error('PROTOCOL: expected ' + PROTOCOL);
      if (entry.transport === 'serial' && args.baudRate !== 115200) throw new Error('BAUD: this virtual serial profile requires 115200.');
      if (entry.transport === 'tcp' && args.baudRate !== 0) throw new Error('BAUD: TCP profile uses baudRate 0 (not applicable).');
      this.#connected = {...entry, baudRate:args.baudRate, protocol:PROTOCOL, connected:true};
      this.#hello = false;
      this.#log('event', 'OPEN ' + entry.address, false);
      return copy(this.#connected);
    }
    disconnect() { this.#connected = null; this.#hello = false; }
    handshake() {
      const reply = JSON.parse(this.exchange('{"op":"hello"}\n'));
      if (!reply.ok || reply.model !== 'VLAB-P2' || reply.protocol !== PROTOCOL || reply.channels !== 2) throw new Error('HANDSHAKE: identity or capabilities failed.');
      return reply;
    }
    exchange(wire, {dryRun = false} = {}) {
      if (!this.#connected) throw new Error('NOT_CONNECTED: connect to a simulated endpoint first.');
      this.#log('TX', typeof wire === 'string' ? wire.slice(0,1024) : '<non-string>', dryRun);
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
      ctx.font='bold 18px monospace'; ctx.fillStyle='#eef3f4'; ctx.fillText('VLAB-P2',29,frame.height-26);
      return {width:frame.width,height:frame.height,pixels:ctx.getImageData(0,0,frame.width,frame.height).data};
    }
    diagnostics() { return this.#plant.diagnostics(); }
  }
  global.SimulatedDeviceLink = SimulatedDeviceLink;
})(globalThis);
