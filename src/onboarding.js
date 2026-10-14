(function(global){
  'use strict';
  const copy=x=>x==null?x:JSON.parse(JSON.stringify(x));
  const TOOLS=['inspect_device','list_interfaces','read_manual','connect','handshake','write_driver','test_driver','write_controller','test_controller','start_control','stop'];
  // Isolation/worker startup failures mean the generated source never reached
  // the sandbox, so repeating the same tool cannot help; stop and classify as
  // a local runtime environment failure instead of spending model calls.
  const RUNTIME_ENVIRONMENT_CODES=['DRIVER_STARTUP_TIMEOUT','DRIVER_ISOLATION_TIMEOUT'],RUNTIME_ENVIRONMENT_LIMIT=3;
  const RUNTIME_TOOLS=['write_driver','test_driver','write_controller','test_controller'];
  function browserEnvironment(){
    const nav=typeof navigator!=='undefined'?navigator:null,doc=typeof document!=='undefined'?document:null;
    const brands=nav?.userAgentData?.brands;
    return {userAgent:nav?String(nav.userAgent||'').slice(0,300):null,brands:Array.isArray(brands)?brands.map(b=>`${b.brand} ${b.version}`).slice(0,6):null,
      platform:nav?String(nav.userAgentData?.platform||nav.platform||'').slice(0,60):null,hardwareConcurrency:Number(nav?.hardwareConcurrency)||null,
      pageProtocol:typeof location!=='undefined'?String(location.protocol||''):null,visibilityState:doc?.visibilityState||null,hasFocus:typeof doc?.hasFocus==='function'?doc.hasFocus():null,
      crossOriginIsolated:typeof crossOriginIsolated==='boolean'?crossOriginIsolated:null};
  }
  const LABELS={inspect_device:'觀察設備與提出規格假設',list_interfaces:'列出可用通訊介面',read_manual:'查閱模擬設備手冊',connect:'建立通訊連線',handshake:'確認設備身分與能力',write_driver:'撰寫與編譯通訊驅動',test_driver:'測試通訊驅動',write_controller:'撰寫與編譯 XY 控制程式',test_controller:'隔離測試 XY 控制程式',start_control:'啟用視覺控制',stop:'停止實驗'};
  // Simulated host manual library. The experiment chooses one physical model;
  // the agent must still pick the matching document from the camera nameplate.
  const DOCUMENTS=['VLAB-P2','VLAB-G3'];
  const DEVICE_PRESETS={'VLAB-P2':{kinematics:'2r',deviceClass:'平面雙連桿手臂'},'VLAB-G3':{kinematics:'gantry',deviceClass:'雙軸直角座標龍門'}};
  const CONTROLLER_MODES=['builtin','generated'];
  const USAGE=['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens','promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','cachedContentTokenCount'];
  function validateFrontDecision(value,allowed){
    if(!value||!TOOLS.includes(value.tool)||!allowed.includes(value.tool)||!value.args||typeof value.args!=='object'||Array.isArray(value.args))throw new Error('工具不在目前允許清單，或參數格式不正確。');
    const d={tool:value.tool,args:copy(value.args),reason:String(value.reason||'').slice(0,600),expected:String(value.expected||'').slice(0,400),expectedProvided:Boolean(value.expectedProvided!==false&&typeof value.expected==='string'&&value.expected.trim()),source:['claude','gemini'].includes(value.source)?value.source:'adaptive'};
    if(['claude','gemini'].includes(d.source)){d.model=String(value.model||'').slice(0,120);d.usage={};for(const k of USAGE)if(Number.isFinite(value.usage?.[k]))d.usage[k]=value.usage[k];}
    const a=d.args,fields={inspect_device:['deviceClass','visibleAxes','modelLabel','uncertainties'],read_manual:['documentId'],connect:['endpointId','transport','baudRate','protocol'],write_driver:['source'],write_controller:['source']}[d.tool]||[];
    if(Object.keys(a).some(k=>!fields.includes(k)))throw new Error('工具包含未定義的參數。');
    if(d.tool==='inspect_device'){
      if(!Number.isInteger(a.visibleAxes)||a.visibleAxes<0||a.visibleAxes>12||['deviceClass','modelLabel','uncertainties'].some(k=>typeof a[k]!=='string'||a[k].length>1200))throw new Error('外觀假設格式不正確。');
    }
    if(d.tool==='read_manual'&&!DOCUMENTS.includes(a.documentId))throw new Error('模擬手冊庫只有 '+DOCUMENTS.join('、')+'。');
    if(d.tool==='connect'&&(typeof a.endpointId!=='string'||!['serial','tcp'].includes(a.transport)||!Number.isFinite(a.baudRate)||typeof a.protocol!=='string'))throw new Error('通訊參數格式不正確。');
    if(['write_driver','write_controller'].includes(d.tool)&&(typeof a.source!=='string'||!a.source.trim()||a.source.length>30000))throw new Error('控制程式須為 1 至 30,000 字元的 JavaScript。');
    return d;
  }
  class FullExperimentEngine {
    constructor({seed=42,strategy='adaptive',provider=null,challenge=true,recordFrames=true,maxActions=180,maxDecisions=300,maxFrontDecisions=40,controlFactory=null,device='VLAB-P2',manualTemplate=true,controllerMode='builtin'}={}){
      if(!['adaptive','claude','gemini','baseline'].includes(strategy))throw new Error('完整流程支援離線策略、Claude 或 Gemini。');
      Object.assign(this,{seed:Number(seed)>>>0,strategy,provider,challenge:Boolean(challenge),recordFrames:Boolean(recordFrames),maxActions,maxDecisions,maxFrontDecisions,controlFactory});
      this._setExperimentOptions({device,manualTemplate,controllerMode});
      this._state=null;this._history=[];this._events=[];this._truth=[];this._busy=false;this._disposed=false;this._epoch=0;this._control=null;this._runtime=null;
    }
    _setExperimentOptions({device=this.device,manualTemplate=this.manualTemplate,controllerMode=this.controllerMode}={}){
      if(!DEVICE_PRESETS[device])throw new Error('未知的模擬設備型號。');
      if(!CONTROLLER_MODES.includes(controllerMode))throw new Error('XY 控制模式必須是 builtin 或 generated。');
      this.device=device;this.manualTemplate=manualTemplate!==false;this.controllerMode=controllerMode;
    }
    get historyLength(){return this._history.length;}
    async initialize(){return this._state?this.snapshot():this.reset(this.seed);}
    async reset(seed=this.seed,options={}){
      this._epoch++;this.provider?.abort?.();this._control?.dispose();this._runtime?.dispose();this._controllerRuntime?.dispose();
      this._setExperimentOptions({device:options.device??this.device,manualTemplate:options.manualTemplate??this.manualTemplate,controllerMode:options.controllerMode??this.controllerMode});
      if(options.strategy){if(!['adaptive','claude','gemini','baseline'].includes(options.strategy))throw new Error('完整流程支援離線策略、Claude 或 Gemini。');this.strategy=options.strategy;}
      if('provider'in options)this.provider=options.provider;if('challenge'in options)this.challenge=Boolean(options.challenge);
      if(['claude','gemini'].includes(this.strategy)&&!this.provider)throw new Error('請先設定所選供應商的模型與連線。');
      this.seed=Number(seed)>>>0;this._disposed=false;this._busy=false;this._control=null;this._proposal=null;
      this._plant=new VirtualPlant({seed:this.seed,width:640,height:480,kinematics:DEVICE_PRESETS[this.device].kinematics});
      this._link=new SimulatedDeviceLink({plant:this._plant,seed:this.seed,model:this.device,includeTemplate:this.manualTemplate});this._runtime=new DriverRuntime();
      this._controllerRuntime=this.controllerMode==='generated'?new DriverRuntime({kind:'controller'}):null;
      this._history=[];this._events=[];this._truth=[];this._frontDecisions=0;this._runtimeEnvironmentFailures=0;this._visibility=[];this._frontCalls=0;this._controlCalls=0;this._decisionRecovery=new VlabDecisionRecovery();
      this._completed=new Set();this._lastResult=null;this._controlOffset=null;
      if(!this._visibilityHandler&&typeof document!=='undefined'&&typeof document.addEventListener==='function'){
        this._visibilityHandler=()=>{this._visibility.push({state:document.visibilityState,frontDecisions:this._frontDecisions,modelCalls:this._frontCalls+this._controlCalls,driverRequests:Number(this._runtime?.diagnostics?.requests)||0});if(this._visibility.length>40)this._visibility.shift();};
        document.addEventListener('visibilitychange',this._visibilityHandler);
      }
      this._onboarding={phase:'inspect_device',status:'idle',hypothesis:null,inventory:null,manual:null,connection:null,handshake:null,driverSource:null,driverTests:null,compileResult:null,traffic:[],ready:false,steps:[],completed:[],
        device:this.device,manualTemplate:this.manualTemplate,controllerMode:this.controllerMode,controllerSource:null,controllerCompile:null,controllerTests:null,controllerSourceOrigin:null,sourceLabel:['claude','gemini'].includes(this.strategy)?`${this.strategy==='gemini'?'Gemini':'Claude'} 依影像與工具回覆選擇步驟`:`離線規則策略；外觀判讀使用預設規則，驅動${this.manualTemplate?'採用手冊範本':'由規則式規格產生器產生'}${this.controllerMode==='generated'?'，XY 控制使用預寫參考模組':''}`};
      this._pngCache=new WeakMap();this._pngCanvas=document.createElement('canvas');this._pngContext=this._pngCanvas.getContext('2d');
      this._configureInitialScenario?.();
      return this._emit({kind:'intro',title:'先認識設備、建立連線，再讓它動',explanation:'目前沒有通訊連線，也沒有已通過測試的控制程式。先區分影像假設、手冊規格與握手確認；所有步驟都會留下實際工具結果。這裡使用模擬設備與模擬主機介面。',nextLabel:'下一步：選擇第一個工具'});
    }
    _traffic(){return typeof this._link?.traffic==='function'?this._link.traffic():[];}
    _frontState(){return {...copy(this._onboarding),traffic:copy(this._traffic()),completed:[...this._completed]};}
    _allowed(){
      const c=this._completed,tools=['inspect_device','list_interfaces','read_manual','stop'];
      if(c.has('list_interfaces')&&c.has('read_manual'))tools.push('connect');
      if(this._onboarding.connection)tools.push('handshake');
      if(this._onboarding.handshake?.ok&&c.has('read_manual'))tools.push('write_driver');
      if(this._onboarding.compileResult?.ok&&this._onboarding.handshake?.ok)tools.push('test_driver');
      const o=this._onboarding,generated=this.controllerMode==='generated';
      if(generated&&o.driverTests?.passed&&o.handshake?.ok)tools.push('write_controller');
      if(generated&&o.controllerCompile?.ok&&o.driverTests?.passed)tools.push('test_controller');
      if(o.driverTests?.passed&&o.handshake?.ok&&c.has('inspect_device')&&(!generated||o.controllerTests?.passed))tools.push('start_control');
      return tools;
    }
    _context(){
      const o=this._onboarding;
      return this._decisionRecovery.context({phase:'onboarding',scope:'simulated-device',allowedTools:this._allowed(),hypothesis:copy(o.hypothesis),inventory:copy(o.inventory),manual:copy(o.manual),connection:copy(o.connection),handshake:copy(o.handshake),driverSource:o.driverSource,driverTests:copy(o.driverTests),
        ...(this.controllerMode==='generated'?{controllerMode:'generated',controllerContract:VlabControllerModule.CONTRACT,controllerSource:o.controllerSource,controllerTests:copy(o.controllerTests)}:{}),traffic:copy(this._traffic().slice(-12)),completed:[...this._completed],lastResult:copy(this._lastResult),budgets:{decisionsUsed:this._frontDecisions,maxDecisions:this.maxFrontDecisions}});
    }
    _offlineDecision(){
      const c=this._completed,o=this._onboarding;
      const d=(tool,args,reason,expected)=>({tool,args,reason,expected,source:'adaptive'});
      if(!c.has('inspect_device'))return d('inspect_device',{deviceClass:DEVICE_PRESETS[this.device].deviceClass,visibleAxes:2,modelLabel:this.device,uncertainties:'此為離線範本假設；尚未從手冊或握手確認。外觀無法確認連桿長度、減速比、通訊設定或運動增益。'},'離線展示使用預設外觀判讀；先留下可被後續證據修正的假設。','區分可見外觀與尚待查證的規格。');
      if(!c.has('list_interfaces'))return d('list_interfaces',{},'需要取得模擬主機提供的介面清單，才能選擇連線位置。','取得觀察到的端點資訊；不掃描這台電腦。');
      if(!c.has('read_manual'))return d('read_manual',{documentId:o.hypothesis?.modelLabel||this.device},'依設備標籤查閱這個模擬設備的文件，取得正確通訊格式。','確認通道數、傳輸設定與封包格式；仍不知道運動映射。');
      if(!o.connection){
        const profile=o.manual.connection,endpoint=o.inventory.find(x=>x.deviceModel===o.manual.model&&x.transport===profile.transport);
        if(!endpoint)return d('stop',{},'觀察到的端點清單找不到符合手冊的設備。','不猜測連線位置，保留缺失證據。');
        return d('connect',{endpointId:endpoint.endpointId,transport:profile.transport,baudRate:profile.baudRate,protocol:profile.protocol},'以實際介面清單的型號與手冊傳輸設定配對。','打開相符的模擬連線；不送出動作。');
      }
      if(!o.handshake?.ok)return d('handshake',{},'連線建立不代表已接到正確手臂；需要交換身分與能力封包。','確認型號、協定版本與可用通道。');
      if(!o.compileResult?.ok||o.driverTests?.passed===false){
        const template=o.manual.sampleDriverSource||o.manual.sampleDriver;
        if(template)return d('write_driver',{source:template},'離線策略使用手冊提供的 JavaScript 範本，在隔離執行環境中編譯。','得到可編碼命令與解碼回覆的程式；尚不啟用動作。');
        let source;try{source=VlabDriverSynthesizer.fromSpec(o.manual.protocolSpec);}catch(error){return d('stop',{},'手冊沒有範本，離線規格產生器也無法處理這份 protocolSpec：'+String(error.message||error).slice(0,160),'停止並保留缺少的規格證據。');}
        return d('write_driver',{source},'手冊沒有驅動範本；離線規格產生器依 protocolSpec 產生 encode/decode（規則式程式產生，非語言模型）。','得到可編碼命令與解碼回覆的程式；仍須通過乾跑測試。');
      }
      if(!o.driverTests?.passed)return d('test_driver',{},'程式已編譯，仍須驗證封包、回覆、限制與錯誤處理。','以不移動設備的測試確認驅動程式可用。');
      if(this.controllerMode==='generated'&&!o.controllerTests?.passed){
        if(!o.controllerCompile?.ok||o.controllerTests?.passed===false)return d('write_controller',{source:VlabControllerModule.REFERENCE_SOURCE},'離線策略提交預寫的參考 XY 控制模組（非語言模型產生），經同一隔離與測試流程。','編譯成 control(state) 模組；尚未用於設備。');
        return d('test_controller',{},'控制模組已編譯；先在合成設備上做隔離測試，通過後才能控制模擬設備。','確認旋轉、交換、反向、非線性、行程限制與中途反向皆能到達。');
      }
      return d('start_control',{},'外觀假設、介面、手冊、握手與驅動測試均已具備，現在可啟用受限動作。','後續每個動作都由剛才編譯與測試的程式送到模擬設備。');
    }
    _png(frame){
      if(!frame||!this.recordFrames)return null;if(frame.dataURL)return frame;
      let result=this._pngCache.get(frame);if(result)return result;
      this._pngCanvas.width=frame.width;this._pngCanvas.height=frame.height;this._pngContext.putImageData(new ImageData(frame.pixels,frame.width,frame.height),0,0);
      result={width:frame.width,height:frame.height,dataURL:this._pngCanvas.toDataURL('image/png')};this._pngCache.set(frame,result);return result;
    }
    _emit(fields={}){
      const frame=fields.frame||this._link.frame(),onboarding=this._frontState();
      const defaults={seed:this.seed,strategy:this.strategy,stage:'onboarding',kind:'onboarding-result',title:'',explanation:'',nextLabel:'下一步：請代理選擇工具',done:false,failure:null,actionCount:0,commandAttemptCount:0,unconfirmedActuationCount:0,probeCount:0,recalibrations:0,decisionCount:this._frontDecisions,modelCalls:this._frontCalls+this._controlCalls,observation:null,jacobian:null,decision:null,command:null,predicted:null,residual:null,predictionThreshold:null,applied:null,limited:null,beforeTip:null,afterTip:null,frame,beforeFrame:null,diagnostics:this._plant.diagnostics(),checkpoints:{firstReach:null,changed:false,mismatchSeen:false,recovered:null},agentContext:this._context(),toolResult:null,policyStatus:this._proposal?'execute':'decide'};
      const runtime=this._runtime?.diagnostics;
      const driverRuntime=runtime?{requests:runtime.requests,retries:runtime.retries,failures:runtime.failures,programErrors:runtime.programErrors,last:copy(runtime.recent.at(-1)||null)}:null;
      const requests=this.provider?.requestDiagnostics;
      const modelRuntime=requests?{minIntervalMs:requests.minIntervalMs,requests:requests.requests,rateLimitRetries:requests.rateLimitRetries,waitMs:requests.waitMs,last:copy(requests.recent.at(-1)||null)}:null;
      const state={...defaults,...fields,onboarding,driverRuntime,modelRuntime,eventIndex:this._events.length};
      const {frame:rawFrame,beforeFrame,diagnostics,events,historyLength,reviewing,...meta}=state;
      // Full wire traffic is exported once by report(). Event snapshots retain
      // a recent window, avoiding a quadratic copy of every earlier packet.
      const compactMeta={...meta,onboarding:{...onboarding,traffic:onboarding.traffic.slice(-15)}};
      this._events.push(copy(compactMeta));this._truth.push({eventIndex:state.eventIndex,diagnostics:copy(diagnostics)});
      this._history.push({...copy(compactMeta),diagnostics:copy(diagnostics),frame:this._png(rawFrame),beforeFrame:this._png(beforeFrame)});
      this._state={...state,events:this._events.slice()};return this.snapshot();
    }
    _appendControl(state){
      if(state.kind==='action-failure'||(state.done&&state.toolResult?.driverDiagnostic)){
        this._onboarding.ready=false;this._onboarding.status='failed';
        this._onboarding.runtimeFault=copy(state.toolResult);
      }
      return this._emit({...state,decisionCount:this._frontDecisions+state.decisionCount,modelCalls:this._frontCalls+this._controlCalls});
    }
    snapshot(){return this._state?{...this._state,historyLength:this._history.length}:null;}
    review(index){const i=Math.max(0,Math.min(this._history.length-1,Math.floor(Number(index)||0))),state=this._history[i];return state?{...copy(state),events:this._events.slice(0,i+1),reviewing:true,historyLength:this._history.length}:null;}
    _failure(message,fields={}){this._proposal=null;this._onboarding.status='failed';return this._emit({kind:'failure',title:'實驗已停止，保留未完成的證據',explanation:message,failure:message,done:true,nextLabel:'重新開始',...fields});}
    _decisionFailure(error){
      const result=this._decisionRecovery.reject(error,this._allowed(),this.strategy==='gemini'?'Gemini':'Claude');
      if(!result.willRetry)return this._failure(result.summary,result.fields);
      return this._emit({kind:'decision-rejected',title:'決策被拒絕，保留設備準備進度等待修正',explanation:result.summary,nextLabel:'下一步：請模型修正決策',...result.fields});
    }
    async _requestDecision(context,frame,phase){
      const epoch=this._epoch,before=Number(this.provider?.calls);
      try{return await this.provider.decide(context,frame);}
      finally{
        const after=Number(this.provider?.calls);
        const actual=Number.isFinite(before)&&Number.isFinite(after)?Math.max(0,after-before):1;
        if(epoch===this._epoch&&!this._disposed){if(phase==='onboarding')this._frontCalls+=actual;else this._controlCalls+=actual;}
      }
    }
    async next(){
      if(this._disposed)throw new Error('實驗已關閉。');if(!this._state)return this.initialize();if(this._busy||this._state.done)return this.snapshot();
      this._busy=true;const epoch=this._epoch;
      try{
        if(this._control){const state=await this._control.next();if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._appendControl(state);}
        if(this._proposal)return await this._executeFront(epoch);
        if(this._frontDecisions>=this.maxFrontDecisions)return this._failure('前置探索已達決策次數上限，尚未完成控制程式驗證。');
        let value;
        if(['claude','gemini'].includes(this.strategy)){
          try{value=await this._requestDecision(this._context(),this._link.frame(),'onboarding');}
          catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._decisionFailure(error);}
        }else value=this._offlineDecision();
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        if(['claude','gemini'].includes(this.strategy)&&value?.source!==this.strategy)throw new Error('模型決策來源與目前選擇的代理不符，禁止改用其他策略。');
        const decision=validateFrontDecision(value,this._allowed());this._decisionRecovery.accept();this._frontDecisions++;this._proposal=decision;
        this._onboarding.phase=decision.tool;this._onboarding.status='proposed';
        return this._emit({kind:'decision',title:`代理提案：${LABELS[decision.tool]}`,explanation:decision.reason,decision,controllerPhase:decision.tool,nextLabel:`下一步：執行「${LABELS[decision.tool]}」`});
      }catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._failure(`決策未通過檢查：${String(error.message||error).slice(0,240)}`);}
      finally{if(epoch===this._epoch)this._busy=false;}
    }
    async _executeFront(epoch){
      const d=this._proposal;this._proposal=null;const o=this._onboarding;let result,summary,ok=true;
      try{
        if(d.tool==='stop')return this._failure(d.reason||'代理選擇停止探索。');
        if(d.tool==='inspect_device'){
          o.hypothesis={...copy(d.args),confidence:'unverified',source:['claude','gemini'].includes(d.source)?'model-visual-hypothesis':'preset-offline-hypothesis'};
          result=copy(o.hypothesis);summary='已記錄外觀假設，尚未當作精確規格。型號與通訊能力必須由手冊及握手查證。';
        }else if(d.tool==='list_interfaces'){
          result=await this._link.inventory();o.inventory=copy(result);summary=`模擬主機回覆 ${result.length} 個通訊端點。這是模擬介面清單。`;
        }else if(d.tool==='read_manual'){
          result=await this._link.manual(d.args.documentId);o.manual=copy(result);summary=`已查閱 ${result.model} 模擬手冊，取得傳輸設定、協定與程式介面${result.templateIncluded===false?'（本次手冊不含驅動範本）':''}。機構尺寸與運動增益仍未知。`;
        }else if(d.tool==='connect'){
          result=await this._link.connect(d.args);if(result?.ok===false)throw new Error(result.error||'連線被拒絕。');
          o.connection=copy(result);o.handshake=null;o.driverTests=null;this._completed.delete('handshake');this._completed.delete('test_driver');summary='傳輸設定已驗證，模擬連線已建立。尚未確認設備身分，也尚未允許動作。';
        }else if(d.tool==='handshake'){
          result=await this._link.handshake();if(!result?.ok||result.model!==(o.manual?.model||this.device)||result.channels!==2)throw new Error('設備握手身分或通道能力不符。');
          o.handshake=copy(result);summary='實際握手回覆已確認設備型號、協定與 2 個控制通道；沒有送出位移命令。';
        }else if(d.tool==='write_driver'){
          o.driverSource=d.args.source;o.driverTests=null;o.compileResult=null;this._completed.delete('write_driver');this._completed.delete('test_driver');
          result=await this._runtime.compile(d.args.source);if(!result?.ok)throw new Error(result?.error||'驅動程式編譯失敗。');
          o.compileResult=copy(result);o.driverSourceOrigin=['claude','gemini'].includes(d.source)?`${d.source}-generated${o.manual?.templateIncluded===false?'-no-template':''}`:o.manual?.templateIncluded===false?'offline-spec-synthesizer':'manual-template';summary=['claude','gemini'].includes(d.source)?`${d.source==='gemini'?'Gemini':'Claude'} 提供的 JavaScript 已在隔離環境中編譯；接著以乾跑測試檢查。`:'手冊 JavaScript 範本已在隔離環境中編譯；離線模式並未宣稱由語言模型寫程式。';
        }else if(d.tool==='write_controller'){
          if(this.controllerMode!=='generated'||!this._controllerRuntime)throw new Error('本次實驗使用內建 XY 控制器。');
          o.controllerSource=d.args.source;o.controllerTests=null;o.controllerCompile=null;this._completed.delete('write_controller');this._completed.delete('test_controller');
          result=await this._controllerRuntime.compile(d.args.source);if(!result?.ok)throw new Error(result?.error||'控制程式編譯失敗。');
          o.controllerCompile=copy(result);o.controllerSourceOrigin=['claude','gemini'].includes(d.source)?`${d.source}-generated`:'offline-reference-module';
          summary=['claude','gemini'].includes(d.source)?`${d.source==='gemini'?'Gemini':'Claude'} 提供的 control(state) 已在隔離環境中編譯；接著以合成設備測試。`:'離線參考控制模組已在隔離環境中編譯；這是預寫基準，不是語言模型產生的程式。';
        }else if(d.tool==='test_controller'){
          if(!o.controllerCompile?.ok)throw new Error('請先編譯控制程式。');
          const runtime=this._controllerRuntime;
          result=await VlabControllerModule.isolationTest(state=>runtime.control(state),{channelKind:o.manual?.channelKind||null});result.sourceHash=o.controllerCompile.sourceHash;
          o.controllerTests=copy(result);ok=Boolean(result.passed);
          const gated=result.cases.filter(x=>x.gate!==false),arm=result.efficiency?.nonlinearArm;summary=ok?`控制程式通過 ${gated.length} 組合成設備隔離測試${arm?`；二連桿案例${arm.reached?` ${arm.ratio}×`:'未到達'}${arm.required?'':'（僅回報）'}`:''}；測試未送出任何設備命令。`:`控制程式未通過隔離測試：${gated.filter(x=>!x.passed).map(x=>x.name).join('、')}。必須修正後重新測試。`;
        }else if(d.tool==='test_driver'){
          result=await this._runtime.test(this._link);o.driverTests=copy(result);ok=Boolean(result?.passed);
          summary=ok?'驅動程式測試通過。測試未移動手臂，後續真實模擬動作會重用這份程式。':'驅動程式測試未通過；保留測試結果，必須修正程式後重新驗證。';
        }else if(d.tool==='start_control'){
          if(!o.handshake?.ok||!o.driverTests?.passed||!o.compileResult?.ok)throw new Error('握手或驅動測試尚未通過，禁止啟用控制。');
          if(this.controllerMode==='generated'&&(!o.controllerTests?.passed||o.controllerTests.sourceHash!==this._controllerRuntime?.sourceHash))throw new Error('控制程式尚未通過隔離測試，禁止啟用控制。');
          const controllerRuntime=this._controllerRuntime,controller=this.controllerMode==='generated'?{origin:o.controllerSourceOrigin,sourceHash:o.controllerTests.sourceHash,decide:state=>controllerRuntime.control(state)}:null;
          const owner=this,provider=this.provider?{get calls(){return owner._frontCalls+owner._controlCalls;},get model(){return owner.provider.model;},abort(){owner.provider.abort?.();},async decide(context,frame){return owner._requestDecision({...context,phase:context.phase||'control'},frame,'control');}}:null;
          const controlOptions={seed:this.seed,strategy:this.strategy,provider,challenge:this.challenge,recordFrames:false,maxActions:this.maxActions,maxDecisions:this.maxDecisions,plant:this._plant,frameGetter:()=>this._link.frame(),actuator:async command=>{if(!this._onboarding.ready)throw new Error('控制尚未啟用。');return this._runtime.act(command,this._link);},mechanicalActuator:async command=>{if(!this._onboarding.ready)throw new Error('控制尚未啟用。');return this._runtime.operate(command,this._link);},controller};
          this._control=this.controlFactory?this.controlFactory(controlOptions):new AutonomousEngine(controlOptions);
          await this._control.initialize();if(epoch!==this._epoch||this._disposed)return this.snapshot();
          o.ready=true;o.status='ready';this._controlOffset=this._events.length+1;result={ok:true,driverSourceHash:o.driverTests.sourceHash||o.compileResult.sourceHash,actionCount:0};summary='前置工作完成。控制器尚不知道運動映射；接下來透過剛才產生與測試的通訊程式試動、觀察與自我校正。';
        }
      }catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();if(d.tool==='start_control'){this._control?.dispose();this._control=null;o.ready=false;}ok=false;result={ok:false,error:String(error.message||error).slice(0,300),...(error.diagnostic?{driverErrorCode:error.code,driverDiagnostic:copy(error.diagnostic)}:{})};summary=`工具未完成：${result.error}。手臂未因這個前置工具而移動。`;
        if(RUNTIME_ENVIRONMENT_CODES.includes(error.code)){this._runtimeEnvironmentFailures++;const env=browserEnvironment();result.environmentAtFailure={visibilityState:env.visibilityState,hasFocus:env.hasFocus};}}
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      if(ok&&RUNTIME_TOOLS.includes(d.tool))this._runtimeEnvironmentFailures=0;
      if(ok)this._completed.add(d.tool);
      o.status=o.ready?'ready':ok?'passed':'failed';o.steps.push({tool:d.tool,ok,summary});this._lastResult={tool:d.tool,ok,summary,...(!ok?{error:result?.error}:{} )};
      if(!ok&&this._runtimeEnvironmentFailures>=RUNTIME_ENVIRONMENT_LIMIT){
        this._emit({kind:'onboarding-error',title:`工具結果：${LABELS[d.tool]}`,explanation:summary,decision:d,toolResult:{ok,summary,data:copy(result)},controllerPhase:d.tool,nextLabel:'實驗停止'});
        return this._failure(`隔離執行環境連續 ${this._runtimeEnvironmentFailures} 次無法啟動（${result.driverErrorCode}），產生的程式未送入沙箱。這是本機瀏覽器執行環境錯誤，不是模型決策失敗；停止以免消耗呼叫額度。`,{failureCategory:'runtime-environment'});
      }
      return this._emit({kind:o.ready?'control-ready':ok?'onboarding-result':'onboarding-error',title:`工具結果：${LABELS[d.tool]}`,explanation:summary,decision:d,toolResult:{ok,summary,data:copy(result)},controllerPhase:d.tool,nextLabel:o.ready?'下一步：請代理選擇控制工具':'下一步：請代理選擇工具'});
    }
    async _controlOperation(method,args){
      if(!this._control||!this._onboarding.ready)throw new Error('請先完成連線與控制程式測試。');
      if(this._busy)throw new Error('請等待目前步驟完成。');
      this._busy=true;const epoch=this._epoch;
      try{const state=await this._control[method](...args);if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._appendControl(state);}
      finally{if(epoch===this._epoch)this._busy=false;}
    }
    async setTargetPixel(x,y){return this._controlOperation('setTargetPixel',[x,y]);}
    async perturb(kind='motor'){return this._controlOperation('perturb',[kind]);}
    report(){
      const numerical=this._control?.report()||null,usage={};for(const e of this._events){const values=e.kind==='decision'?e.decision?.usage:e.decisionUsage;for(const k of USAGE)if(Number.isFinite(values?.[k]))usage[k]=(usage[k]||0)+values[k];}
      const modelExpectationText={provided:0,omitted:0};
      for(const event of this._events)if(event.kind==='decision'&&['claude','gemini'].includes(event.decision?.source)){
        const decision=event.decision,provided=decision.expectedProvided!==false&&typeof decision.expected==='string'&&Boolean(decision.expected.trim());
        modelExpectationText[provided?'provided':'omitted']++;
      }
      return {version:'0.7.0',strategy:this.strategy,experiment:{device:this.device,protocol:this._onboarding?.manual?.connection?.protocol||null,manualTemplate:this.manualTemplate,controllerMode:this.controllerMode},languageModel:['claude','gemini'].includes(this.strategy),model:['claude','gemini'].includes(this.strategy)?String(this.provider?.model||''):null,scope:'模擬設備：影像假設 → 介面與手冊 → 連線握手 → JavaScript 驅動 → 乾跑測試 → 平面視覺閉迴圈；沒有實體掃描或連線。',parameters:numerical?.parameters||{seed:this.seed,tolerancePx:7,inputLimit:.1,cameraPixels:[640,480]},scenario:numerical?.scenario||null,done:Boolean(this._state?.done),failure:this._state?.failure||null,failureCategory:this._state?.failureCategory||null,checkpoints:copy(this._state?.checkpoints),actionCount:this._state?.actionCount||0,commandAttemptCount:this._state?.commandAttemptCount||0,unconfirmedActuationCount:this._state?.unconfirmedActuationCount||0,probeCount:this._state?.probeCount||0,recalibrations:this._state?.recalibrations||0,decisionCount:this._frontDecisions+(numerical?.decisionCount||0),modelCalls:this._frontCalls+this._controlCalls,provenance:{frontMode:['claude','gemini'].includes(this.strategy)?`${this.strategy}-tools`:'offline-preset-policy',driverSource:this._onboarding?.driverSourceOrigin||null,controllerSource:this.controllerMode==='generated'?this._onboarding?.controllerSourceOrigin||null:'builtin-numerical-controller',controllerTests:copy(this._onboarding?.controllerTests||null),frontCalls:this._frontCalls,controlCalls:this._controlCalls,usage,modelExpectationText,allActuationThroughDriver:true},onboarding:this._frontState(),driverRuntime:copy(this._runtime?.diagnostics||null),environment:{...browserEnvironment(),visibilityChanges:copy(this._visibility||[])},modelRuntime:copy(this.provider?.requestDiagnostics||null),controllerInputs:['camera width/height/RGBA','observed simulated inventory/manual/handshake','generated driver results','acknowledged applied inputs','user goal update'],decisionRejections:VlabDecisionRecovery.count(this._events),decisionCorrectionLimit:2,trace:copy(this._events),evaluatorTruth:copy(this._truth)};
    }
    dispose(){if(this._visibilityHandler&&typeof document!=='undefined')document.removeEventListener('visibilitychange',this._visibilityHandler);this._visibilityHandler=null;this._disposed=true;this._epoch++;this.provider?.abort?.();this._control?.dispose();this._runtime?.dispose();this._controllerRuntime?.dispose();}
  }
  global.FullExperimentEngine=FullExperimentEngine;global.VLAB_DOCUMENTS=DOCUMENTS;global.validateFrontDecision=validateFrontDecision;
})(globalThis);
