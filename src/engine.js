(function(global){
  'use strict';
  const VERSION='0.7.0',TOLERANCE=7;
  const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
  const RECOVERABLE_DECISIONS=new Set(['INVALID_DECISION','INVALID_ARGUMENTS','INVALID_TOOL_RESPONSE']);
  const USAGE_FIELDS=['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens','promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','cachedContentTokenCount'];
  const PROVIDER_FAILURES={CALL_BUDGET:'已達模型呼叫次數上限；修正請求也計入上限。',TIMEOUT:'模型請求逾時。',ABORTED:'模型請求已取消。',NETWORK_ERROR:'模型網路請求未完成。',CREDENTIAL_ECHO:'模型回覆包含不應出現的認證資料。',HTTP_400:'供應商拒絕請求格式或模型設定。',HTTP_401:'API 金鑰驗證失敗。',HTTP_403:'供應商或本機橋接拒絕存取。',HTTP_404:'找不到所選模型或橋接路徑。',HTTP_429:'供應商配額或請求速率已達上限。',HTTP_503:'供應商或本機橋接暫時無法提供服務。',INVALID_API_KEY:'API 金鑰驗證失敗。',QUOTA_EXCEEDED:'供應商配額或請求速率已達上限。',MODEL_UNAVAILABLE:'所選模型目前無法使用。',BLOCKED_RESPONSE:'供應商未提供可執行的工具決策。',INVALID_RESPONSE:'供應商回覆無法解析為有效資料。'};
  // A rejected response has never reached a device. Correct only that decision,
  // through the normal next-step loop, while keeping the current control state.
  class DecisionRecovery {
    constructor(){this.maxCorrections=2;this.accept();}
    accept(){this.attempt=0;this.feedback=null;}
    context(context){return {...clone(context),...(this.feedback?{decisionFeedback:clone(this.feedback)}:{})};}
    reject(error,allowedTools,providerName){
      const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code)?error.code:'PROVIDER_FAILURE';
      const recoverable=RECOVERABLE_DECISIONS.has(code);
      const diagnostic=global.VlabAgentContract?.rejectionDiagnostic?.(code,error?.diagnostic?.issue,error?.diagnostic)||{
        code,issue:recoverable?'invalid-response':'provider-failure',
        message:recoverable?'模型回覆不符合目前工具契約。':PROVIDER_FAILURES[code]||'供應商呼叫未完成。'
      };
      diagnostic.code=code;
      if(!recoverable){
        const messages={RATE_LIMITED:'供應商暫時限流；已達本次自動重試上限。',RATE_LIMIT_WAIT_TOO_LONG:'供應商要求的等待時間超過自動等待上限，已停止本次請求。',BRIDGE_CALL_BUDGET:'本機橋接累計呼叫次數已達上限；等待不會增加此額度。',QUOTA_EXCEEDED:'供應商可用配額不足；請檢查每日額度或帳務限制。'};
        if(messages[code])diagnostic.message=messages[code];
      }
      const modelDiagnostic={},request=error?.requestDiagnostic;
      if(request&&typeof request==='object'){
        modelDiagnostic.code=code;
        for(const key of ['status','retryAfterMs','retryAttempt','maxRetries','requestNumber'])if(Number.isFinite(request[key])&&request[key]>=0)modelDiagnostic[key]=request[key];
        if(['rate','daily','spend','unavailable','unknown'].includes(request.quotaKind))modelDiagnostic.quotaKind=request.quotaKind;
        if(typeof request.retryable==='boolean')modelDiagnostic.retryable=request.retryable;
      }
      const attempt=recoverable?++this.attempt:0,willRetry=recoverable&&attempt<=this.maxCorrections;
      const detail=`${providerName} 回覆未通過檢查（${code} / ${diagnostic.issue}）：${diagnostic.message}`;
      const summary=willRetry?`${detail} 本次沒有執行動作；保留目前進度，下一步請模型修正（第 ${attempt}／${this.maxCorrections} 次）。`:recoverable?`${detail} 已用完 ${this.maxCorrections} 次修正機會，實驗停止；目前進度與拒絕原因已保留。`:`${providerName} 呼叫未完成（${code}）：${diagnostic.message} 實驗停止，已保留目前進度。`;
      this.feedback=willRetry?{code,issue:diagnostic.issue,message:diagnostic.message,attempt,maxCorrections:this.maxCorrections,allowedTools:[...allowedTools],diagnostic:clone(diagnostic)}:null;
      const usage={};for(const key of USAGE_FIELDS)if(Number.isFinite(error?.usage?.[key])&&error.usage[key]>=0)usage[key]=error.usage[key];
      return {willRetry,summary,fields:{decision:null,decisionDiagnostic:diagnostic,decisionRecovery:{attempt,maxCorrections:this.maxCorrections,willRetry},decisionUsage:usage,modelDiagnostic:Object.keys(modelDiagnostic).length?modelDiagnostic:null,toolResult:{ok:false,summary,...(Object.keys(modelDiagnostic).length?{modelDiagnostic}:{})}}};
    }
    static count(events){return events.filter(e=>RECOVERABLE_DECISIONS.has(e.decisionDiagnostic?.code)).length;}
  }
  global.VlabDecisionRecovery=DecisionRecovery;
  const f=x=>Number.isFinite(x)?x.toFixed(2):'未知';
  const labels={observe:'觀察影像',probe:'小幅試動',fit_model:'建立映射',move:'移向目標',reset_model:'清除失效映射',verify:'重新拍攝驗證',stop:'停止實驗'};

  function createWorker(config){
    const controller=document.getElementById('controller-source'),agent=document.getElementById('agent-source');
    if(!controller||!agent)throw new Error('缺少獨立控制器程式。');
    const wrapper=`\nlet core=new AgentCore(${JSON.stringify(config)});
      self.onmessage=e=>{const {id,op,data}=e.data;try{let result;
        if(op==='context')result=core.context();
        else if(op==='inspect')result=core.inspect(data);
        else if(op==='decide')result=data.strategy==='baseline'?core.baselineDecision(data):core.adaptiveDecision();
        else if(op==='prepare')result=core.prepare(data.decision,data.strategy);
        else if(op==='outcome')result=core.outcome(data);
        else if(op==='execute')result=core.execute(data);
        else if(op==='cancel')result=core.cancel();
        else if(op==='refresh'){core.observe(data);result=core.context();}
        else if(op==='goal'){core.goal();core.observe(data);result=core.context();}
        else throw new Error('Unknown worker operation');
        self.postMessage({id,result});}catch(error){self.postMessage({id,error:String(error.message||error)});}};`;
    const url=URL.createObjectURL(new Blob([controller.textContent,'\n',agent.textContent,wrapper],{type:'text/javascript'}));
    const worker=new Worker(url);URL.revokeObjectURL(url);
    let serial=0,closed=false;const pending=new Map();
    const rejectAll=error=>{for(const r of pending.values()){clearTimeout(r.timer);r.reject(error);}pending.clear();};
    worker.onmessage=e=>{const r=pending.get(e.data.id);if(!r)return;pending.delete(e.data.id);clearTimeout(r.timer);e.data.error?r.reject(new Error(e.data.error)):r.resolve(e.data.result);};
    worker.onerror=e=>rejectAll(new Error(e.message||'獨立控制器執行失敗。'));
    return {call(op,data){if(closed)return Promise.reject(new Error('控制器已關閉。'));return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('控制器回應逾時。'));},15000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,op,data});});},dispose(){closed=true;worker.terminate();rejectAll(new Error('控制器已關閉。'));}};
  }

  class AutonomousEngine {
    constructor({seed=42,strategy='adaptive',provider=null,challenge=true,recordFrames=true,maxActions=180,maxDecisions=300,plant=null,actuator=null,frameGetter=null,preserveTarget=false,controller=null}={}) {
      if(!['adaptive','baseline','gemini','claude'].includes(strategy))throw new Error('未知策略。');
      this._injectedPlant=plant;this._actuator=actuator;this._frameGetter=frameGetter;this._preserveTarget=Boolean(preserveTarget);
      // Optional tested controller module {decide(state),origin,sourceHash}. When
      // present it replaces per-step XY tool decisions; actuation, ACK handling,
      // camera verification and budgets stay on the host.
      this._controller=controller&&typeof controller.decide==='function'?controller:null;this._controllerHistory=[];
      this.seed=Number(seed)>>>0;this.strategy=strategy;this.provider=provider;this.challenge=Boolean(challenge);this.recordFrames=Boolean(recordFrames);
      this.maxActions=Math.max(1,Math.min(1000,Math.floor(Number(maxActions)||180)));
      this.maxDecisions=Math.max(1,Math.min(2000,Math.floor(Number(maxDecisions)||300)));
      this._state=null;this._agent=null;this._plant=null;this._history=[];this._events=[];this._truth=[];this._busy=false;this._disposed=false;this._epoch=0;
    }
    get historyLength(){return this._history.length;}
    async initialize(){return this._state?this.snapshot():this.reset(this.seed);}
    async reset(seed=this.seed,options={}) {
      // Abort in-flight model calls before replacing the worker or plant.
      this._epoch++;this.provider?.abort?.();this._agent?.dispose();
      if(options.strategy){if(!['adaptive','baseline','gemini','claude'].includes(options.strategy))throw new Error('未知策略。');this.strategy=options.strategy;}
      if('provider'in options)this.provider=options.provider;
      if('challenge'in options)this.challenge=Boolean(options.challenge);
      if(['gemini','claude'].includes(this.strategy)&&!this.provider)throw new Error('請先設定 模型與 API 金鑰。');
      this._busy=true;this._disposed=false;const epoch=this._epoch;
      try {
        this.seed=Number(seed)>>>0;this._plant=this._injectedPlant||new VirtualPlant({seed:this.seed,width:640,height:480});
        const target1=this._plant.diagnostics().target.slice();if(!this._preserveTarget)this._plant.newTarget();const target2=this._plant.diagnostics().target.slice();this._plant.setTargetPixel(...target1);
        this._scenario={target1,target2,changedChannel:null,challenge:this.challenge};
        this._agent=createWorker({maxActions:this.maxActions,maxDecisions:this.maxDecisions});
        this._ctx=await this._agent.call('context');if(epoch!==this._epoch)return this.snapshot();
        this._history=[];this._events=[];this._truth=[];this._pngCache=new WeakMap();this._decisionRecovery=new DecisionRecovery();
        this._pngCanvas=document.createElement('canvas');this._pngContext=this._pngCanvas.getContext('2d');
        this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());this._proposal=null;this._mode='decide';this._changed=false;
        this._actionCount=0;this._probeCount=0;this._recalibrations=0;this._decisionCount=0;this._episodeDecisions=0;this._episodeActions=0;this._sentCount=0;this._unconfirmedCount=0;
        this._modelSeen=false;this._checkpoints={firstReach:null,changed:false,preChangeMismatch:false,mismatchSeen:false,recovered:null};this._state=null;
        return this._emit({stage:'intro',kind:'intro',title:'給定目標，讓代理自行決定下一個工具',explanation:['gemini','claude'].includes(this.strategy)?'語言模型 將讀取相機影像與量測摘要，自行選擇觀察、試動、建模、移動及驗證。所有動作都經過有界控制器執行。':this.strategy==='baseline'?'這是 V2 基準策略：固定六次試動建立映射，並以既有誤差門檻重新校正。':'這是離線自適應策略代理：依影像、樣本涵蓋與模型誤差選擇工具。沒有接入語言模型，也沒有預排到達軌跡。',nextLabel:'下一步：請代理選擇工具'});
      }finally{if(epoch===this._epoch)this._busy=false;}
    }
    _payload(frame=this._frame){return {width:frame.width,height:frame.height,pixels:frame.pixels.slice()};}
    _png(frame){
      if(!frame||!this.recordFrames)return null;
      let value=this._pngCache.get(frame);if(value)return value;
      this._pngCanvas.width=frame.width;this._pngCanvas.height=frame.height;this._pngContext.putImageData(new ImageData(frame.pixels,frame.width,frame.height),0,0);
      value={width:frame.width,height:frame.height,dataURL:this._pngCanvas.toDataURL('image/png')};this._pngCache.set(frame,value);return value;
    }
    _emit(fields){
      const diagnostics=this._plant.diagnostics();
      const state={seed:this.seed,strategy:this.strategy,stage:this._changed?'recover':'intro',kind:'observation',title:'',explanation:'',nextLabel:'下一步：請代理選擇工具',done:false,failure:null,eventIndex:this._events.length,actionCount:this._actionCount,commandAttemptCount:this._sentCount,unconfirmedActuationCount:this._unconfirmedCount,probeCount:this._probeCount,recalibrations:this._recalibrations,decisionCount:this._decisionCount,modelCalls:Number(this.provider?.calls)||0,observation:clone(this._ctx?.observation||null),jacobian:clone(this._ctx?.model?.jacobian||null),decision:null,command:null,predicted:null,residual:null,predictionThreshold:null,applied:null,limited:null,beforeTip:null,afterTip:null,frame:this._frame,beforeFrame:null,diagnostics,checkpoints:clone(this._checkpoints),agentContext:clone(this._ctx),toolResult:null,policyStatus:this._mode,...fields};
      const {frame,beforeFrame,diagnostics:truth,events,agentContext,...metadata}=state;
      this._events.push({...clone(metadata),agentContext:clone(agentContext)});
      this._truth.push({eventIndex:state.eventIndex,diagnostics:clone(diagnostics)});
      state.events=this._events.slice();this._state=state;
      this._history.push({...clone(metadata),agentContext:clone(agentContext),diagnostics:clone(diagnostics),frame:this._png(frame),beforeFrame:this._png(beforeFrame)});
      return this.snapshot();
    }
    snapshot(){return this._state?{...this._state,historyLength:this._history.length}:null;}
    review(index){const i=Math.max(0,Math.min(this._history.length-1,Math.floor(Number(index)||0)));const s=this._history[i];return s?{...clone(s),events:this._events.slice(0,i+1),reviewing:true,historyLength:this._history.length}:null;}
    report(){return {version:VERSION,strategy:this.strategy,languageModel:['gemini','claude'].includes(this.strategy),model:['gemini','claude'].includes(this.strategy)?String(this.provider?.model||'未提供型號'):null,scope:'二連桿平面影像控制；有色標記辨識；不含夾取、三維動力學或真實硬體。',parameters:{seed:this.seed,tolerancePx:TOLERANCE,maxActionsPerGoal:this.maxActions,maxDecisionsPerGoal:this.maxDecisions,inputLimit:.1,cameraPixels:[640,480]},scenario:clone(this._scenario),controllerInputs:['camera width/height/RGBA','acknowledged applied channel inputs','selected allowlisted tool','user goal update'],done:Boolean(this._state?.done),failure:this._state?.failure||null,checkpoints:clone(this._checkpoints),actionCount:this._actionCount,commandAttemptCount:this._sentCount,unconfirmedActuationCount:this._unconfirmedCount,probeCount:this._probeCount,recalibrations:this._recalibrations,decisionCount:this._decisionCount,modelCalls:Number(this.provider?.calls)||0,decisionRejections:VlabDecisionRecovery.count(this._events),decisionCorrectionLimit:2,trace:clone(this._events),evaluatorTruth:clone(this._truth)};}
    _failure(message,fields={}){this._mode='done';this._proposal=null;return this._emit({stage:this._changed?'recover':'intro',kind:'failure',title:'實驗停止，保留未完成的證據',explanation:message,done:true,failure:message,nextLabel:'重新開始',...fields});}
    _decisionFailure(error){
      const result=this._decisionRecovery.reject(error,this._ctx.allowedTools||[],this.strategy==='gemini'?'Gemini':'Claude');
      if(!result.willRetry)return this._failure(result.summary,result.fields);
      return this._emit({kind:'decision-rejected',title:'決策被拒絕，保留校正進度等待修正',explanation:result.summary,nextLabel:'下一步：請模型修正決策',...result.fields,agentContext:this._decisionRecovery.context(this._ctx)});
    }
    async next(){
      if(this._disposed)throw new Error('實驗已關閉。');if(!this._state)return this.initialize();if(this._busy||this._state.done)return this.snapshot();
      this._busy=true;const epoch=this._epoch;
      try {
        if(this._mode==='challenge')return await this._applyChallenge(epoch);
        if(this._controller)return await this._controllerNext(epoch);
        if(this._proposal)return await this._execute(epoch);
        if(this._episodeDecisions>=this.maxDecisions)return this._failure('已達本目標的決策次數上限，仍未驗證到達。');
        let decision;
        if(['gemini','claude'].includes(this.strategy)){
          try{decision=await this.provider.decide(this._decisionRecovery.context(this._ctx),this._payload());}
          catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._decisionFailure(error);}
        }else decision=await this._agent.call('decide',this.strategy==='baseline'?{...this._payload(),strategy:this.strategy}:{strategy:this.strategy});
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        if(['claude','gemini'].includes(this.strategy)&&decision?.source!==this.strategy)throw new Error('模型決策來源與目前選擇的代理不符，禁止改用其他策略。');
        const prepared=await this._agent.call('prepare',{decision,strategy:this.strategy});
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        this._decisionRecovery.accept();this._proposal=prepared;this._mode='execute';this._ctx=prepared.context;this._decisionCount++;this._episodeDecisions++;
        this._recalibrations=prepared.recalibrations;
        const tool=prepared.decision.tool;
        return this._emit({stage:this._stage(tool),kind:'decision',title:`代理提案：${labels[tool]}`,explanation:prepared.decision.reason,nextLabel:`下一步：執行「${labels[tool]}」`,decision:prepared.decision,command:prepared.command,predicted:prepared.predicted,jacobian:prepared.jacobian,controllerPhase:tool});
      }catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._failure(`決策或工具未通過執行檢查：${String(error.message).slice(0,200)}`,error.diagnostic?{toolResult:{ok:false,driverErrorCode:error.code,driverDiagnostic:clone(error.diagnostic),wireSent:false}}:{});}
      finally{if(epoch===this._epoch)this._busy=false;}
    }
    async _controllerNext(epoch){
      if(this._episodeDecisions>=this.maxDecisions)return this._failure('已達本目標的決策次數上限，仍未驗證到達。');
      this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
      this._ctx=await this._agent.call('refresh',this._payload());
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      const obs=this._ctx.observation,beforeFrame=this._frame,beforeTip=clone(obs?.tip||null);
      if(!obs?.tip||!obs?.target)return this._failure('影像缺少可辨識的末端或目標，產生的控制程式不會在缺乏量測時動作。');
      const state=global.VlabControllerModule.state({tip:obs.tip,target:obs.target,history:this._controllerHistory,step:this._episodeActions,maxActions:this.maxActions});
      let decision;
      try{decision=global.VlabControllerModule.validateDecision(await this._controller.decide(state));}
      catch(error){
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        return this._failure(`產生的控制程式未提供可執行決策：${String(error.message||error).slice(0,220)}。沒有送出動作。`,{toolResult:{ok:false,controllerError:String(error.message||error).slice(0,300),wireSent:false}});
      }
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._decisionCount++;this._episodeDecisions++;
      const d={tool:decision.action==='move'?'move':decision.action,args:decision.action==='move'?{u:decision.u.slice()}:{},reason:`控制程式（${this._controller.origin||'generated'}）輸出 ${decision.action}`,expected:'',source:'controller-module'};
      if(decision.action==='stop')return this._failure(`控制程式選擇停止：${decision.reason||'未提供原因'}`,{decision:d});
      if(decision.action==='verify'){
        const result=await this._agent.call('execute',{decision:{tool:'verify',args:{},reason:'controller verify',expected:''},frame:this._payload()});
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        this._ctx=result.context;
        if(result.ok){
          if(!this._checkpoints.firstReach)this._checkpoints.firstReach={error:result.observation.error,actions:this._episodeActions,decisions:this._episodeDecisions};
          else this._checkpoints.recovered={error:result.observation.error,actions:this._episodeActions,decisions:this._episodeDecisions};
          this._mode='done';
          return this._emit({stage:'complete',kind:'first-reach',title:'任務已由相機重新拍攝驗證',explanation:`控制程式要求驗證；新影像誤差 ${f(result.observation.error)} px，本目標 ${this._episodeActions} 次動作。`,decision:d,toolResult:{ok:true,summary:result.summary},done:true,nextLabel:'重新開始',controllerPhase:'verify'});
        }
        return this._emit({stage:'reach',kind:'verification-result',title:'控制程式要求驗證，但尚未到達',explanation:result.summary,decision:d,toolResult:{ok:false,summary:result.summary},controllerPhase:'verify'});
      }
      if(this._episodeActions>=this.maxActions)return this._failure('已達本目標的動作次數上限。',{decision:d});
      const command=decision.u.map(v=>Math.max(-.1,Math.min(.1,v)));
      let ack;
      try{ack=this._actuator?await this._actuator(command):this._plant.act(command);}
      catch(error){
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        if(!error.wireSent)return this._failure(`動作未送出：${String(error.message||error).slice(0,220)}`,{decision:d,toolResult:{ok:false,driverError:String(error.message||error).slice(0,300),driverErrorCode:error.code||null,wireSent:false}});
        this._sentCount++;this._unconfirmedCount++;this._mode='done';
        const message='命令已送出，但設備回覆無法確認實際接受的輸入。已停止控制，不把這次當作已確認的動作。';
        return this._emit({stage:'reach',kind:'action-failure',title:'命令已送出，執行狀態未確認',explanation:message,done:true,failure:message,decision:d,command,toolResult:{ok:false,summary:message,acknowledgementUnknown:true,driverError:String(error.message||error).slice(0,300),driverErrorCode:error.code||null,wireSent:true},nextLabel:'重新開始'});
      }
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._actionCount++;this._episodeActions++;this._sentCount++;
      this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
      const result=await this._agent.call('outcome',{frame:this._payload(),applied:ack.applied,command,tool:'move',limited:ack.limited,strategy:'controller-module'});
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._ctx=result.context;
      const after=result.observation?.tip;
      if(beforeTip&&after)this._controllerHistory.push({command:command.slice(),applied:ack.applied.slice(),delta:[after[0]-beforeTip[0],after[1]-beforeTip[1]],limited:Boolean(ack.limited)});
      if(this._controllerHistory.length>global.VlabControllerModule.HISTORY)this._controllerHistory.shift();
      if(ack.driverError){
        this._mode='done';const message='設備已執行命令，但產生的驅動程式無法解碼這次回覆。已記錄真實位移並停止控制。';
        return this._emit({stage:'reach',kind:'action-failure',title:'動作已發生，回覆解碼失敗',explanation:message,done:true,failure:message,decision:d,toolResult:{ok:false,summary:message,driverError:ack.driverError,driverErrorCode:ack.driverErrorCode,driverDiagnostic:clone(ack.driverDiagnostic||null),wireSent:true},command,applied:ack.applied,limited:ack.limited,beforeFrame,beforeTip,afterTip:after||null,nextLabel:'重新開始'});
      }
      return this._emit({stage:'reach',kind:'action-result',title:'工具結果：控制程式移動',explanation:`已完成第 ${this._actionCount} 次實際動作；影像誤差 ${f(result.observation?.error)} px。`,decision:d,toolResult:{ok:true,summary:result.lastOutcome?.summary||''},observation:result.observation,command,applied:ack.applied,limited:ack.limited,beforeFrame,beforeTip,afterTip:after||null,controllerPhase:'move'});
    }
    _stage(tool){return this._changed?'recover':['probe','reset_model'].includes(tool)?'probe':tool==='fit_model'?'model':['move','verify'].includes(tool)?'reach':'intro';}
    async _execute(epoch){
      const proposal=this._proposal,d=proposal.decision;this._proposal=null;this._mode='decide';
      const beforeFrame=this._frame,beforeTip=clone(this._ctx.observation?.tip||null);
      if(['probe','move'].includes(d.tool)) {
        if(this._episodeActions>=this.maxActions)return this._failure('已達本目標的動作次數上限。');
        let ack;
        try{ack=this._actuator?await this._actuator(proposal.command):this._plant.act(proposal.command);}
        catch(error){
          if(epoch!==this._epoch||this._disposed)return this.snapshot();
          if(!error.wireSent)throw error;
          this._sentCount++;this._unconfirmedCount++;this._mode='done';
          this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
          this._ctx=await this._agent.call('refresh',this._payload());
          if(epoch!==this._epoch||this._disposed)return this.snapshot();
          const message='命令已送出，但設備回覆無法確認實際接受的輸入。設備可能已移動；已重新取得影像並停止控制，不把這次當作已確認的動作。';
          return this._emit({stage:this._stage(d.tool),kind:'action-failure',title:'命令已送出，執行狀態未確認',explanation:message,done:true,failure:message,decision:d,toolResult:{ok:false,summary:message,acknowledgementUnknown:true,driverError:String(error.message||error).slice(0,300),driverErrorCode:error.code||null,driverDiagnostic:clone(error.diagnostic||null),wireSent:true},observation:clone(this._ctx.observation),command:proposal.command,applied:null,predicted:proposal.predicted,beforeFrame,beforeTip,afterTip:this._ctx.observation?.tip||null,controllerPhase:d.tool,nextLabel:'重新開始'});
        }
        if(epoch!==this._epoch||this._disposed)return this.snapshot();this._actionCount++;this._episodeActions++;if(d.tool==='probe')this._probeCount++;
        this._sentCount++;
        this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
        const result=await this._agent.call('outcome',{frame:this._payload(),applied:ack.applied,command:proposal.command,tool:d.tool,limited:ack.limited,strategy:this.strategy});
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        this._ctx=result.context;const outcome=result.lastOutcome;
        if(ack.driverError){
          this._mode='done';
          const message='設備已執行命令，但產生的驅動程式無法解碼這次回覆。已記錄真實位移並停止控制，請修正程式後重新測試。';
          return this._emit({stage:this._stage(d.tool),kind:'action-failure',title:'動作已發生，回覆解碼失敗',explanation:message,done:true,failure:message,decision:d,toolResult:{ok:false,summary:message,driverError:ack.driverError,driverErrorCode:ack.driverErrorCode,driverDiagnostic:clone(ack.driverDiagnostic||null),wireSent:true},observation:result.observation,command:proposal.command,applied:ack.applied,limited:ack.limited,predicted:outcome.predicted,residual:outcome.residual,predictionThreshold:outcome.threshold,beforeFrame,beforeTip,afterTip:result.observation.tip,jacobian:result.jacobian,controllerPhase:d.tool,nextLabel:'重新開始'});
        }
        if(outcome.mismatch){if(this._changed)this._checkpoints.mismatchSeen=true;else this._checkpoints.preChangeMismatch=true;}
        const firstModel=!this._modelSeen&&Boolean(proposal.jacobian);if(proposal.jacobian)this._modelSeen=true;
        return this._emit({stage:this._stage(d.tool),kind:outcome.mismatch?'mismatch-detected':'action-result',title:outcome.mismatch?'量測證據：實際位移不符合預測':`工具結果：${labels[d.tool]}`,explanation:`已完成第 ${this._actionCount} 次實際動作。${outcome.summary}${outcome.predicted?` 預測誤差 ${f(outcome.residual)} px；本次門檻 ${f(outcome.threshold)} px。`:''}`,decision:d,toolResult:{ok:outcome.ok,summary:outcome.summary,firstModel},observation:result.observation,command:proposal.command,applied:ack.applied,limited:ack.limited,predicted:outcome.predicted,residual:outcome.residual,predictionThreshold:outcome.threshold,beforeFrame,beforeTip,afterTip:result.observation.tip,jacobian:result.jacobian,controllerPhase:d.tool});
      }
      this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
      const result=await this._agent.call('execute',{decision:d,frame:this._payload()});
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._ctx=result.context;this._recalibrations=result.recalibrations;
      if(d.tool==='stop')return this._failure(d.reason||result.summary);
      if(d.tool==='verify'&&result.ok){
        if(!this._checkpoints.firstReach){
          this._checkpoints.firstReach={error:result.observation.error,actions:this._episodeActions,decisions:this._episodeDecisions};
          if(this.challenge&&!this._changed){this._mode='challenge';return this._emit({stage:'reach',kind:'first-reach',title:'第一個目標已由新影像驗證',explanation:`本目標用了 ${this._episodeActions} 次動作，量測誤差 ${f(result.observation.error)} px。接下來由測試環境指定第二個目標並改變設備；代理不會收到設備改變的通知。`,decision:d,toolResult:{ok:true,summary:result.summary},nextLabel:'下一步：進入第二個目標'});}
        }else this._checkpoints.recovered={error:result.observation.error,actions:this._episodeActions,decisions:this._episodeDecisions};
        this._mode='done';return this._emit({stage:'complete',kind:this._checkpoints.recovered?'recovery-reach':'first-reach',title:'任務已由相機重新拍攝驗證',explanation:`最後影像誤差 ${f(result.observation.error)} px；總共 ${this._actionCount} 次動作、${this._decisionCount} 次工具決策。${this._changed&&!this._checkpoints.mismatchSeen?' 本案例沒有量到超過門檻的預測誤差，不能宣稱已展示失準偵測。':''}`,decision:d,toolResult:{ok:true,summary:result.summary},done:true,nextLabel:'重新開始'});
      }
      let kind=d.tool==='observe'?'observation':d.tool==='verify'?'verification-result':'tool-result';
      if(d.tool==='fit_model'&&result.ok){kind=this._modelSeen?'model-relearned':'model-learned';this._modelSeen=true;}
      return this._emit({stage:this._stage(d.tool),kind,title:`工具結果：${labels[d.tool]}`,explanation:result.summary,decision:d,toolResult:{ok:result.ok,summary:result.summary},beforeFrame:d.tool==='observe'||d.tool==='verify'?beforeFrame:null,beforeTip,afterTip:result.observation?.tip||null});
    }
    async _applyChallenge(epoch=this._epoch){
      const beforeFrame=this._frame,beforeTip=clone(this._ctx.observation?.tip),gains=this._plant.diagnostics().geometry.channelGains;
      this._plant.setTargetPixel(...this._scenario.target2);this._plant.perturbMotor();
      const changed=this._plant.diagnostics().geometry.channelGains.findIndex((v,i)=>Math.sign(v)!==Math.sign(gains[i]));
      this._scenario.changedChannel=changed;this._changed=true;this._checkpoints.changed=true;this._checkpoints.changedChannel=changed;
      this._checkpoints.mismatchSeen=false;
      this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());this._ctx=await this._agent.call('goal',this._payload());
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._episodeActions=0;this._episodeDecisions=0;this._mode='decide';
      return this._emit({stage:'change',kind:'device-change',title:'測試環境已更換目標，並反轉一個通道',explanation:`觀察者可見：通道 ${changed===0?'A':'B'} 反轉。代理只收到新任務的相機影像，保留原映射；後續要從實際量測自行判斷是否需要重新學習。`,beforeFrame,beforeTip,afterTip:this._ctx.observation?.tip,changedChannel:changed});
    }
    async perturb(kind='motor'){
      if(!this._state)await this.initialize();
      if(this._busy)throw new Error('請先暫停並等待當前步驟結束。');
      if(this._state.done)throw new Error('實驗已結束，請先指定新目標或重新開始。');
      if(!['motor','camera'].includes(kind))throw new Error('只支援馬達或相機擾動。');
      this._busy=true;const epoch=this._epoch;
      try {
      if(this._proposal)await this._agent.call('cancel');
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      this._proposal=null;this._mode='decide';this._decisionRecovery.accept();this.challenge=false;this._scenario.challenge=false;
      const beforeFrame=this._frame,beforeTip=clone(this._ctx.observation?.tip);
      if(kind==='motor')this._plant.perturbMotor();else this._plant.perturbCamera();
      this._changed=true;this._checkpoints.changed=true;this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());
      // Inspector sees only pixels; do not reset the agent or announce the fault.
      this._ctx=await this._agent.call('refresh',this._payload());const observation=this._ctx.observation;
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      return this._emit({stage:'change',kind:'device-change',title:'觀察者已手動改變設備',explanation:'尚未執行的提案已取消。代理沒有收到改變訊息，下次決策仍需以影像與實際動作結果判斷。',observation,beforeFrame,beforeTip,afterTip:observation.tip});
      }finally{if(epoch===this._epoch)this._busy=false;}
    }
    async setTargetPixel(x,y){
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>=640||y<0||y>=480)throw new Error('目標需位於相機影像範圍內。');
      if(!this._state)await this.initialize();if(this._busy)throw new Error('請先暫停並等待當前步驟結束。');
      this._busy=true;const epoch=this._epoch;
      try {
      this._proposal=null;this._mode='decide';this._decisionRecovery.accept();this.challenge=false;this._scenario.challenge=false;
      this._checkpoints={firstReach:null,changed:false,preChangeMismatch:false,mismatchSeen:false,recovered:null};this._changed=false;
      this._plant.setTargetPixel(x,y);this._scenario.target1=[x,y];this._frame=(this._frameGetter?this._frameGetter():this._plant.frame());this._ctx=await this._agent.call('goal',this._payload());this._episodeActions=0;this._episodeDecisions=0;
      if(epoch!==this._epoch||this._disposed)return this.snapshot();
      return this._emit({stage:'intro',kind:'observation',title:'新目標已指定，保留已學會的映射',explanation:'代理將自行決定下一步。點選位置可能超出設備可達範圍；未到達會保留真實失敗結果。'});
      }finally{if(epoch===this._epoch)this._busy=false;}
    }
    dispose(){this._disposed=true;this._epoch++;this.provider?.abort?.();this._agent?.dispose();this._agent=null;}
  }
  global.AutonomousEngine=AutonomousEngine;
})(globalThis);
