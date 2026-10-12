(function (global) {
  'use strict';
  const validXY = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 0.100000000001);
  const validAuxiliary = value => value && !Array.isArray(value) && typeof value === 'object' &&
    ((value.op === 'lift' && ['up','down'].includes(value.position) && Object.keys(value).sort().join(',') === 'op,position') ||
     (value.op === 'grip' && ['open','closed'].includes(value.state) && Object.keys(value).sort().join(',') === 'op,state'));
  const validCommand = value => (validXY(value) && value.every(v=>Math.abs(v)<=0.1)) || validAuxiliary(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const same = (a,b) => Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v,i) => Math.abs(v-b[i]) <= 1e-10)
    : validAuxiliary(a) && validAuxiliary(b) && a.op === b.op && a.position === b.position && a.state === b.state;
  const hash = value => { let result=2166136261; for(let i=0;i<value.length;i++) result=Math.imul(result^value.charCodeAt(i),16777619); return 'fnv1a-'+(result>>>0).toString(16).padStart(8,'0'); };
  const WORKER_SOURCE = `
    'use strict';
    const send = self.postMessage.bind(self);
    let used = false;
    self.onmessage = async event => {
      if (used) return;
      used = true;
      try {
        const {source,operation,payload} = event.data;
        const required = event.data.required === 'controller' ? ['control'] : ['encode','decode'];
        const factory = new Function('"use strict";\\n' + source + '\\n;return {encode:typeof encode==="function"?encode:null,decode:typeof decode==="function"?decode:null,control:typeof control==="function"?control:null};');
        const driver = factory();
        if (required.some(name => !driver[name])) throw new Error(required[0] === 'control' ? 'Source must define control(state).' : 'Source must define encode(command) and decode(rawReply).');
        if (operation !== 'compile' && !required.includes(operation)) throw new Error('Unsupported module operation.');
        const result = operation === 'compile' ? {functions:required} : await driver[operation](payload);
        send({type:'result',ok:true,result});
      } catch(error) { send({type:'result',ok:false,error:String(error && error.message || 'Driver error').slice(0,300)}); }
    };
    // No generated source has been delivered when this trusted bootstrap runs.
    send({type:'ready'});
  `;

  function brokerDocument(token) {
    const workerLiteral = JSON.stringify(WORKER_SOURCE).replace(/</g,'\\u003c');
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'"><script>
      'use strict';
      const token=${JSON.stringify(token)}, workers=new Map(), source=${workerLiteral};
      function reply(id,payload){parent.postMessage({driverSandbox:token,id,...payload},'*');}
      function release(id,item){if(workers.get(id)!==item)return false;workers.delete(id);item.worker.terminate();URL.revokeObjectURL(item.url);return true;}
      addEventListener('message',event=>{
        if(event.source!==parent || !event.data || event.data.driverSandbox!==token) return;
        const msg=event.data;
        if(msg.type==='cancel'){const item=workers.get(msg.id);if(item)release(msg.id,item);return;}
        if(msg.type==='execute'){
          const item=workers.get(msg.id);
          if(!item||item.phase!=='ready')return;
          item.phase='execution';
          try{item.worker.postMessage({source:msg.source,operation:msg.operation,payload:msg.payload,required:msg.required});}
          catch(error){if(release(msg.id,item))reply(msg.id,{error:String(error.message||'Worker dispatch failed').slice(0,300)});}
          return;
        }
        if(msg.type!=='call')return;
        if(workers.has(msg.id))return;
        let url,worker;
        try {
          url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
          worker=new Worker(url);
          const item={worker,url,phase:'startup'};
          workers.set(msg.id,item);
          const finish=payload=>{if(release(msg.id,item))reply(msg.id,payload);};
          worker.onmessage=e=>{
            if(workers.get(msg.id)!==item)return;
            if(item.phase==='startup'&&e.data?.type==='ready'){
              item.phase='ready';reply(msg.id,{phase:'worker-ready'});return;
            }
            if(item.phase==='execution'&&e.data?.type==='result')finish({result:e.data});
          };
          worker.onerror=e=>{e.preventDefault();finish({error:String(e.message||'Worker failed').slice(0,300)});};
        }catch(error){workers.delete(msg.id);if(worker)worker.terminate();if(url)URL.revokeObjectURL(url);reply(msg.id,{error:String(error.message||'Worker creation failed').slice(0,300)});}
      });
      parent.postMessage({driverSandbox:token,ready:true},'*');
    <\/script>`;
  }

  class DriverRuntime {
    #frame = null; #token; #pending = new Map(); #sequence = 0; #ready; #source = ''; #sourceHash = null;
    #passed = false; #link = null; #disposed = false; #handler; #timeout; #startupTimeout; #tests = null;
    #readyTimer = null; #rejectReady = null; #kind = 'driver';
    #stats = {requests:0,retries:0,failures:0,programErrors:0,recent:[]};
    // kind 'driver' hosts encode/decode; kind 'controller' hosts a stateless
    // generated control(state) module in the same isolation and time limits.
    constructor({timeoutMs=5000,startupTimeoutMs=5000,kind='driver'} = {}) {
      if(!['driver','controller'].includes(kind))throw new Error('Unknown isolated module kind.');
      this.#kind=kind;
      // Fresh workers preserve stateless generated-code isolation. These are
      // separate wall-clock WAIT limits, not measured generated-code CPU time.
      this.#timeout = Math.max(80,Math.min(10000,Number(timeoutMs)||5000));
      this.#startupTimeout = Math.max(80,Math.min(10000,Number(startupTimeoutMs)||5000));
      this.#token = 'driver-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16)).join('-');
      this.#ready = new Promise((resolve,reject)=>{
        this.#rejectReady=reject;
        const started=this.#now();
        this.#readyTimer=setTimeout(()=>{
          const diagnostic={operation:'initialize',phase:'isolation',requestId:0,attempt:1,elapsedMs:Math.max(0,this.#now()-started),deadlineMs:this.#startupTimeout,retryable:false,retryCount:0};
          const error=this.#error('DRIVER_ISOLATION_TIMEOUT','Waiting for the isolated driver environment timed out.',diagnostic);
          this.#record({...diagnostic,status:'error',code:error.code});
          reject(error);
        },this.#startupTimeout);
        this.#handler=event=>{
          if(this.#disposed||event.source!==this.#frame?.contentWindow || event.data?.driverSandbox!==this.#token)return;
          if(event.data.ready){clearTimeout(this.#readyTimer);this.#readyTimer=null;this.#rejectReady=null;resolve();return;}
          const item=this.#pending.get(event.data.id);
          if(!item)return;
          if(event.data.phase==='worker-ready'){
            if(item.phase!=='startup')return;
            clearTimeout(item.timer);item.startupElapsedMs=Math.max(0,this.#now()-item.started);
            item.phase='execution';item.phaseStarted=this.#now();
            item.timer=setTimeout(()=>this.#expire(item),this.#timeout);
            try{this.#frame.contentWindow.postMessage({driverSandbox:this.#token,type:'execute',id:item.id,operation:item.operation,payload:item.payload,source:item.source,required:this.#kind},'*');}
            catch(error){this.#finish(item,'DRIVER_RUNTIME_ERROR',String(error.message||'Worker dispatch failed').slice(0,300));}
            return;
          }
          if(event.data.error){this.#finish(item,'DRIVER_RUNTIME_ERROR',String(event.data.error).slice(0,300));return;}
          if(item.phase!=='execution')return;
          if(!event.data.result||event.data.result.type!=='result'||typeof event.data.result.ok!=='boolean')this.#finish(item,'DRIVER_RUNTIME_ERROR','Malformed driver result.');
          else if(event.data.result.ok!==true)this.#finish(item,'DRIVER_PROGRAM_ERROR',String(event.data.result.error||'Generated driver rejected the input.').slice(0,300));
          else this.#finish(item,null,null,event.data.result.result);
        };
        addEventListener('message',this.#handler);
        this.#frame=document.createElement('iframe');
        this.#frame.setAttribute('sandbox','allow-scripts');
        this.#frame.setAttribute('aria-hidden','true');
        this.#frame.hidden=true;
        this.#frame.title='Isolated generated driver runtime';
        this.#frame.srcdoc=brokerDocument(this.#token);
        (document.body||document.documentElement).append(this.#frame);
      });
      // Avoid unhandled rejections if a caller disposes before first compile.
      this.#ready.catch(()=>{});
    }
    #now(){return typeof performance!=='undefined'?performance.now():Date.now();}
    #error(code,message,diagnostic){const error=new Error(code+': '+message);error.code=code;error.diagnostic=copy(diagnostic);return error;}
    #record(entry){
      if(entry.status==='error'){if(entry.code==='DRIVER_PROGRAM_ERROR')this.#stats.programErrors++;else this.#stats.failures++;}
      this.#stats.recent.push(copy(entry));if(this.#stats.recent.length>40)this.#stats.recent.shift();
    }
    #diagnostic(item,retryable=false){return {operation:item.operation,phase:item.phase,requestId:item.id,attempt:item.attempt,elapsedMs:Math.max(0,this.#now()-item.phaseStarted),totalElapsedMs:Math.max(0,this.#now()-item.started),startupElapsedMs:item.startupElapsedMs??null,deadlineMs:item.phase==='startup'?this.#startupTimeout:this.#timeout,retryable,retryCount:item.attempt-1};}
    #finish(item,code,message,result,retryable=false){
      if(this.#pending.get(item.id)!==item)return;
      clearTimeout(item.timer);this.#pending.delete(item.id);
      const diagnostic=this.#diagnostic(item,retryable);
      // Cancellation is idempotent and never dispatches a physical command.
      try{this.#frame?.contentWindow?.postMessage({driverSandbox:this.#token,type:'cancel',id:item.id},'*');}catch{}
      this.#record({...diagnostic,status:code?'error':'success',code:code||null});
      if(code)item.reject(this.#error(code,message,diagnostic));else item.resolve(result);
    }
    #expire(item){
      const startup=item.phase==='startup',retryable=startup&&item.operation==='encode'&&item.attempt===1&&!this.#disposed;
      this.#finish(item,startup?'DRIVER_STARTUP_TIMEOUT':'DRIVER_EXECUTION_TIMEOUT',startup?'Waiting for the isolated worker to become ready timed out; generated source was not sent.':'Waiting for the generated driver result timed out; worker cancellation was requested.',null,retryable);
    }
    async #request(operation,payload,source=this.#source) {
      if(this.#disposed)throw this.#error('DRIVER_DISPOSED','Driver runtime disposed.',{operation,phase:'isolation',requestId:0,attempt:1,elapsedMs:0,deadlineMs:0,retryable:false,retryCount:0});
      await this.#ready;
      for(let attempt=1;attempt<=2;attempt++){
        if(this.#disposed)throw this.#error('DRIVER_DISPOSED','Driver runtime disposed.',{operation,phase:'isolation',requestId:0,attempt,elapsedMs:0,deadlineMs:0,retryable:false,retryCount:attempt-1});
        try{return await this.#attempt(operation,payload,source,attempt);}
        catch(error){
          if(operation!=='encode'||attempt!==1||error.code!=='DRIVER_STARTUP_TIMEOUT'||!error.diagnostic?.retryable||this.#disposed)throw error;
          this.#stats.retries++;
        }
      }
    }
    #attempt(operation,payload,source,attempt){
      return new Promise((resolve,reject)=>{
        const id=++this.#sequence,started=this.#now(),item={id,operation,payload,source,attempt,phase:'startup',started,phaseStarted:started,resolve,reject,timer:null};
        this.#stats.requests++;this.#pending.set(id,item);
        item.timer=setTimeout(()=>this.#expire(item),this.#startupTimeout);
        try{this.#frame.contentWindow.postMessage({driverSandbox:this.#token,type:'call',id,operation},'*');}
        catch(error){this.#finish(item,'DRIVER_RUNTIME_ERROR',String(error.message||'Worker startup dispatch failed').slice(0,300));}
      });
    }
    async compile(source) {
      this.#passed=false;this.#link=null;this.#tests=null;this.#source='';this.#sourceHash=null;
      if(typeof source!=='string' || source.length<1 || source.length>30000)throw new Error('Driver source must contain 1–30000 characters.');
      await this.#request('compile',null,source);
      this.#source=source;this.#sourceHash=hash(source);
      return {ok:true,sourceHash:this.#sourceHash,isolation:'opaque-sandbox-iframe/terminable-worker',network:'CSP connect-src none',functions:this.#kind==='controller'?['control']:['encode','decode']};
    }
    // Generated controller call: pure computation, no link access.
    async control(state) {
      if(this.#kind!=='controller')throw new Error('control() is only available in a controller runtime.');
      if(!this.#source)throw new Error('Compile the controller first.');
      return this.#request('control',copy(state));
    }
    #profile(link) {
      // The host verifies frames with a trusted profile chosen by the open
      // connection, never by anything the generated driver reports.
      const name=link?.protocol;
      if(!global.VlabProtocols)throw new Error('PROTOCOL: host protocol profiles are unavailable.');
      return global.VlabProtocols.get(name);
    }
    async #encode(command, profile) {
      if(!validCommand(command))throw new Error('COMMAND_LIMIT: expected two bounded XY inputs or a valid lift/grip command.');
      if(!this.#source)throw new Error('Compile the driver first.');
      const wire=await this.#request('encode',copy(command));
      if(typeof wire!=='string' || wire.length>profile.maxWire)throw new Error(`DRIVER_FRAME: encode must return one ${profile.family} frame string.`);
      let packet;
      try{packet=profile.commandFromWire(wire);}catch(error){throw new Error('DRIVER_FRAME: '+String(error.message||'invalid frame').slice(0,200));}
      if(!same(packet,command))throw new Error('DRIVER_COMMAND: encoded command must exactly match the bounded requested command.');
      return wire;
    }
    #validateReply(rawReply, command, profile) {
      let raw;
      try{raw=profile.parseReply(rawReply);}catch(error){throw new Error('ACK_FRAME: '+String(error.message||'invalid acknowledgement').slice(0,200));}
      if(raw?.ok!==true || !(validXY(raw.accepted)||validAuxiliary(raw.accepted)) || typeof raw.limited!=='boolean')throw new Error('ACK_REJECTED: '+String(raw?.error||'invalid acknowledgement').slice(0,160));
      if(command && Array.isArray(command) && (!Array.isArray(raw.accepted) || raw.accepted.some((v,i)=>Math.abs(v)>Math.abs(command[i])+1e-10 || (v*command[i]<-1e-12))))throw new Error('ACK_MISMATCH: applied movement exceeds or reverses the command.');
      if(command && !Array.isArray(command) && !same(raw.accepted,command))throw new Error('ACK_MISMATCH: auxiliary acknowledgement differs from command.');
      if(command && !raw.limited && !same(raw.accepted,command))throw new Error('ACK_MISMATCH: unlimited acknowledgement differs from command.');
      return raw;
    }
    async #decode(rawReply, command, profile) {
      const raw=this.#validateReply(rawReply,command,profile);
      const decoded=await this.#request('decode',rawReply);
      if(!decoded || !(validXY(decoded.applied)||validAuxiliary(decoded.applied)) || !same(decoded.applied,raw.accepted) || decoded.limited!==raw.limited)throw new Error('DRIVER_ACK: decode disagrees with the device acknowledgement.');
      return {applied:copy(decoded.applied),limited:decoded.limited};
    }
    async test(link) {
      if(this.#kind!=='driver')throw new Error('Device driver tests require a driver runtime.');
      this.#passed=false;this.#link=null;
      if(!this.#source)throw new Error('Compile the driver first.');
      if(!link?.ready)throw new Error('Complete the device handshake before testing the driver.');
      const profile=this.#profile(link),fixtures=profile.fixtures,tests=[];
      const check=async(name,operation)=>{try{await operation();tests.push({name,passed:true,detail:'通過；未使設備動作。'});}catch(error){tests.push({name,passed:false,detail:String(error.message).slice(0,300),driverErrorCode:error.code||null,driverDiagnostic:error.diagnostic?copy(error.diagnostic):null});}};
      await check('雙通道、零值與上下限的編碼及回覆往返',async()=>{
        for(const command of [[0.02,0],[0,-0.025],[0,0],[0.1,-0.1]]){
          const wire=await this.#encode(command,profile),reply=await link.exchange(wire,{dryRun:true});
          const result=await this.#decode(reply,command,profile);
          if(!same(result.applied,command)||result.limited)throw new Error('Dry-run round trip differs from the request.');
        }
      });
      await check('升降與夾爪四種命令的實際編解碼',async()=>{
        for(const command of [{op:'lift',position:'up'},{op:'lift',position:'down'},{op:'grip',state:'open'},{op:'grip',state:'closed'}]) {
          const wire=await this.#encode(command,profile),reply=await link.exchange(wire,{dryRun:true});
          const result=await this.#decode(reply,command,profile);
          if(!same(result.applied,command)||result.limited)throw new Error('Auxiliary dry-run round trip differs from the request.');
        }
      });
      await check('設備受限回覆的解析',async()=>{await this.#decode(fixtures.limited.reply,fixtures.limited.command,profile);});
      await check('驅動程式拒絕失敗或毀損回覆',async()=>{
        for(const raw of fixtures.malformedReplies){
          let rejected=false;try{await this.#request('decode',raw);}catch(error){if(error.code!=='DRIVER_PROGRAM_ERROR')throw error;rejected=true;}
          if(!rejected)throw new Error('decode must reject malformed/error device replies.');
        }
      });
      await check('主機側限制阻擋超量及非有限輸入',async()=>{
        for(const command of [[0.11,0],[NaN,0],[0,Infinity],[0],{op:'lift',position:'sideways'},{op:'grip',state:'closed',extra:1}]){
          let rejected=false;try{await this.#encode(command,profile);}catch{rejected=true;}
          if(!rejected)throw new Error('Unbounded command passed host validation.');
        }
      });
      await check('設備側限制與框架檢查',async()=>{
        for(const wire of fixtures.invalidFrames){
          const response=profile.parseReply(await link.exchange(wire,{dryRun:true}));
          if(response.ok!==false)throw new Error('Device accepted invalid wire frame.');
        }
      });
      this.#passed=tests.every(test=>test.passed);this.#link=this.#passed?link:null;
      this.#tests={passed:this.#passed,tests,sourceHash:this.#sourceHash,protocol:profile.name,dryRun:true,isolation:'opaque sandbox iframe + terminable worker',network:'CSP connect-src none'};
      return JSON.parse(JSON.stringify(this.#tests));
    }
    async act(command,link) {
      if(this.#kind!=='driver'){const error=new Error('DRIVER_NOT_VALIDATED: a controller runtime cannot send device commands.');error.code='DRIVER_NOT_VALIDATED';error.wireSent=false;throw error;}
      const sourceHash=this.#sourceHash;
      const ensureReady=()=>{
        let code,message;
        if(this.#disposed){code='DRIVER_DISPOSED';message='Driver runtime disposed; no command was sent.';}
        else if(!this.#passed||this.#link!==link||this.#sourceHash!==sourceHash){code='DRIVER_NOT_VALIDATED';message='This driver must pass dry-run tests on this connection before movement.';}
        else if(!link.ready){code='DEVICE_NOT_READY';message='Device connection is not ready.';}
        if(code){const error=new Error(code+': '+message);error.code=code;error.wireSent=false;throw error;}
      };
      ensureReady();
      const profile=this.#profile(link);
      // Fixed-point devices accept only their stated resolution. The host
      // quantizes before encoding so the generated frame and ACK must match exactly.
      command=global.VlabProtocols.quantize(command,profile);
      const wire=await this.#encode(command,profile);
      // Disposal or revalidation may occur while pure encoding awaits a worker.
      // Recheck immediately before exchange; never discard an ACK after sending.
      ensureReady();
      const reply=await link.exchange(wire,{dryRun:false});
      let raw;
      try { raw=this.#validateReply(reply,command,profile); }
      catch(error) {
        this.#passed=false;
        error.wireSent=true;error.command=copy(command);error.wire=wire;error.reply=reply;
        throw error;
      }
      try {
        const acknowledgement=await this.#decode(reply,command,profile);
        return {...acknowledgement,wire,reply,sourceHash:this.#sourceHash};
      } catch(error) {
        // The physical command has already executed. Do not erase that motion
        // merely because generated decoding failed. Supply the independently
        // validated device ACK only for recording/observation, invalidate this
        // driver, and require the engine to stop with this explicit failure.
        this.#passed=false;
        return {applied:copy(raw.accepted),limited:raw.limited,wire,reply,sourceHash:this.#sourceHash,
          driverError:String(error.message||'Generated decoder failed').slice(0,300),
          driverErrorCode:'DRIVER_DECODE_AFTER_MOVEMENT',driverDiagnostic:error.diagnostic?copy(error.diagnostic):null};
      }
    }
    async operate(command,link) {
      if(!validAuxiliary(command))throw new Error('COMMAND_LIMIT: operate requires a lift or grip command.');
      return this.act(command,link);
    }
    get sourceHash(){return this.#sourceHash;}
    get passed(){return this.#passed;}
    get diagnostics(){return copy(this.#stats);}
    dispose() {
      if(this.#disposed)return;
      this.#disposed=true;this.#passed=false;this.#link=null;
      clearTimeout(this.#readyTimer);this.#readyTimer=null;
      this.#rejectReady?.(this.#error('DRIVER_DISPOSED','Driver runtime disposed.',{operation:'initialize',phase:'isolation',requestId:0,attempt:1,elapsedMs:0,deadlineMs:0,retryable:false,retryCount:0}));this.#rejectReady=null;
      for(const item of this.#pending.values())this.#finish(item,'DRIVER_DISPOSED','Driver runtime disposed.');
      this.#pending.clear();removeEventListener('message',this.#handler);this.#frame?.remove();this.#frame=null;
    }
  }
  global.DriverRuntime=DriverRuntime;
})(globalThis);
