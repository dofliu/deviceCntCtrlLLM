'use strict';
// Pure Node integration: production validation/core/engine, synthetic camera and
// actuator fixtures. No browser, actual model request, credentials or network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const sandbox=vm.createContext({});
for(const name of ['claude-provider.js','controller.js','agent-core.js','engine.js','onboarding.js','pick-place.js']){
  vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),sandbox,{filename:name});
}
const plain=x=>JSON.parse(JSON.stringify(x));
const contract=sandbox.VlabAgentContract;
function accepted(name,args,expected){
  const input={args,reason:'Check the image before continuing.'};
  if(arguments.length===3)input.expected=expected;
  return {...contract.validateToolCall({name,input},[name]),source:'claude',model:'mock-contract'};
}
function frame(tipX=5){
  const width=40,height=24,pixels=new Uint8ClampedArray(width*height*4);
  for(const [x0,y0,color] of [[tipX,4,[30,220,210]],[28,16,[230,60,180]]]){
    for(let y=y0;y<y0+4;y++)for(let x=x0;x<x0+4;x++){
      const i=(y*width+x)*4;pixels.set([...color,255],i);
    }
  }
  return {width,height,pixels};
}
function makeEngine(getDecision){
  let commands=[];
  const camera=()=>frame(5+commands.length);
  const core=new sandbox.AgentCore();core.observe(camera());
  const provider={calls:0,model:'mock-contract',async decide(){this.calls++;return getDecision();}};
  const engine=new sandbox.AutonomousEngine({strategy:'claude',provider,challenge:false,recordFrames:false,
    actuator:async command=>{commands.push(plain(command));return {applied:command.slice(),limited:false};},frameGetter:camera});
  // Replace only browser transport and initialization with deterministic fixtures.
  // Actual next(), prepare(), _execute(), outcome(), _emit() and report() are used.
  Object.assign(engine,{
    _agent:{async call(op,data){
      if(op==='prepare')return core.prepare(data.decision,data.strategy);
      if(op==='outcome')return core.outcome(data);
      if(op==='execute')return core.execute(data);
      throw new Error('Unexpected core transport operation: '+op);
    }},
    _plant:{diagnostics:()=>({target:[29.5,17.5]})},
    _ctx:core.context(),_frame:camera(),_state:{done:false},_proposal:null,
    _mode:'decide',_changed:false,_decisionRecovery:new sandbox.VlabDecisionRecovery(),
    _actionCount:0,_probeCount:0,_recalibrations:0,_decisionCount:0,
    _episodeDecisions:0,_episodeActions:0,_sentCount:0,_unconfirmedCount:0,
    _modelSeen:false,_checkpoints:{firstReach:null,changed:false,preChangeMismatch:false,mismatchSeen:false,recovered:null}
  });
  return {engine,core,commands};
}
(async()=>{
  const groups=[];
  const decision=accepted('probe',{channel:0,direction:1,amplitude:.045});
  assert.equal(decision.expected,'');assert.equal(decision.expectedProvided,false);
  const run=makeEngine(()=>decision);
  const beforeObservation=plain(run.core.observation);
  const proposal=await run.engine.next();
  assert.equal(proposal.kind,'decision');assert.equal(proposal.failure,null);
  assert.equal(proposal.decision.expectedProvided,false);assert.equal(proposal.decision.expected,'');
  assert.equal(proposal.decision.source,'claude');
  assert.deepEqual(plain(proposal.command),[.045,0]);
  assert.deepEqual(plain(run.core.observation),beforeObservation);
  assert.equal(run.commands.length,0);assert.equal(proposal.actionCount,0);assert.equal(run.core.actions,0);
  const executed=await run.engine.next();
  assert.equal(executed.kind,'action-result');assert.equal(executed.failure,null);
  assert.equal(executed.decision.expectedProvided,false);assert.equal(executed.decision.expected,'');
  assert.deepEqual(run.commands,[[.045,0]]);assert.equal(run.core.actions,1);
  assert.equal(run.engine.report().modelCalls,1);assert.equal(run.engine.report().actionCount,1);
  assert.equal(run.engine.report().decisionRejections,0);
  assert.equal(run.engine.report().trace.filter(e=>e.kind==='decision').length,1);
  assert.equal(run.engine.report().trace[0].decision.expectedProvided,false);
  groups.push('Omitted narrative passes provider/core proposal without motion; only next execution actuates once');

  for(const [name,args,allowed,code] of [
    ['probe',{channel:0,direction:1,amplitude:.11},['probe'],'INVALID_ARGUMENTS'],
    ['probe',{channel:2,direction:1,amplitude:.045},['probe'],'INVALID_ARGUMENTS'],
    ['probe',{channel:0,direction:1,amplitude:.045,extra:1},['probe'],'INVALID_ARGUMENTS'],
    ['probe',{channel:0,direction:1},['probe'],'INVALID_ARGUMENTS'],
    ['lift',{position:'up'},['probe'],'INVALID_DECISION']
  ]){
    const bad=makeEngine(()=>({...contract.validateToolCall({name,input:{args,reason:'Check bounds.'}},allowed),source:'claude'}));
    for(let attempt=1;attempt<=3;attempt++){
      const state=await bad.engine.next();
      assert.equal(state.decisionDiagnostic.code,code);
      assert.equal(state.done,attempt===3);
      assert.equal(state.decisionRecovery.attempt,attempt);
    }
    assert.equal(bad.commands.length,0);assert.equal(bad.core.actions,0);
    assert.equal(bad.engine.report().decisionCount,0);
  }
  groups.push('Missing narrative never bypasses tool allowlist, numeric bounds, required arguments or two-correction limit');

  for(const [validate,decision,allowed] of [
    [sandbox.validateAgentDecision,accepted('probe',{channel:1,direction:-1,amplitude:.03}),null],
    [sandbox.validateFrontDecision,accepted('list_interfaces',{}),['list_interfaces']],
    [sandbox.validateMissionDecision,accepted('lift',{position:'up'}),['lift']]
  ]){
    const omitted=validate(decision,allowed);
    assert.equal(omitted.expectedProvided,false);assert.equal(omitted.expected,'');
    const provided=validate({...decision,expected:'Observe movement.',expectedProvided:true},allowed);
    assert.equal(provided.expectedProvided,true);assert.equal(provided.expected,'Observe movement.');
    const legacy={...decision,source:'adaptive',expected:'Existing custom provider description.'};delete legacy.expectedProvided;
    assert.equal(validate(legacy,allowed).expectedProvided,true);
  }
  assert.throws(()=>sandbox.validateAgentDecision({...decision,args:{channel:0,direction:1,amplitude:.11}}));
  assert.throws(()=>sandbox.validateFrontDecision(accepted('list_interfaces',{}),['handshake']));
  assert.throws(()=>sandbox.validateMissionDecision({...accepted('lift',{position:'up'}),args:{position:'middle'}},['lift']));
  groups.push('Navigation, onboarding and mission validators preserve absence/presence and legacy description compatibility');

  const front=new sandbox.FullExperimentEngine({strategy:'claude',provider:{model:'mock-contract'}});
  const missing=accepted('list_interfaces',{}),provided=accepted('read_manual',{documentId:'VLAB-P2'},'Read protocol.');
  Object.assign(front,{_events:[{kind:'decision',decision:missing},{kind:'onboarding-result',decision:missing},
    {kind:'decision',decision:provided},{kind:'onboarding-result',decision:provided},
    {kind:'decision',decision:{...provided,source:'adaptive'}}],
    _truth:[],_state:{done:false},_onboarding:{},_completed:new Set(),_frontDecisions:3,_frontCalls:2,_controlCalls:0});
  const report=front.report();
  assert.equal(report.version,'0.7.0');
  assert.deepEqual(plain(report.provenance.modelExpectationText),{provided:1,omitted:1});
  assert.equal(report.trace[0].decision.expectedProvided,false);
  assert.equal(report.trace[2].decision.expectedProvided,true);
  groups.push('Report counts each accepted model decision once and excludes offline decisions/result duplicates');

  const summary={passed:true,pureNode:true,browserUsed:false,networkCalls:0,credentialRead:false,
    scope:'Contract and bounded proposal/execution regression with synthetic image and actuator fixtures; not a live model or complete pick/place test.',checks:groups};
  fs.mkdirSync(path.join(root,'validation'),{recursive:true});
  fs.writeFileSync(path.join(root,'validation','expected-contract-node.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
})().catch(error=>{console.error(error);process.exitCode=1;});
