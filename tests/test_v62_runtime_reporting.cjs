'use strict';
// Focused fault-injection integration: production controller/engine/report code.
// Only image acquisition, worker transport and actuator outcomes are fixtures.
// No browser, model API, credentials, network, or complete pick/place suite.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const sandbox=vm.createContext({});
for(const file of ['controller.js','agent-core.js','engine.js','onboarding.js','pick-place.js']){
  vm.runInContext(fs.readFileSync(path.join(root,'src',file),'utf8'),sandbox,{filename:file});
}
const plain=value=>JSON.parse(JSON.stringify(value));
function frame(tipX=5){
  const width=40,height=24,pixels=new Uint8ClampedArray(width*height*4);
  for(const [x0,y0,color] of [[tipX,4,[30,220,210]],[28,16,[230,60,180]]]){
    for(let y=y0;y<y0+4;y++)for(let x=x0;x<x0+4;x++)pixels.set([...color,255],(y*width+x)*4);
  }
  return {width,height,pixels};
}
function diagnostic(operation='encode',phase='startup'){
  return {operation,phase,
    requestId:11,attempt:phase==='startup'?2:1,elapsedMs:5000,totalElapsedMs:phase==='startup'?5000:5007,startupElapsedMs:phase==='startup'?null:7,deadlineMs:5000,
    retryable:false,retryCount:phase==='startup'?1:0};
}
const errorCode=detail=>detail.phase==='startup'?'DRIVER_STARTUP_TIMEOUT':'DRIVER_EXECUTION_TIMEOUT';
function runtimeError(detail){return Object.assign(new Error(`${errorCode(detail)}: waiting deadline expired`),{code:errorCode(detail),diagnostic:plain(detail)});}
function makeNavigation(actuator){
  let calls=0,transmissions=0;
  const camera=()=>frame(5+transmissions),core=new sandbox.AgentCore();core.observe(camera());
  const provider={calls:0,model:'mock-runtime-report',async decide(){this.calls++;return {
    tool:'probe',args:{channel:0,direction:1,amplitude:.045},source:'claude',reason:'Bounded probe.',expected:'Observe motion.'
  };}};
  const engine=new sandbox.AutonomousEngine({strategy:'claude',provider,challenge:false,recordFrames:false,
    actuator:async command=>{calls++;return actuator(command,()=>transmissions++);},frameGetter:camera});
  Object.assign(engine,{
    _agent:{async call(op,data){
      if(op==='prepare')return core.prepare(data.decision,data.strategy);
      if(op==='outcome')return core.outcome(data);
      if(op==='refresh'){core.observe(data);return core.context();}
      throw new Error(`Unexpected worker fixture operation: ${op}`);
    }},_plant:{diagnostics:()=>({target:[29.5,17.5]})},_ctx:core.context(),_frame:camera(),
    _state:{done:false},_proposal:null,_mode:'decide',_changed:false,
    _decisionRecovery:new sandbox.VlabDecisionRecovery(),_actionCount:0,_probeCount:0,_recalibrations:0,
    _decisionCount:0,_episodeDecisions:0,_episodeActions:0,_sentCount:0,_unconfirmedCount:0,
    _modelSeen:false,_checkpoints:{firstReach:null,changed:false,preChangeMismatch:false,mismatchSeen:false,recovered:null}
  });
  return {engine,core,provider,counts:()=>({calls,transmissions})};
}
async function makeMission(actuator){
  let calls=0,modelCalls=0,transmissions=0;
  const mission=new sandbox.PickPlaceController({seed:42,strategy:'claude',maxActions:180,
    provider:{calls:0,async decide(){modelCalls++;throw new Error('Stopped task must not request another decision.');}},
    plant:{diagnostics:()=>({})},frameGetter:()=>frame(),
    mechanicalActuator:async command=>{calls++;return actuator(command,()=>transmissions++);}});
  await mission.initialize();mission._setPhase('prepare_lift');
  mission._proposal={tool:'lift',args:{position:'up'},source:'claude',reason:'Lift before XY movement.',expected:'Lift is up.'};
  return {mission,counts:()=>({calls,modelCalls,transmissions})};
}
function makeFront(runtime){
  const front=new sandbox.FullExperimentEngine({strategy:'adaptive',recordFrames:false});
  Object.assign(front,{_plant:{diagnostics:()=>({})},_link:{frame:()=>frame(),traffic:()=>[]},
    _frontDecisions:8,_frontCalls:8,_controlCalls:2,_completed:new Set(),_lastResult:null,
    _decisionRecovery:new sandbox.VlabDecisionRecovery(),_runtime:{get diagnostics(){return plain(runtime);}},
    _onboarding:{ready:true,status:'ready',handshake:{ok:true},traffic:[],steps:[]}});
  return front;
}
(async()=>{
  const checks=[];let preTxState;
  for(const phase of ['startup','execution']){
    const detail=diagnostic('encode',phase),run=makeNavigation(async()=>{throw runtimeError(detail);});
    assert.equal((await run.engine.next()).kind,'decision');
    const state=await run.engine.next();
    assert.equal(state.done,true);assert.equal(state.kind,'failure');
    assert.equal(state.toolResult.wireSent,false);assert.equal(state.toolResult.driverErrorCode,errorCode(detail));
    assert.deepEqual(plain(state.toolResult.driverDiagnostic),detail);
    assert.equal(state.actionCount,0);assert.equal(state.commandAttemptCount,0);assert.equal(state.unconfirmedActuationCount,0);
    assert.equal(run.core.actions,0);assert.deepEqual(run.counts(),{calls:1,transmissions:0});
    const report=run.engine.report();assert.equal(report.version,'0.7.0');
    assert.deepEqual(plain(report.trace.at(-1).toolResult.driverDiagnostic),detail);
    await run.engine.next();assert.deepEqual(run.counts(),{calls:1,transmissions:0});assert.equal(run.provider.calls,1);
    if(phase==='startup')preTxState=state;
  }
  checks.push('Navigation encode startup/execution failures preserve typed diagnostics, count zero transmissions/actions, and stop without another model call');

  const decodeDetail=diagnostic('decode','execution');
  const post=makeNavigation(async(command,send)=>{send();return {applied:command.slice(),limited:false,
    driverError:'decode deadline expired',driverErrorCode:'DRIVER_DECODE_AFTER_MOVEMENT',driverDiagnostic:decodeDetail};});
  await post.engine.next();const postState=await post.engine.next();
  assert.equal(postState.kind,'action-failure');assert.equal(postState.done,true);
  assert.equal(postState.actionCount,1);assert.equal(postState.commandAttemptCount,1);assert.equal(postState.unconfirmedActuationCount,0);
  assert.equal(postState.toolResult.wireSent,true);assert.equal(postState.toolResult.driverErrorCode,'DRIVER_DECODE_AFTER_MOVEMENT');
  assert.deepEqual(plain(postState.toolResult.driverDiagnostic),decodeDetail);assert.deepEqual(plain(postState.applied),[.045,0]);
  assert.equal(post.core.actions,1);await post.engine.next();assert.deepEqual(post.counts(),{calls:1,transmissions:1});
  checks.push('Navigation post-transmission decode failure retains the acknowledged action and diagnostic, then stops with no resend');

  const unknownDetail=diagnostic('decode','execution');
  const uncertain=makeNavigation(async(command,send)=>{send();throw Object.assign(runtimeError(unknownDetail),{wireSent:true});});
  await uncertain.engine.next();const uncertainState=await uncertain.engine.next();
  assert.equal(uncertainState.kind,'action-failure');assert.equal(uncertainState.actionCount,0);
  assert.equal(uncertainState.commandAttemptCount,1);assert.equal(uncertainState.unconfirmedActuationCount,1);
  assert.equal(uncertainState.toolResult.acknowledgementUnknown,true);
  assert.deepEqual(plain(uncertainState.toolResult.driverDiagnostic),unknownDetail);
  await uncertain.engine.next();assert.deepEqual(uncertain.counts(),{calls:1,transmissions:1});
  checks.push('Unconfirmed sent command remains separate from acknowledged motion and is never resent');

  const auxDetail=diagnostic(),aux=await makeMission(async()=>{throw runtimeError(auxDetail);});
  const auxState=await aux.mission.next();
  assert.equal(auxState.done,true);assert.equal(auxState.kind,'failure');
  assert.equal(auxState.toolResult.wireSent,false);assert.deepEqual(plain(auxState.toolResult.driverDiagnostic),auxDetail);
  assert.equal(auxState.actionCount,0);assert.equal(auxState.commandAttemptCount,0);assert.equal(auxState.taskProgress.phase,'prepare_lift');
  await aux.mission.next();assert.deepEqual(aux.counts(),{calls:1,modelCalls:0,transmissions:0});
  checks.push('Auxiliary encode timeout ends the mission at its current phase instead of asking the model to retry');

  const auxPost=await makeMission(async(command,send)=>{send();return {applied:command,limited:false,
    driverError:'decode deadline expired',driverErrorCode:'DRIVER_DECODE_AFTER_MOVEMENT',driverDiagnostic:decodeDetail};});
  const auxPostState=await auxPost.mission.next();
  assert.equal(auxPostState.kind,'action-failure');assert.equal(auxPostState.done,true);
  assert.equal(auxPostState.actionCount,1);assert.equal(auxPostState.commandAttemptCount,1);assert.equal(auxPostState.toolResult.wireSent,true);
  assert.deepEqual(plain(auxPostState.toolResult.driverDiagnostic),decodeDetail);
  await auxPost.mission.next();assert.deepEqual(auxPost.counts(),{calls:1,modelCalls:0,transmissions:1});
  checks.push('Auxiliary decode failure records one acknowledged motion and stops without another model call or actuation');

  const runtime={requests:5,retries:1,failures:2,programErrors:0,recent:[diagnostic('encode','startup'),decodeDetail]};
  const front=makeFront(runtime),combined=front._appendControl(preTxState);
  assert.equal(combined.onboarding.ready,false);assert.equal(combined.onboarding.status,'failed');
  assert.equal(combined.onboarding.handshake.ok,true);
  assert.deepEqual(plain(combined.onboarding.runtimeFault.driverDiagnostic),plain(preTxState.toolResult.driverDiagnostic));
  assert.deepEqual(plain(combined.driverRuntime),{requests:5,retries:1,failures:2,programErrors:0,last:decodeDetail});
  assert.equal(Object.hasOwn(combined.driverRuntime,'recent'),false);
  assert.equal(Object.hasOwn(combined.events.at(-1).driverRuntime,'recent'),false);
  const report=front.report();assert.equal(report.version,'0.7.0');assert.deepEqual(plain(report.driverRuntime),runtime);
  report.driverRuntime.recent[0].phase='mutated-report';assert.equal(runtime.recent[0].phase,'startup');
  const vision=makeFront(runtime),visionState=vision._appendControl({...preTxState,toolResult:{ok:false,failedChecks:['platformDrift']}});
  assert.equal(visionState.onboarding.ready,true);assert.equal(visionState.onboarding.status,'ready');
  checks.push('Front engine invalidates readiness for typed terminal driver faults, retains handshake evidence, exports complete runtime diagnostics, and keeps event metadata compact; vision-only failures do not invalidate the driver');

  const summary={passed:true,version:'0.6.3',pureNode:true,browserUsed:false,networkCalls:0,credentialRead:false,
    scope:'Fault-injection regression of production navigation, mission and report paths with synthetic frames and actuator boundary fixtures; not a browser, live model, or five-trial completion test.',checks};
  fs.mkdirSync(path.join(root,'validation'),{recursive:true});
  fs.writeFileSync(path.join(root,'validation','v62-runtime-reporting.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
})().catch(error=>{console.error(error);process.exitCode=1;});
