(function (global) {
  'use strict';
  // Official Gemini generateContent function calling; no local policy fallback.
  // claude-provider.js installs this model-neutral contract before this script.
  const API='https://generativelanguage.googleapis.com/v1beta';
  const contract=global.VlabAgentContract;
  const requests=global.VlabModelRequests;
  class ProviderError extends Error {constructor(code,message,diagnostic){super(message);this.name='GeminiProviderError';this.code=code;if(diagnostic)this.diagnostic=diagnostic;}}
  const fail=(code,message,diagnostic)=>{throw new ProviderError(code,message,diagnostic);};
  const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const text=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
  const redact=(v,key)=>key?v.split(key).join('[REDACTED]'):v;
  function shared(name,...args){
    if(!contract||typeof contract[name]!=='function')fail('MISSING_CONTRACT','尚未載入控制工具契約，請重新建置並開啟完整介面。');
    try{return contract[name](...args);}catch(error){
      if(error?.name==='ClaudeProviderError')fail(error.code,error.message.replace(/Claude/g,'Gemini'),contract.rejectionDiagnostic?.(error.code,error.diagnostic?.issue,error.diagnostic));
      throw error;
    }
  }
  function keyOf(value){
    const key=typeof value==='string'?value.trim():'';
    if(!key)fail('MISSING_KEY','請輸入 Gemini API 金鑰，或從本機橋接網址開啟介面。');
    if(key.length>1024||/[\r\n]/.test(key))fail('INVALID_KEY','Gemini API 金鑰格式不正確。');
    return key;
  }
  function modelOf(value){
    const id=typeof value==='string'?value.trim().replace(/^models\//,''):'';
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id))fail('INVALID_MODEL','請從實際模型清單選擇 Gemini 模型。');
    return id;
  }
  function bridgeOf(value){
    if(!value)return null;
    let url;try{url=new URL(value);}catch(_){fail('INVALID_BRIDGE','本機橋接網址不正確。');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('INVALID_BRIDGE','橋接僅允許 http://127.0.0.1:連接埠。');
    return url.origin;
  }
  function checkTimeout(value){if(!Number.isFinite(value)||value<1||value>120000)fail('INVALID_TIMEOUT','Gemini 逾時設定不正確。');}
  function transport(bridge,key){return bridge?
    {base:bridge+'/api/gemini',headers:{'Content-Type':'application/json','X-Vlab-Bridge':'1'}}:
    {base:API,headers:{'Content-Type':'application/json','x-goog-api-key':key}};
  }
  const errorMessages=Object.freeze({
    INVALID_API_KEY:'Gemini API 金鑰無效，請確認 gemini_api_key 的內容或重新輸入金鑰。',
    QUOTA_EXCEEDED:'Gemini 使用配額或速率已達限制，請檢查帳號額度後再試。',
    MODEL_UNAVAILABLE:'找不到所選 Gemini 模型，請重新讀取模型清單並選擇可用模型。',
    PERMISSION_DENIED:'Gemini 拒絕存取，請檢查 API 啟用狀態及金鑰權限限制。',
    INVALID_REQUEST_FORMAT:'Gemini 拒絕請求格式，或所選模型不支援影像與工具設定。',
    MISSING_AUTHORIZED_KEY:'本機橋接尚未找到授權的 gemini_api_key；請設定環境變數或使用啟動程式的私密金鑰輸入。',
    BRIDGE_CALL_BUDGET:'本機 Gemini 橋接的呼叫次數已達上限，實驗已暫停。',
    INVALID_UPSTREAM_ROUTE:'Gemini 橋接拒絕不支援的 API 路徑。',
    UPSTREAM_REDIRECT_REJECTED:'Gemini API 回傳重新導向，橋接已拒絕轉送請求。',
    UPSTREAM_TOO_LARGE:'Gemini API 回覆超過橋接大小限制，這次未執行動作。',
    UPSTREAM_FORMAT:'Gemini API 回傳無法解析的資料，這次未執行動作。',
    UPSTREAM_UNAVAILABLE:'Gemini API 暫時無法連線或服務無法使用，這次未執行動作。'
  });
  const statusCodes=Object.freeze({UNAUTHENTICATED:'INVALID_API_KEY',RESOURCE_EXHAUSTED:'QUOTA_EXCEEDED',NOT_FOUND:'MODEL_UNAVAILABLE',PERMISSION_DENIED:'PERMISSION_DENIED',INVALID_ARGUMENT:'INVALID_REQUEST_FORMAT',UNAVAILABLE:'UPSTREAM_UNAVAILABLE',DEADLINE_EXCEEDED:'UPSTREAM_UNAVAILABLE'});
  async function httpError(response){
    const status=response.status;let error;
    // Error bodies are untrusted. Read only known classification fields, never
    // display raw messages, metadata, URLs or details that may echo credentials.
    try{const data=await response.json();error=record(data?.error)?data.error:null;}catch(_){error=null;}
    if(['BRIDGE_CALL_BUDGET','CALL_BUDGET'].includes(error?.code))return requests.schedulingError(ProviderError,'Gemini',error.code,{status,retryable:false});
    if(status===429){const meta=requests.rateLimitMetadata(response,error,'gemini');return requests.schedulingError(ProviderError,'Gemini',meta.retryable?'RATE_LIMITED':'QUOTA_EXCEEDED',meta);}
    let code='';
    if(Array.isArray(error?.details)&&error.details.slice(0,40).some(detail=>detail?.reason==='API_KEY_INVALID'))code='INVALID_API_KEY';
    else if(typeof error?.code==='string'&&Object.hasOwn(errorMessages,error.code))code=error.code;
    else if(typeof error?.status==='string'&&Object.hasOwn(statusCodes,error.status))code=statusCodes[error.status];
    if(code)return new ProviderError(code,errorMessages[code]);
    return new ProviderError('HTTP_'+status,({
    400:'Gemini 拒絕請求格式，或所選模型不支援影像與工具設定。',
    401:'Gemini API 金鑰驗證失敗。',
    403:'Gemini API 或本機橋接拒絕存取；請檢查金鑰限制及橋接網址。',
    404:'找不到指定 Gemini 模型或本機橋接路徑。',
    429:'Gemini 配額、速率或本機橋接呼叫次數已達上限。',
    503:'尚未找到授權的 Gemini 金鑰，或服務暫時無法使用。'
    })[status]||'Gemini API 回傳 HTTP '+status+'；這次未執行動作。');
  }
  function toolDefinition(name,documentLibrary){
    const tool=shared('toolDefinition',name,documentLibrary);
    return {name:tool.name,description:tool.description,parametersJsonSchema:tool.input_schema};
  }
  function decisionFrom(data,allowed,documentLibrary){
    if(data?.promptFeedback?.blockReason)fail('BLOCKED_RESPONSE','Gemini 未提供可執行的工具決策；這次未執行動作。');
    const candidates=data?.candidates;
    const reject=(issue,details)=>{const diagnostic=shared('rejectionDiagnostic','INVALID_TOOL_RESPONSE',issue,details);fail('INVALID_TOOL_RESPONSE',diagnostic.message,diagnostic);};
    if(!Array.isArray(candidates)||candidates.length!==1)reject('candidate-count',{candidateCount:Array.isArray(candidates)?candidates.length:0});
    if(candidates[0]?.finishReason!=='STOP')reject('stop-reason',{stopReason:candidates[0]?.finishReason,candidateCount:1});
    const parts=candidates[0]?.content?.parts;
    const calls=Array.isArray(parts)?parts.filter(part=>record(part?.functionCall)&&part.thought!==true):[];
    if(calls.length!==1)reject('tool-count',{toolCount:calls.length,stopReason:candidates[0]?.finishReason});
    const call=calls[0].functionCall;
    return shared('validateToolCall',{name:call.name,input:call.args},allowed,documentLibrary);
  }
  function usage(value){
    const out={};
    for(const field of ['promptTokenCount','candidatesTokenCount','totalTokenCount','cachedContentTokenCount','thoughtsTokenCount','toolUsePromptTokenCount']){
      if(Number.isFinite(value?.[field])&&value[field]>=0)out[field]=value[field];
    }
    return out;
  }
  class GeminiAgentProvider {
    #key;#model;#bridge;#maxCalls;#timeoutMs;#calls=0;#active=null;#disposed=false;#scheduler;
    constructor({apiKey,model,bridgeUrl,maxCalls=80,timeoutMs=45000,minIntervalMs=6000,maxRateLimitRetries=2,onRequestStatus}={}){
      this.#bridge=bridgeOf(bridgeUrl);this.#key=this.#bridge?'':keyOf(apiKey);this.#model=modelOf(model);
      if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>500)fail('INVALID_BUDGET','Gemini 呼叫上限必須介於 1 與 500。');
      checkTimeout(timeoutMs);this.#maxCalls=maxCalls;this.#timeoutMs=timeoutMs;
      if(!requests?.ModelRequestScheduler)fail('MISSING_CONTRACT','尚未載入 AI 請求排程器，請重新建置並開啟完整介面。');
      this.#scheduler=new requests.ModelRequestScheduler({minIntervalMs,maxRateLimitRetries,onRequestStatus,makeError:(code,meta)=>requests.schedulingError(ProviderError,'Gemini',code,meta)});
    }
    get calls(){return this.#calls;}get model(){return this.#model;}get mode(){return this.#bridge?'bridge':'direct';}
    get requestStatus(){return this.#scheduler.status;}get requestDiagnostics(){return this.#scheduler.diagnostics;}
    abort(){this.#active?.abort();}
    dispose(){this.#disposed=true;this.abort();this.#key='';}
    async decide(context,frame){
      if(this.#disposed)fail('DISPOSED','Gemini 連線已關閉。');
      if(this.#active)fail('BUSY','上一個 Gemini 請求尚未結束。');
      if(this.#calls>=this.#maxCalls)fail('CALL_BUDGET','已達 Gemini 呼叫次數上限，實驗已暫停。');
      const safe=shared('allowContext',context);
      if(!safe.allowedTools.length)fail('NO_TOOLS','目前沒有開放給 Gemini 的工具。');
      safe.modelRequests={used:this.#calls,limit:this.#maxCalls};
      const evidence=redact(JSON.stringify(safe),this.#key);
      // Each call is a fresh decision. No previous model parts, thought signatures
      // or hidden simulator state are replayed in the next request.
      const body={
        systemInstruction:{parts:[{text:contract.instruction.replace(/tool_use/g,'functionCall')+'\n請只回傳一個 functionCall，不得平行呼叫多個工具。'}]},
        contents:[{role:'user',parts:[{inlineData:{mimeType:'image/png',data:shared('cameraPNG',frame)}},{text:'目前可檢查的狀態（每次請求是獨立決策，以此狀態為準）：\n'+evidence+'\n選擇一個工具並提供完整 args 與 reason；expected 為選填。'}]}],
        tools:[{functionDeclarations:safe.allowedTools.map(name=>toolDefinition(name,safe.documentLibrary))}],
        toolConfig:{functionCallingConfig:{mode:'ANY',allowedFunctionNames:safe.allowedTools.slice()}},
        generationConfig:{candidateCount:1,maxOutputTokens:8192}
      };
      const connection=transport(this.#bridge,this.#key);
      const url=this.#bridge?connection.base+'/generateContent':connection.base+'/models/'+encodeURIComponent(this.#model)+':generateContent';
      const request=this.#bridge?{model:this.#model,...body}:body;
      const controller=new AbortController();this.#active=controller;let responseUsage;
      try{
        const data=await this.#scheduler.run({controller,timeoutMs:this.#timeoutMs,hasBudget:()=>this.#calls<this.#maxCalls,beforeAttempt:()=>{if(this.#calls>=this.#maxCalls)throw requests.schedulingError(ProviderError,'Gemini','CALL_BUDGET');this.#calls++;},perform:async signal=>{
          safe.modelRequests.used=this.#calls-1;
          request.contents[0].parts[1].text='目前可檢查的狀態（每次請求是獨立決策，以此狀態為準）：\n'+redact(JSON.stringify(safe),this.#key)+'\n選擇一個工具並提供完整 args 與 reason；expected 為選填。';
          const response=await global.fetch(url,{method:'POST',headers:connection.headers,body:JSON.stringify(request),signal,credentials:'omit',cache:'no-store',redirect:'error'});
          if(!response.ok)throw await httpError(response);
          try{return await response.json();}catch(_){fail('INVALID_RESPONSE','Gemini 回傳無法解析的資料；這次未執行動作。');}
        }});
        responseUsage=usage(data?.usageMetadata);
        if(controller.signal.aborted||this.#disposed)throw requests.schedulingError(ProviderError,'Gemini','ABORTED');
        const result=decisionFrom(data,safe.allowedTools,safe.documentLibrary);
        if(this.#key&&JSON.stringify(result.args).includes(this.#key))fail('CREDENTIAL_ECHO','外部回覆包含不應出現的認證資料，已拒絕這次決策。');
        result.reason=redact(result.reason,this.#key);result.expected=redact(result.expected,this.#key);
        return {...result,source:'gemini',model:this.#model,usage:usage(data.usageMetadata)};
      }catch(error){
        if(controller.signal.aborted||this.#disposed)throw requests.schedulingError(ProviderError,'Gemini','ABORTED',error?.requestDiagnostic);
        if(error instanceof ProviderError){if(responseUsage)error.usage=responseUsage;throw error;}
        fail('NETWORK_ERROR','無法完成 Gemini 請求；請檢查連線與 API 設定。沒有切換成本機策略。');
      }finally{if(this.#active===controller)this.#active=null;}
    }
    static async listModels(apiKey,{bridgeUrl,signal,timeoutMs=30000}={}){
      checkTimeout(timeoutMs);
      const bridge=bridgeOf(bridgeUrl),key=bridge?'':keyOf(apiKey),connection=transport(bridge,key),controller=new AbortController();
      const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
      const models=new Map(),seen=new Set();let token='';
      try{
        do{
          if(controller.signal.aborted)fail('ABORTED','Gemini 模型清單讀取已取消。');
          const query=new URLSearchParams({pageSize:'100'});if(token)query.set('pageToken',token);
          const response=await global.fetch(connection.base+'/models?'+query,{headers:connection.headers,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
          if(!response.ok)throw await httpError(response);
          const data=await response.json();
          if(!Array.isArray(data?.models))fail('INVALID_MODELS','Gemini 未回傳有效的帳號模型清單。');
          for(const model of data.models){
            if(!Array.isArray(model?.supportedGenerationMethods)||!model.supportedGenerationMethods.includes('generateContent')||typeof model.name!=='string'||!/^models\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(model.name))continue;
            const id=model.name.slice(7);models.set(id,{id,displayName:redact(text(model.displayName)||id,key)});
          }
          if(data.nextPageToken!==undefined&&(typeof data.nextPageToken!=='string'||data.nextPageToken.length>4096))fail('PAGINATION_ERROR','Gemini 模型清單分頁異常。');
          token=data.nextPageToken||'';
          if(token&&(seen.has(token)||seen.size>=30))fail('PAGINATION_ERROR','Gemini 模型清單分頁異常。');
          if(token)seen.add(token);
        }while(token);
        if(controller.signal.aborted)fail('ABORTED','Gemini 模型清單讀取已取消。');
        return [...models.values()];
      }catch(error){
        if(timedOut)fail('TIMEOUT','讀取 Gemini 模型清單逾時。');
        if(controller.signal.aborted)fail('ABORTED','Gemini 模型清單讀取已取消。');
        if(error instanceof ProviderError)throw error;
        fail('NETWORK_ERROR','無法讀取 Gemini 模型清單；請確認本機橋接或 API 連線。');
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    }
  }
  global.GeminiAgentProvider=GeminiAgentProvider;
})(typeof window!=='undefined'?window:globalThis);
