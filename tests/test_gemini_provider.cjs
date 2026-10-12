// Timing/backoff disabled only in these protocol fixtures; V6.3 pacing has dedicated fake-clock coverage.
/* Mock-only contract tests: no environment credential lookup or real API calls. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const sources=['claude-provider.js','gemini-provider.js'].map(file=>fs.readFileSync(path.join(__dirname,'../src',file),'utf8'));
const key='FAKE_TEST_KEY_NO_CREDENTIAL';
const frame={dataURL:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEcAAAAASUVORK5CYII='};
const base={phase:'control',observation:{tip:[10,10],target:[20,20],error:14.14},allowedTools:['observe','probe','stop'],budgets:{actionsUsed:0,maxActions:180,decisionsUsed:0,maxDecisions:300},diagnostics:{secret:'PRIVILEGED_CANARY'},seed:'PRIVILEGED_SEED',joints:'PRIVILEGED_JOINTS'};
const call=(name='observe',args={},extra={})=>({functionCall:{name,args:{args,reason:'依據影像觀察',expected:'取得新量測'}},...extra});
const answer=(name='observe',args={},extra={})=>({candidates:[{finishReason:'STOP',content:{role:'model',parts:[call(name,args)]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:8,totalTokenCount:20,thoughtsTokenCount:2},...extra});
const good=value=>({ok:true,status:200,json:async()=>value});
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(mock){const box={fetch:mock,URL,URLSearchParams,AbortController,setTimeout,clearTimeout};vm.createContext(box);for(const source of sources)vm.runInContext(source,box);return box.GeminiAgentProvider;}
async function rejects(thunk,code){await assert.rejects(thunk,error=>error.name==='GeminiProviderError'&&error.code===code);}
(async()=>{
  const checks=[];let sent;
  let Provider=setup(async(url,options)=>{sent={url,options,body:JSON.parse(options.body)};return good(answer());});
  let provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'models/gemini-mock',maxCalls:2});
  let result=await provider.decide(base,frame);
  assert.equal(result.tool,'observe');assert.equal(result.source,'gemini');assert.equal(result.model,'gemini-mock');assert.equal(result.usage.promptTokenCount,12);assert.equal(result.expectedProvided,true);
  assert.equal(sent.url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-mock:generateContent');
  assert.equal(sent.options.headers['x-goog-api-key'],key);assert(!sent.url.includes(key));assert.equal(sent.options.redirect,'error');
  assert.equal(sent.body.contents.length,1);assert.equal(sent.body.contents[0].role,'user');assert.equal(sent.body.contents[0].parts[0].inlineData.mimeType,'image/png');
  assert.equal(sent.body.generationConfig.candidateCount,1);assert(!Object.hasOwn(sent.body,'model'));
  assert.deepEqual(sent.body.toolConfig,{functionCallingConfig:{mode:'ANY',allowedFunctionNames:['observe','probe','stop']}});
  assert.deepEqual(sent.body.tools[0].functionDeclarations.map(tool=>tool.name),['observe','probe','stop']);
  const schema=sent.body.tools[0].functionDeclarations[1].parametersJsonSchema;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['args','reason']);assert.equal(schema.properties.args.properties.amplitude.maximum,.1);assert.equal(schema.properties.expected.minLength,1);
  assert(!JSON.stringify(sent.body).includes('PRIVILEGED_'));assert(!JSON.stringify(sent.body).includes(key));assert(!JSON.stringify(provider).includes(key));
  checks.push('official generateContent request: one user image/context, parametersJsonSchema, ANY, key only in header');
  await provider.decide(base,frame);await rejects(()=>provider.decide(base,frame),'CALL_BUDGET');assert.equal(provider.calls,2);
  provider.dispose();await rejects(()=>provider.decide(base,frame),'DISPOSED');
  checks.push('exact call budget and disposal');

  const front={phase:'onboarding',allowedTools:['write_driver','stop'],manual:{documentId:'VLAB-P2',connection:{transport:'serial',baudRate:115200,protocol:'vlab-p2-json/1'},protocol:{command:'XY_COMMAND',reply:'XY_REPLY',liftCommand:'LIFT_COMMAND',liftReply:'LIFT_REPLY',gripCommand:'GRIP_COMMAND',gripReply:'GRIP_REPLY',limits:{channels:2,min:-.1,max:.1,units:'relative'}},manipulation:{lift:['up','down'],grip:['open','closed'],constraints:'Lower before close'},driverContract:'encode(command) and decode(rawReply)',sampleDriverSource:'COMPLETE_DRIVER',secret:'PRIVILEGED_MANUAL'},inventory:[{endpointId:'sim-serial-arm',deviceModel:'VLAB-P2',private:'PRIVILEGED_INVENTORY'}],driverTests:{passed:false,tests:[{name:'reply',ok:false,error:'Wrong return'}]},handshake:{ok:true,capabilities:{xy:'relative-unknown-mapping',lift:['up','down'],grip:['open','closed'],hidden:'PRIVILEGED_CAPS'}},diagnostics:base.diagnostics};
  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('write_driver',{source:'function encode(command){return JSON.stringify(command)+"\\n";} function decode(reply){return JSON.parse(reply);}'}));});
  result=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(front,frame);
  assert.equal(result.tool,'write_driver');assert(result.args.source.includes('function encode'));
  let evidence=sent.contents[0].parts[1].text;
  for(const marker of ['vlab-p2-json/1','XY_COMMAND','LIFT_COMMAND','LIFT_REPLY','GRIP_COMMAND','GRIP_REPLY','COMPLETE_DRIVER','Lower before close','Wrong return','relative-unknown-mapping'])assert(evidence.includes(marker));
  assert(!evidence.includes('PRIVILEGED_'));
  checks.push('onboarding complete manual and failed driver test evidence; private fields removed');

  const mission={phase:'mission',allowedTools:['lift','inspect_scene','stop'],observed:{tip:[100,80],object:[101,81],destination:[200,160],objectPixels:81,destinationPixels:160,raisedOffsetError:1.4,held:'PRIVILEGED_HELD'},actuator:{lift:'down',gripper:'closed'},taskProgress:{phase:'raise-object',objectDetected:true,atObject:true,graspVerified:false,coMotionVerified:false,attempts:1,placementError:null},lastResult:{tool:'grip',ok:true,summary:'已閉合，尚未驗證'},budgets:base.budgets,nextSuggested:{tool:'PRIVILEGED_OFFLINE_POLICY'},diagnostics:base.diagnostics};
  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('lift',{position:'up'}));});
  result=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(mission,frame);
  assert.equal(result.tool,'lift');assert.equal(result.args.position,'up');
  evidence=sent.contents[0].parts[1].text;assert(evidence.includes('raisedOffsetError'));assert(evidence.includes('coMotionVerified'));assert(!evidence.includes('PRIVILEGED_'));assert(!evidence.includes('nextSuggested'));
  assert.deepEqual(sent.tools[0].functionDeclarations.map(tool=>tool.name),['inspect_scene','lift','stop']);
  for(const [name,args] of [['inspect_scene',{}],['select_goal',{target:'object'}],['select_goal',{target:'destination'}],['select_goal',{target:'clearance'}],['grip',{state:'open'}],['grip',{state:'closed'}],['verify_grasp',{}],['verify_place',{}]]){
    Provider=setup(async()=>good(answer(name,args)));
    const decision=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide({...mission,allowedTools:[name]},frame);
    assert.equal(decision.tool,name);assert.deepEqual(clone(decision.args),args);
  }
  checks.push('all mission tool contracts; only observed pixel/ack evidence exposed');

  for(const [response,context,code] of [
    [answer('probe',{channel:0,direction:1,amplitude:.11}),base,'INVALID_ARGUMENTS'],
    [answer('observe',{url:'https://unexpected.invalid'}),base,'INVALID_ARGUMENTS'],
    [answer('move',{scale:.7}),base,'INVALID_DECISION'],
    [answer('lift',{position:'middle'}),mission,'INVALID_ARGUMENTS'],
    [answer('verify_place',{success:true}),{...mission,allowedTools:['verify_place']},'INVALID_ARGUMENTS'],
    [{candidates:[{finishReason:'STOP',content:{parts:[call(),call()]}}]},base,'INVALID_TOOL_RESPONSE'],
    [{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[call()]}}]},base,'INVALID_TOOL_RESPONSE'],
    [{candidates:[{finishReason:'STOP',content:{parts:[{text:'Call observe'}]}}]},base,'INVALID_TOOL_RESPONSE'],
    [{candidates:[{finishReason:'STOP',content:{parts:[call('observe',{}, {thought:true})]}}]},base,'INVALID_TOOL_RESPONSE'],
    [{candidates:[...answer().candidates,...answer().candidates]},base,'INVALID_TOOL_RESPONSE'],
    [{promptFeedback:{blockReason:'SAFETY'}},base,'BLOCKED_RESPONSE']
  ]){Provider=setup(async()=>good(response));await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(context,frame),code);}
  checks.push('reject malformed, disallowed, multiple, truncated, text-only, thought-only and blocked decisions');

  const envelope=(input,name='observe')=>answer(name,{}, {candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name,args:input}},{thought:true,text:'PRIVATE_THOUGHT_CANARY'}]}}]});
  const validInput={args:{},reason:'觀察畫面',expected:'取得新量測'};
  for(const [name,args,context] of [
    ['read_manual',{documentId:'VLAB-P2'},{phase:'onboarding',allowedTools:['read_manual']}],
    ['probe',{channel:0,direction:1,amplitude:.045},base],
    ['lift',{position:'up'},mission]
  ]) {
    let fetches=0;Provider=setup(async()=>{fetches++;return good(envelope({args,reason:'依據目前證據'},name));});
    provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'});result=await provider.decide(context,frame);
    assert.equal(result.tool,name);assert.deepEqual(clone(result.args),args);
    assert.equal(result.expected,'');assert.equal(result.expectedProvided,false);
    assert.equal(fetches,1);assert.equal(provider.calls,1);
  }
  for(const [input,name,code] of [
    [{args:{channel:0,direction:1,amplitude:.11},reason:'試動'},'probe','INVALID_ARGUMENTS'],
    [{args:{channel:0,direction:1},reason:'試動'},'probe','INVALID_ARGUMENTS'],
    [{args:{}},'observe','INVALID_DECISION'],
    [{args:{},reason:'觀察',expectedProvided:false},'observe','INVALID_DECISION'],
    ...['', '   ',null,8,'x'.repeat(801)].map(expected=>[{...validInput,expected},'observe','INVALID_DECISION'])
  ]) {
    Provider=setup(async()=>good(envelope(input,name)));
    await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(base,frame),code);
  }
  checks.push('missing optional expected is preserved as absent in onboarding/probe/mission with one request; command limits, required reason, extra fields and supplied expected remain strict');
  for(const [response,context,code,issue,detail] of [
    [envelope(validInput,'PRIVATE_TOOL_'+key),base,'INVALID_DECISION','invalid-tool',{receivedTool:'[unknown]'}],
    [envelope({args:{},expected:'量測',PRIVATE_FIELD_CANARY:key}),base,'INVALID_DECISION','invalid-envelope',{missingFields:['reason'],extraFieldCount:1}],
    [envelope({...validInput,reason:'   '}),base,'INVALID_DECISION','invalid-reason',{invalidFields:['reason'],receivedLength:3}],
    [envelope({...validInput,expected:{secret:key}}),base,'INVALID_DECISION','invalid-expected',{invalidFields:['expected'],receivedType:'object'}],
    [answer('probe',{channel:0,direction:1,amplitude:key}),base,'INVALID_ARGUMENTS','invalid-arguments',{invalidFields:['amplitude']}],
    [answer('write_driver',{source:'PRIVATE_DRIVER_CANARY'+key+'x'.repeat(30001)}),front,'INVALID_ARGUMENTS','invalid-arguments',{invalidFields:['source']}],
    [answer('observe',{}, {candidates:[{finishReason:'STOP',content:{parts:[call(),call()]}}]}),base,'INVALID_TOOL_RESPONSE','tool-count',{toolCount:2}],
    [answer('observe',{}, {candidates:[...answer().candidates,...answer().candidates]}),base,'INVALID_TOOL_RESPONSE','candidate-count',{candidateCount:2}],
    [answer('observe',{}, {candidates:[{finishReason:key,content:{parts:[call()]}}]}),base,'INVALID_TOOL_RESPONSE','stop-reason',{stopReason:'[unknown]'}]
  ]) {
    response.usageMetadata={...response.usageMetadata,cachedContentTokenCount:-1,raw:'PRIVATE_USAGE_'+key};
    let fetches=0;Provider=setup(async()=>{fetches++;return good(response);});provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'});
    await assert.rejects(()=>provider.decide(context,frame),error=>{
      assert.equal(error.name,'GeminiProviderError');assert.equal(error.code,code);assert.equal(error.diagnostic.issue,issue);assert.equal(error.diagnostic.code,code);
      for(const [field,value] of Object.entries(detail))assert.deepEqual(clone(error.diagnostic[field]),value);
      assert.equal(error.usage.promptTokenCount,12);assert.equal(error.usage.cachedContentTokenCount,undefined);assert(!JSON.stringify(error).includes(key));assert(!JSON.stringify(error).includes('PRIVATE_'));return true;
    });
    assert.equal(fetches,1);assert.equal(provider.calls,1);
  }
  checks.push('shared and native rejection diagnostics preserve exact issue plus usage; no raw output, key, thoughts or hidden retries');

  for(const context of [base,front,mission]) {
    Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('stop'));});
    await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide({...context,decisionFeedback:{code:'INVALID_DECISION',issue:'invalid-envelope',message:'PRIVATE_MESSAGE_CANARY',attempt:1,maxCorrections:2,allowedTools:['stop','PRIVATE_TOOL_CANARY'],diagnostic:{receivedTool:'PRIVATE_TOOL_CANARY',missingFields:['reason','PRIVATE_FIELD_CANARY'],extraFieldCount:1,raw:'PRIVATE_OUTPUT_CANARY'},raw:'PRIVATE_EXTRA_CANARY'}},frame);
    evidence=sent.contents[0].parts[1].text;
    assert(evidence.includes('decisionFeedback'));assert(evidence.includes('invalid-envelope'));assert(evidence.includes('maxCorrections'));assert(!evidence.includes('PRIVATE_'));
    assert(sent.systemInstruction.parts[0].text.includes('沒有執行任何動作'));
  }
  checks.push('corrective feedback allowlist works across all three phases without replaying rejected model output');

  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);const response=answer();response.candidates[0].content.parts=[{thought:true,text:'PRIVATE_THOUGHT'},call()];response.candidates[0].content.parts[1].thoughtSignature='PRIVATE_SIGNATURE';response.candidates[0].content.parts[1].functionCall.args.reason=key;return good(response);});
  provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'});result=await provider.decide(base,frame);
  assert(!JSON.stringify(result).includes(key));assert(!JSON.stringify(result).includes('PRIVATE_'));
  await provider.decide(base,frame);assert.equal(sent.contents.length,1);assert(!JSON.stringify(sent).includes('PRIVATE_'));
  Provider=setup(async()=>good(answer('write_driver',{source:key})));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(front,frame),'CREDENTIAL_ECHO');
  checks.push('no thought/signature export or history replay; credential echo redaction and rejection');

  Provider=setup(async()=>({ok:false,status:403,json:async()=>{throw new Error(key);}}));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(base,frame),'HTTP_403');
  Provider=setup(async()=>{throw new Error('request key='+key);});
  try{await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(base,frame);assert.fail('must reject');}catch(error){assert.equal(error.code,'NETWORK_ERROR');assert(!error.message.includes(key));}
  Provider=setup(async()=>({ok:true,json:async()=>{throw new Error(key);}}));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(base,frame),'INVALID_RESPONSE');
  Provider=setup((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error(key)))));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock',timeoutMs:5}).decide(base,frame),'TIMEOUT');
  provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'});let pending=provider.decide(base,frame);await rejects(()=>provider.decide(base,frame),'BUSY');provider.abort();await rejects(()=>pending,'ABORTED');
  checks.push('sanitized failures; no fallback; timeout, busy and cancellation');

  for(const [status,error,code] of [
    [400,{code:400,status:'INVALID_ARGUMENT',message:'API key not valid: '+key,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_INVALID',metadata:{secret:key}}]},'INVALID_API_KEY'],
    [400,{code:'INVALID_API_KEY',message:key},'INVALID_API_KEY'],
    [503,{code:'MISSING_AUTHORIZED_KEY',message:key},'MISSING_AUTHORIZED_KEY'],
    [429,{code:'BRIDGE_CALL_BUDGET',message:key},'BRIDGE_CALL_BUDGET'],
    [429,{status:'RESOURCE_EXHAUSTED',message:key},'RATE_LIMITED'],
    [404,{status:'NOT_FOUND',message:key},'MODEL_UNAVAILABLE'],
    [403,{code:'PERMISSION_DENIED',message:key},'PERMISSION_DENIED'],
    [400,{status:'INVALID_ARGUMENT',message:key},'INVALID_REQUEST_FORMAT'],
    [400,{code:key,status:key,message:'API_KEY_INVALID '+key,details:[{reason:key}]},'HTTP_400']
  ]){
    Provider=setup(async()=>({ok:false,status,json:async()=>({error})}));
    for(const action of [()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'gemini-mock'}).decide(base,frame),()=>Provider.listModels('',{bridgeUrl:'http://127.0.0.1:8767'})]){
      await assert.rejects(action,failure=>failure.name==='GeminiProviderError'&&failure.code===code&&!failure.message.includes(key)&&!JSON.stringify(failure).includes(key));
    }
  }
  checks.push('typed bridge/Google errors distinguish HTTP 400 invalid key and HTTP 503 missing key in decide/listModels; no raw error echo');

  let page=0;
  Provider=setup(async(url,options)=>{
    assert(!options.headers['x-goog-api-key']);assert.equal(options.headers['X-Vlab-Bridge'],'1');assert(url.startsWith('http://127.0.0.1:8766/api/gemini/models?'));
    const query=new URL(url).searchParams;assert.equal(query.get('pageSize'),'100');page++;
    if(page===1)return good({models:[{name:'models/gemini-mock-a',displayName:'A',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'abc/+=='});
    assert.equal(query.get('pageToken'),'abc/+==');
    return good({models:[{name:'models/gemini-mock-b',displayName:'B',supportedGenerationMethods:['generateContent']},{name:'models/../../bad',supportedGenerationMethods:['generateContent']}]});
  });
  const models=await Provider.listModels('',{bridgeUrl:'http://127.0.0.1:8766'});assert.equal(models.length,2);assert.equal(models[1].id,'gemini-mock-b');
  Provider=setup(async()=>good({models:[],nextPageToken:'loop'}));
  await rejects(()=>Provider.listModels(key),'PAGINATION_ERROR');
  Provider=setup(async(url,options)=>{assert.equal(options.headers['x-goog-api-key'],key);return good({models:[{name:'models/gemini-mock',displayName:key,supportedGenerationMethods:['generateContent']}]});});
  assert(!(JSON.stringify(await Provider.listModels(key))).includes(key));
  checks.push('paginated live-account model schema; generateContent filter; pagination loop guard');

  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);assert.equal(url,'http://127.0.0.1:8766/api/gemini/generateContent');assert(!JSON.stringify(options).includes(key));assert.equal(options.headers['X-Vlab-Bridge'],'1');return good(answer());});
  provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,bridgeUrl:'http://127.0.0.1:8766',model:'gemini-mock'});
  await provider.decide(base,frame);
  assert.equal(sent.model,'gemini-mock');assert(sent.contents);assert.equal(provider.calls,1);
  for(const bridgeUrl of ['https://remote.invalid','http://localhost:8766','http://127.0.0.1:8766/path','http://a:b@127.0.0.1:8766','http://127.0.0.1:8766/?a=1'])assert.throws(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,bridgeUrl,model:'gemini-mock'}),error=>error.code==='INVALID_BRIDGE');
  assert.throws(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'../../remote'}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:'',model:'gemini-mock'}),error=>error.code==='MISSING_KEY');
  checks.push('loopback bridge request envelope; no credential transfer; strict model and bridge inputs');
  const report={scope:'mock-only; no live Gemini request or credential lookup',passed:true,checks};
  fs.mkdirSync(path.join(__dirname,'../validation'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../validation/gemini-provider-mock.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
