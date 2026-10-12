// Timing/backoff disabled only in these protocol fixtures; V6.3 pacing has dedicated fake-clock coverage.
/* Mock-only contract checks. No key lookup and no network requests. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/claude-provider.js'),'utf8');
const key='FAKE_TEST_KEY_NO_CREDENTIAL';
const frame={dataURL:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEcAAAAASUVORK5CYII='};
const base={observation:{tip:[10,10],target:[20,20],error:14.14},allowedTools:['observe','probe','stop'],budgets:{actionsUsed:0,maxActions:180,decisionsUsed:0,maxDecisions:300},diagnostics:{secret:'PRIVILEGED_CANARY'}};
const answer=(name='observe',args={},extra={})=>({stop_reason:'tool_use',content:[{type:'tool_use',id:'mock_tool',name,input:{args,reason:'依據影像觀察',expected:'取得量測'}}],usage:{input_tokens:12,output_tokens:8},...extra});
function setup(mock){const box={fetch:mock,URL,URLSearchParams,AbortController,setTimeout,clearTimeout};vm.createContext(box);vm.runInContext(source,box);return box.ClaudeAgentProvider;}
const good=v=>({ok:true,status:200,json:async()=>v});
async function rejects(call,code){await assert.rejects(call,e=>e.code===code);}
(async()=>{
  const counts=[];
  let sent;
  let Provider=setup(async(url,options)=>{sent={url,options,body:options.body&&JSON.parse(options.body)};return good(answer());});
  let provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1',maxCalls:2});
  let result=await provider.decide(base,frame);
  assert.equal(result.source,'claude');assert.equal(result.tool,'observe');assert.equal(result.usage.input_tokens,12);assert.equal(result.expectedProvided,true);
  assert.equal(sent.url,'https://api.anthropic.com/v1/messages');
  assert.equal(sent.options.headers['x-api-key'],key);assert.equal(sent.options.headers['anthropic-dangerous-direct-browser-access'],'true');
  assert.deepEqual(sent.body.tool_choice,{type:'auto',disable_parallel_tool_use:true});
  assert.equal(sent.body.messages[0].content[0].source.media_type,'image/png');
  assert(!JSON.stringify(sent.body).includes('PRIVILEGED_CANARY'));
  assert(!JSON.stringify(sent.body).includes(key));assert(!JSON.stringify(provider).includes(key));
  assert.deepEqual(sent.body.tools.map(t=>t.name),['observe','probe','stop']);
  assert.deepEqual(sent.body.tools[1].input_schema.required,['args','reason']);
  assert.equal(sent.body.tools[1].input_schema.properties.expected.minLength,1);
  counts.push('real Messages API shape, image, one-tool request, allowlist, private key');
  await provider.decide(base,frame);await rejects(()=>provider.decide(base,frame),'CALL_BUDGET');assert.equal(provider.calls,2);
  provider.dispose();await rejects(()=>provider.decide(base,frame),'DISPOSED');
  counts.push('call budget and disposal');

  const front={phase:'onboarding',allowedTools:['write_driver','stop'],manual:{documentId:'VLAB-P2',connection:{transport:'serial',baudRate:115200,protocol:'vlab-p2-json/1'},protocol:{command:'{"op":"step","channels":[0.02,0]}\n',reply:'{"ok":true,"accepted":[0.02,0],"limited":false}\n',limits:{channels:2,min:-.1,max:.1,units:'relative'}},driverContract:'encode(command) and decode(rawReply)',sampleDriver:'function encode(command) { return command; }',secret:'PRIVILEGED_MANUAL_CANARY'},inventory:[{endpointId:'sim-serial-arm',deviceModel:'VLAB-P2',private:'PRIVILEGED_INVENTORY_CANARY'}],driverSource:'function encode(x){}',driverTests:{passed:false,tests:[{name:'reply',ok:false,error:'Wrong return'}]},diagnostics:{secret:'PRIVILEGED_CANARY'}};
  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('write_driver',{source:'function encode(c){return JSON.stringify({op:"step",channels:c})+"\\n";} function decode(r){const x=JSON.parse(r);return {applied:x.accepted,limited:x.limited};}'}));});
  provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'});result=await provider.decide(front,frame);
  assert.equal(result.tool,'write_driver');assert(result.args.source.includes('function encode'));
  const text=sent.messages[0].content[1].text;assert(text.includes('driverContract'));assert(text.includes('vlab-p2-json/1'));assert(text.includes('Wrong return'));
  assert(!text.includes('PRIVILEGED_'));counts.push('complete manual preserved and privileged front fields omitted');

  const mission={phase:'mission',allowedTools:['lift','inspect_scene','stop'],observed:{tip:[100,80],object:[101,81],destination:[200,160],objectPixels:81,destinationPixels:160,raisedOffsetError:1.4,held:'PRIVILEGED_HELD_CANARY'},actuator:{lift:'down',gripper:'closed'},taskProgress:{phase:'raise-object',objectDetected:true,atObject:true,graspVerified:false,coMotionVerified:false,atDestination:false,released:false,cleared:false,completed:false,attempts:1,placementError:null},lastResult:{tool:'grip',ok:true,summary:'已閉合，尚未驗證'},budgets:base.budgets,nextSuggested:{tool:'PRIVILEGED_OFFLINE_POLICY'},diagnostics:{truth:'PRIVILEGED_MISSION_CANARY'}};
  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('lift',{position:'up'}));});
  result=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(mission,frame);
  assert.equal(result.tool,'lift');assert.equal(result.args.position,'up');
  let evidence=sent.messages[0].content[1].text;
  assert(evidence.includes('simulated-pick-place'));assert(evidence.includes('raisedOffsetError'));assert(evidence.includes('coMotionVerified'));assert(!evidence.includes('PRIVILEGED_'));assert(!evidence.includes('nextSuggested'));
  assert.deepEqual(sent.tools.map(t=>t.name),['inspect_scene','lift','stop']);
  for(const [name,args] of [['inspect_scene',{}],['select_goal',{target:'object'}],['select_goal',{target:'destination'}],['select_goal',{target:'clearance'}],['grip',{state:'open'}],['grip',{state:'closed'}],['verify_grasp',{}],['verify_place',{}]]) {
    Provider=setup(async()=>good(answer(name,args)));
    const r=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide({...mission,allowedTools:[name]},frame);
    assert.equal(r.tool,name);assert.deepEqual(JSON.parse(JSON.stringify(r.args)),args);
  }
  for(const [name,args] of [['lift',{position:'middle'}],['grip',{state:'grabbed'}],['select_goal',{target:'truth'}],['verify_place',{success:true}]]) {
    Provider=setup(async()=>good(answer(name,args)));
    await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide({...mission,allowedTools:[name]},frame),'INVALID_ARGUMENTS');
  }
  counts.push('mission image evidence, actuator acknowledgements, strict tool enum/shape, no hidden state or offline policy');

  Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('handshake',{}));});
  await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide({...front,allowedTools:['handshake'],manual:{...front.manual,manipulation:{lift:['up','down'],grip:['open','closed'],constraints:'Lower before close'},protocol:{...front.manual.protocol,liftCommand:'LIFT_WIRE_CANARY',liftReply:'LIFT_REPLY_CANARY',gripCommand:'GRIP_WIRE_CANARY',gripReply:'GRIP_REPLY_CANARY'},sampleDriverSource:'COMPLETE_DRIVER_CANARY'},handshake:{ok:true,capabilities:{xy:'relative-unknown-mapping',lift:['up','down'],grip:['open','closed'],hidden:'PRIVILEGED_CAPS_CANARY'}}},frame);
  evidence=sent.messages[0].content[1].text;
  for(const marker of ['LIFT_WIRE_CANARY','LIFT_REPLY_CANARY','GRIP_WIRE_CANARY','GRIP_REPLY_CANARY','COMPLETE_DRIVER_CANARY','relative-unknown-mapping','Lower before close'])assert(evidence.includes(marker));
  assert(!evidence.includes('PRIVILEGED_CAPS_CANARY'));counts.push('complete XY/lift/grip manual and handshake capabilities preserved');

  for(const [response,code] of [
    [answer('probe',{channel:0,direction:1,amplitude:.11}),'INVALID_ARGUMENTS'],
    [answer('move',{scale:.7}),'INVALID_DECISION'],
    [answer('observe',{url:'https://not-allowed.example'}),'INVALID_ARGUMENTS'],
    [answer('observe',{}, {content:[...answer().content,...answer().content]}),'INVALID_TOOL_RESPONSE'],
    [answer('observe',{}, {stop_reason:'max_tokens'}),'INVALID_TOOL_RESPONSE'],
    [answer('observe',{}, {stop_reason:'end_turn',content:[{type:'text',text:'Use observe'}]}),'INVALID_TOOL_RESPONSE']
  ]){Provider=setup(async()=>good(response));await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame),code);}
  Provider=setup(async()=>good(answer('read_manual',{documentId:'VLAB-P2'})));
  assert.equal((await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide({phase:'onboarding',allowedTools:['read_manual']},frame)).tool,'read_manual');
  counts.push('reject multiple/text/truncated/unavailable/out-of-range calls; accept manual tool');

  const envelope=(input,name='observe')=>answer(name,{}, {content:[{type:'tool_use',name,input},{type:'thinking',thinking:'PRIVATE_THOUGHT_CANARY'}]});
  const validInput={args:{},reason:'觀察畫面',expected:'取得新量測'};
  for(const [name,args,context] of [
    ['read_manual',{documentId:'VLAB-P2'},{phase:'onboarding',allowedTools:['read_manual']}],
    ['read_manual',{documentId:'VLAB-G3'},{phase:'onboarding',allowedTools:['read_manual']}],
    ['write_controller',{source:'function control(state){return {action:"verify"};}'},{phase:'onboarding',allowedTools:['write_controller'],controllerMode:'generated'}],
    ['test_controller',{},{phase:'onboarding',allowedTools:['test_controller'],controllerMode:'generated'}],
    ['probe',{channel:0,direction:1,amplitude:.045},base],
    ['lift',{position:'up'},mission]
  ]) {
    let fetches=0;Provider=setup(async()=>{fetches++;return good(envelope({args,reason:'依據目前證據'},name));});
    provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'});result=await provider.decide(context,frame);
    assert.equal(result.tool,name);assert.deepEqual(JSON.parse(JSON.stringify(result.args)),args);
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
    await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame),code);
  }
  counts.push('missing optional expected is preserved as absent in onboarding/probe/mission with one request; command limits, required reason, extra fields and supplied expected remain strict');
  for(const [response,context,code,issue,detail] of [
    [envelope(validInput,'PRIVATE_TOOL_'+key),base,'INVALID_DECISION','invalid-tool',{receivedTool:'[unknown]'}],
    [envelope({args:{},expected:'量測',PRIVATE_FIELD_CANARY:key}),base,'INVALID_DECISION','invalid-envelope',{missingFields:['reason'],extraFieldCount:1}],
    [envelope({...validInput,reason:'   '}),base,'INVALID_DECISION','invalid-reason',{invalidFields:['reason'],receivedLength:3}],
    [envelope({...validInput,expected:{secret:key}}),base,'INVALID_DECISION','invalid-expected',{invalidFields:['expected'],receivedType:'object'}],
    [answer('probe',{channel:0,direction:1,amplitude:key}),base,'INVALID_ARGUMENTS','invalid-arguments',{invalidFields:['amplitude']}],
    [answer('write_driver',{source:'PRIVATE_DRIVER_CANARY'+key+'x'.repeat(30001)}),front,'INVALID_ARGUMENTS','invalid-arguments',{invalidFields:['source']}],
    [answer('observe',{}, {content:[...answer().content,...answer().content]}),base,'INVALID_TOOL_RESPONSE','tool-count',{toolCount:2}],
    [answer('observe',{}, {stop_reason:key}),base,'INVALID_TOOL_RESPONSE','stop-reason',{stopReason:'[unknown]'}]
  ]) {
    response.usage={...response.usage,cache_read_input_tokens:-1,raw:'PRIVATE_USAGE_'+key};
    let fetches=0;Provider=setup(async()=>{fetches++;return good(response);});provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'});
    await assert.rejects(()=>provider.decide(context,frame),error=>{
      assert.equal(error.code,code);assert.equal(error.diagnostic.issue,issue);assert.equal(error.diagnostic.code,code);
      for(const [field,value] of Object.entries(detail))assert.deepEqual(JSON.parse(JSON.stringify(error.diagnostic[field])),value);
      assert.equal(error.usage.input_tokens,12);assert.equal(error.usage.cache_read_input_tokens,undefined);assert(!JSON.stringify(error).includes(key));assert(!JSON.stringify(error).includes('PRIVATE_'));
      return true;
    });
    assert.equal(fetches,1);assert.equal(provider.calls,1);
  }
  counts.push('typed rejection diagnostics identify exact contract branch; usage retained; no raw fields, driver, thoughts, key or hidden retries');

  for(const context of [base,front,mission]) {
    Provider=setup(async(url,options)=>{sent=JSON.parse(options.body);return good(answer('stop'));});
    await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide({...context,decisionFeedback:{code:'INVALID_DECISION',issue:'invalid-envelope',message:'PRIVATE_MESSAGE_CANARY',attempt:1,maxCorrections:2,allowedTools:['stop','PRIVATE_TOOL_CANARY'],diagnostic:{receivedTool:'PRIVATE_TOOL_CANARY',missingFields:['reason','PRIVATE_FIELD_CANARY'],extraFieldCount:1,raw:'PRIVATE_OUTPUT_CANARY'},raw:'PRIVATE_EXTRA_CANARY'}},frame);
    evidence=sent.messages[0].content[1].text;
    assert(evidence.includes('decisionFeedback'));assert(evidence.includes('invalid-envelope'));assert(evidence.includes('maxCorrections'));assert(!evidence.includes('PRIVATE_'));
    assert(sent.system.includes('沒有執行任何動作'));assert(sent.system.includes('不要為了修正格式而重置設備'));
  }
  counts.push('sanitized corrective feedback reaches onboarding, XY control and mission without replaying rejected model output');

  Provider=setup(async()=>good(answer('observe',{}, {content:[{type:'thinking',thinking:'not reportable'},{type:'tool_use',name:'observe',input:{args:{},reason:key,expected:'觀察'}}]})));
  result=await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame);
  assert(!JSON.stringify(result).includes(key));assert(!JSON.stringify(result).includes('not reportable'));counts.push('credential echo redaction and no thinking export');

  Provider=setup(async()=>({ok:false,status:401,json:async()=>{throw new Error(key);}}));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame),'HTTP_401');
  Provider=setup(async()=>{throw new Error('request key='+key);});
  try{await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame);}catch(e){assert.equal(e.code,'NETWORK_ERROR');assert(!e.message.includes(key));}
  Provider=setup(async()=>({ok:true,json:async()=>{throw new Error(key);}}));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'}).decide(base,frame),'INVALID_RESPONSE');
  Provider=setup((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error(key)))));
  await rejects(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1',timeoutMs:5}).decide(base,frame),'TIMEOUT');
  provider=new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,model:'claude-mock-1'});const pending=provider.decide(base,frame);provider.abort();await rejects(()=>pending,'ABORTED');
  counts.push('sanitized HTTP/network failures, timeout and user cancellation');

  let page=0;
  Provider=setup(async(url,options)=>{assert(!options.headers['x-api-key']);assert.equal(options.headers['X-Vlab-Bridge'],'1');assert(url.startsWith('http://127.0.0.1:8766/api/claude/models?'));page++;return good(page===1?{data:[{id:'claude-mock-a',display_name:'A'}],has_more:true,last_id:'claude-mock-a'}:{data:[{id:'claude-mock-b',display_name:'B'}],has_more:false,last_id:'claude-mock-b'});});
  const models=await Provider.listModels('',{bridgeUrl:'http://127.0.0.1:8766'});assert.equal(models.length,2);assert.equal(models[1].id,'claude-mock-b');
  assert.throws(()=>new Provider({minIntervalMs:0,maxRateLimitRetries:0,bridgeUrl:'https://remote.invalid',model:'claude-mock-1'}),e=>e.code==='INVALID_BRIDGE');
  Provider=setup(async(url,options)=>{assert.equal(url,'http://127.0.0.1:8766/api/claude/messages');assert(!JSON.stringify(options).includes(key));return good(answer());});
  await new Provider({minIntervalMs:0,maxRateLimitRetries:0,apiKey:key,bridgeUrl:'http://127.0.0.1:8766',model:'claude-mock-1'}).decide(base,frame);
  counts.push('account model pagination and loopback bridge without credential transfer');
  const report={scope:'mock-only; no live Claude request',passed:true,checks:counts};
  fs.mkdirSync(path.join(__dirname,'../validation'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../validation/claude-provider-mock.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
