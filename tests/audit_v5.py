"""Independent V5 mechanics and evidence audit. Uses no live model or hardware."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'validation'


def main():
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
            headless=True, args=['--enable-unsafe-swiftshader'])
        page = browser.new_page()
        requests = []
        page.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
        page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
        for name in ['controller', 'agent-core']:
            page.evaluate('(v)=>{const s=document.createElement("script");s.id=v.id;s.type="text/plain";s.textContent=v.source;document.body.appendChild(s);}',
                          {'id': 'controller-source' if name == 'controller' else 'agent-source', 'source': (ROOT / f'src/{name}.js').read_text(encoding='utf-8')})
        for name in ['plant', 'device-link', 'driver-runtime', 'engine', 'onboarding', 'pick-place']:
            page.add_script_tag(content=(ROOT / f'src/{name}.js').read_text(encoding='utf-8'))
        result = {'version': '0.5.0', 'mechanics': page.evaluate(MECHANICS),
                  'driver': page.evaluate(DRIVER), 'fullWorkflow': page.evaluate(FULL_WORKFLOW),
                  'visualFailures': page.evaluate(VISUAL_FAILURES), 'providerBoundary': page.evaluate(PROVIDER_BOUNDARY),
                  'auxiliaryFailureEvidence': page.evaluate(AUXILIARY_FAILURES), 'liveModelCalls': 0,
                  'scope': 'Independent local simulation audit, no model endpoint or physical hardware.'}
        assert not requests, requests
        result['externalRequests'] = requests
        (OUT / 'independent-audit-v5.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True))
        browser.close()


MECHANICS = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const p=new VirtualPlant({seed:42});
  const initial=p.diagnostics().pickPlace;
  assert(initial.lift==='up'&&initial.gripper==='open'&&!initial.held,'Initial manipulator state invalid');
  // Privileged geometry is used exclusively by this evaluator fixture to place
  // the actual joints at adversarial test locations. No controller receives it.
  const reach=world=>{
    const d=p.diagnostics(),g=d.geometry,[a,b]=g.lengths;
    const q2=Math.acos(Math.max(-1,Math.min(1,(world[0]**2+world[1]**2-a*a-b*b)/(2*a*b))));
    const q1=Math.atan2(world[1],world[0])-Math.atan2(b*Math.sin(q2),a+b*Math.cos(q2));
    const wrap=x=>((x+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
    for(let n=0;n<200;n++){
      const now=p.diagnostics().geometry;
      const delta=[wrap(q1-now.jointAngles[0]),q2-now.jointAngles[1]];
      if(Math.hypot(...delta)<1e-9)return;
      p.act(now.channelToJoint.map((joint,i)=>Math.max(-.1,Math.min(.1,delta[joint]/now.channelGains[i]))));
    }
    throw Error('Evaluator fixture could not reach requested pose');
  };
  p.operate({op:'grip',state:'closed'});
  assert(!p.diagnostics().pickPlace.held,'High gripper falsely attached object');
  p.operate({op:'grip',state:'open'});
  reach(initial.destination);p.operate({op:'lift',position:'down'});p.operate({op:'grip',state:'closed'});
  assert(!p.diagnostics().pickPlace.held&&same(p.diagnostics().pickPlace.object,initial.object),'Far gripper falsely attached or teleported object');
  p.operate({op:'grip',state:'open'});p.operate({op:'lift',position:'up'});reach(initial.object);
  p.operate({op:'grip',state:'closed'});
  assert(!p.diagnostics().pickPlace.held,'High gripper above object falsely attached');
  p.operate({op:'grip',state:'open'});p.operate({op:'lift',position:'down'});p.operate({op:'grip',state:'closed'});
  assert(p.diagnostics().pickPlace.held,'Low near gripper failed to attach');
  p.operate({op:'lift',position:'up'});
  assert(p.diagnostics().pickPlace.objectHeight===1,'Attached object did not lift');
  p.act([.06,-.04]);const carried=p.diagnostics();
  assert(dist(carried.manipulation.object,carried.tip)<1e-7,'Held object did not follow real tip');
  const release=carried.pickPlace.object.slice();p.operate({op:'grip',state:'open'});
  const wrong=p.diagnostics().pickPlace;
  assert(!wrong.held&&wrong.objectHeight===0&&same(wrong.object,release)&&!wrong.placed,'Release snapped object to destination or falsely reported placement');
  p.act([-.05,.06]);
  assert(same(p.diagnostics().pickPlace.object,release),'Released object still followed gripper');
  reach(release);p.operate({op:'lift',position:'down'});p.operate({op:'grip',state:'closed'});p.operate({op:'lift',position:'up'});
  reach(initial.destination);p.operate({op:'lift',position:'down'});p.operate({op:'grip',state:'open'});
  const done=p.diagnostics().pickPlace;
  assert(done.placed&&!done.held&&dist(done.object,initial.destination)<1e-7,'Real transport/release did not place object');
  return {highGraspRejected:true,farGraspRejected:true,nearLowGraspAttaches:true,heldObjectFollowsActualTip:true,wrongReleaseDoesNotSnap:true,releasedObjectRemainsStationary:true,actualTransportAndRelease:true};
}'''


DRIVER = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const rejects=async(f,m)=>{let failed=false;try{await f();}catch(_){failed=true;}assert(failed,m);};
  const p=new VirtualPlant({seed:42}),link=new SimulatedDeviceLink({plant:p,seed:42}),runtime=new DriverRuntime();
  const m=link.manual('VLAB-P2'),arm=link.inventory().find(e=>e.deviceModel==='VLAB-P2');
  const before=JSON.stringify(p.diagnostics());
  await rejects(()=>runtime.operate({op:'lift',position:'down'},link),'Untested auxiliary driver executed');
  link.connect({endpointId:arm.endpointId,...m.connection});link.handshake();
  await runtime.compile(m.sampleDriverSource);
  const t=await runtime.test(link);
  assert(t.passed,'Generic manual driver failed tests: '+JSON.stringify(t));
  assert(JSON.stringify(p.diagnostics())===before,'Generic dry-run tests altered plant/object state');
  const down=await runtime.operate({op:'lift',position:'down'},link);
  assert(p.diagnostics().pickPlace.lift==='down'&&down.sourceHash===runtime.sourceHash,'Lift bypassed runtime or did not execute');
  const closed=await runtime.operate({op:'grip',state:'closed'},link);
  assert(p.diagnostics().pickPlace.gripper==='closed'&&closed.sourceHash===runtime.sourceHash,'Grip bypassed runtime or did not execute');
  const still=JSON.stringify(p.diagnostics());
  for(const c of [{op:'lift',position:'sideways'},{op:'grip',state:'half'},{op:'grip',state:'open',hidden:true},{op:'teleport'}])await rejects(()=>runtime.operate(c,link),'Malformed auxiliary command accepted');
  assert(JSON.stringify(p.diagnostics())===still,'Rejected command altered object or mechanism');
  assert(!('held' in JSON.parse(closed.reply))&&!('attached' in JSON.parse(closed.reply))&&!('placed' in JSON.parse(closed.reply)),'ACK leaked hidden grasp outcome');
  runtime.dispose();
  const invalidSources=[
    m.sampleDriverSource+'\nconst priorEncode=encode;encode=c=>priorEncode(c&&c.op===\'lift\'?{op:\'lift\',position:c.position===\'up\'?\'down\':\'up\'}:c);',
    m.sampleDriverSource+'\nconst priorDecode=decode;decode=raw=>{const r=priorDecode(raw);if(r.applied&&r.applied.op===\'grip\')r.applied.state=r.applied.state===\'open\'?\'closed\':\'open\';return r;};'
  ];
  for(const source of invalidSources){
    const r=new DriverRuntime();await r.compile(source);const beforeBad=JSON.stringify(p.diagnostics());
    assert(!(await r.test(link)).passed,'Changed auxiliary command/forged ACK driver passed dry-run gate');
    assert(JSON.stringify(p.diagnostics())===beforeBad,'Rejected generic driver tests moved mechanism');r.dispose();
  }
  const r=new DriverRuntime();
  await r.compile(m.sampleDriverSource.replace('function decode(rawReply) {','function decode(rawReply) { if(JSON.parse(rawReply).auditFault)throw Error("forced generated decoder failure");'));
  assert((await r.test(link)).passed,'Conditional failure fixture did not pass dry-run');
  const exchange=link.exchange.bind(link);
  link.exchange=(wire,options={})=>{const raw=exchange(wire,options);return options.dryRun?raw:JSON.stringify({...JSON.parse(raw),auditFault:true})+'\n';};
  const ack=await r.operate({op:'lift',position:'up'},link);
  assert(p.diagnostics().pickPlace.lift==='up'&&ack.driverError&&ack.applied.position==='up'&&!r.passed,'Post-actuation decode failure erased movement or left driver enabled');
  await rejects(()=>r.operate({op:'grip',state:'open'},link),'Failed driver allowed another actuation');r.dispose();
  return {dryRunsDoNotAlterJointsOrObject:true,auxRequiresValidatedDriver:true,liftAndGripThroughGeneratedDriver:true,malformedAuxCommandsRejected:true,ackDoesNotRevealGraspSuccess:true,changedAuxCommandRejected:true,forgedAuxAckRejected:true,postActuationDecodeFailurePreservesAck:true,failedDriverDisabled:true};
}'''


FULL_WORKFLOW = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const results=[];
  for(const seed of [42,1]){
    const engine=new PickPlaceExperimentEngine({seed,strategy:'adaptive',recordFrames:false});
    let s=await engine.initialize(),before=JSON.stringify(s.diagnostics),samePlant=engine._plant;
    let seenReady=false,steps=0;
    while(!s.done&&steps++<800){
      s=await engine.next();
      assert(engine._plant===samePlant,'Plant was swapped between onboarding and control');
      if(!s.onboarding.ready)assert(JSON.stringify(s.diagnostics)===before&&s.actionCount===0,'Onboarding/proposal/dry-run changed physical state');
      else seenReady=true;
    }
    const r=engine.report(),pp=s.diagnostics.pickPlace;
    assert(seenReady&&s.done&&!s.failure&&s.taskProgress.completed,'Full pick/place failed seed '+seed+': '+JSON.stringify({failure:s.failure,phase:s.taskProgress,kind:s.kind,steps}));
    assert(pp.placed&&!pp.held&&pp.lift==='up'&&pp.gripper==='open'&&pp.graspCount>=1&&pp.releaseCount>=1,'Reported completion without actual grasp/carry/release');
    const traffic=r.onboarding.traffic,commands=traffic.filter(x=>!x.dryRun&&x.direction==='TX').map(x=>JSON.parse(x.wire)).filter(x=>['step','lift','grip'].includes(x.op));
    const acknowledgements=traffic.filter(x=>!x.dryRun&&x.direction==='RX').map(x=>JSON.parse(x.wire)).filter(x=>x.ok===true&&x.accepted!==undefined);
    const xy=commands.filter(x=>x.op==='step').length,aux=commands.length-xy;
    assert(r.actionCount===commands.length&&r.actionCount===acknowledgements.length,'Reported action count does not match actual command/ACK evidence');
    assert(r.xyActionCount===xy&&r.auxiliaryActionCount===aux&&r.commandAttemptCount===commands.length,'XY/auxiliary/attempt counts do not match wire');
    assert(r.provenance.driverSource==='manual-template'&&r.onboarding.driverTests.passed&&r.onboarding.driverSource.includes('function encode'),'Missing honest offline driver provenance');
    assert(r.missionEvidence.grasp&&r.missionEvidence.coMotion&&r.missionEvidence.release,'Missing image-derived grasp/co-motion/release evidence');
    const final=s.toolResult.data;
    assert(final.source==='new-camera-frame'&&Object.values(final.checks).every(Boolean),'Final completion did not use fresh visual evidence');
    const reportBefore=JSON.stringify(r);engine.review(0);engine.review(engine.historyLength-1);
    assert(JSON.stringify(engine.report())===reportBefore,'Read-only replay altered evidence');
    results.push({seed,transport:r.onboarding.connection.transport,completed:true,xyActions:xy,auxiliaryActions:aux,totalActions:r.actionCount,decisions:r.decisionCount,probes:r.probeCount,placementErrorPx:final.placementError,releaseDriftPx:final.releaseDrift,gripperSeparationPx:final.separation,graspCount:pp.graspCount,releaseCount:pp.releaseCount,actualCommandsAndAcksMatch:true,samePlantThroughOnboarding:true});
    engine.dispose();
  }
  return results;
}'''


VISUAL_FAILURES = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const jammed=new PickPlaceExperimentEngine({seed:42,strategy:'adaptive',recordFrames:false});
  let s=await jammed.initialize();const act=jammed._plant.act.bind(jammed._plant);
  // Simulate an accepted close command with no physical grasp, as a jammed jaw.
  jammed._plant.act=c=>c?.op==='grip'&&c.state==='closed'?{applied:{...c},limited:false}:act(c);
  for(let n=0;n<600&&!s.done;n++)s=await jammed.next();
  assert(s.done&&s.failure&&!s.taskProgress.completed&&!s.taskProgress.graspVerified,'Jammed grasp falsely completed');
  assert(s.taskProgress.attempts===2&&!s.diagnostics.pickPlace.held&&s.diagnostics.pickPlace.graspCount===0,'Failed grasp was not bounded or used hidden attachment');
  jammed.dispose();
  const misplaced=new PickPlaceExperimentEngine({seed:42,strategy:'adaptive',recordFrames:false});
  let t=await misplaced.initialize(),injected=false;
  for(let n=0;n<800&&!t.done;n++){
    if(!injected&&t.taskProgress.phase==='release'){
      // External disturbance while held, after arrival but before release.
      // The evaluator does not update the agent's visual evidence or flags.
      for(let k=0;k<6;k++)misplaced._plant.act([.1,.1]);
      injected=true;
    }
    t=await misplaced.next();
  }
  assert(injected&&t.done&&t.failure&&!t.taskProgress.completed,'Wrong physical release falsely completed');
  const failedChecks=t.toolResult?.data?.checks;
  assert(failedChecks&&failedChecks.insideDestination===false&&!t.diagnostics.pickPlace.placed,'Final fresh image did not reject misplaced object');
  const error=t.toolResult.data.placementError;misplaced.dispose();
  const empty=new PickPlaceExperimentEngine({seed:42,strategy:'adaptive',recordFrames:false});
  let e=await empty.initialize();while(!e.onboarding.ready)e=await empty.next();
  const mission=empty._control;
  // Even forged progress flags cannot replace the final pixel measurements.
  Object.assign(mission._task,{phase:'verify_place',graspVerified:true,coMotionVerified:true,released:true,cleared:true});
  mission._actuatorState={lift:'up',gripper:'open'};mission._releaseEvidence=mission._observed.object.slice();
  mission._proposal={tool:'verify_place',args:{},source:'adaptive'};
  e=await empty.next();
  assert(e.done&&e.failure&&!e.taskProgress.completed&&e.toolResult.data.checks.insideDestination===false,'Forged progress flags bypassed new-frame placement test');
  empty.dispose();
  return {jammedGraspRejectedFromImage:true,graspRetriesBoundedAtTwo:true,wrongReleaseRejectedFromNewImage:true,wrongReleaseErrorPx:error,forgedProgressCannotReplaceVisualEvidence:true};
}'''


PROVIDER_BOUNDARY = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const forbidden=new Set(['seed','geometry','diagnostics','jointAngles','channelGains','channelToJoint','cameraVersion','target1','target2','held','attached','objectHeight','trueError','pickPlace']);
  const walk=v=>{if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){assert(!forbidden.has(k),'Private simulator key reached provider: '+k);walk(x);}};
  async function run(failPhase=null){
    let engine,calls=0,phases=new Set(),failedAt=null;
    const provider={model:'explicit-local-audit-stub',abort(){},async decide(context,frame){
      calls++;phases.add(context.phase);walk(context);
      assert(Object.keys(frame).sort().join(',')==='height,pixels,width','Provider received hidden data alongside camera');
      if(context.phase===failPhase){failedAt=context.phase;throw Error('Explicit injected provider failure');}
      let d;
      if(context.phase==='onboarding')d=engine._offlineDecision();
      else if(context.phase==='mission')d=engine._control._offlineDecision();
      else d=await engine._control._navigation._agent.call('decide',{strategy:'adaptive'});
      return {...d,source:'claude',model:this.model};
    }};
    engine=new PickPlaceExperimentEngine({seed:42,strategy:'claude',provider,recordFrames:false});
    let s=await engine.initialize();for(let n=0;n<800&&!s.done;n++)s=await engine.next();
    if(failPhase){
      assert(s.done&&s.failure&&!s.taskProgress.completed&&failedAt===failPhase,'Provider outage did not halt '+failPhase);
      const before=JSON.stringify(engine.report()),count=calls;await engine.next();
      assert(JSON.stringify(engine.report())===before&&calls===count,'Provider outage silently fell back or kept issuing commands');
    }else assert(s.done&&!s.failure&&s.taskProgress.completed&&phases.size===3,'Mocked three-phase provider workflow failed');
    const out={calls,phases:[...phases],failedAt,actions:s.actionCount};engine.dispose();return out;
  }
  const complete=await run(),failures=[];for(const phase of ['onboarding','mission','control'])failures.push(await run(phase));
  return {allThreePhaseContextsExcludePrivilegedState:true,framesContainPixelsOnly:true,providerOutagesNeverFallback:true,explicitLocalStubOnly:true,complete,failures};
}'''


AUXILIARY_FAILURES = r'''async()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  const outputs=[];
  for(const corrupt of [false,true]){
    const e=new PickPlaceExperimentEngine({seed:42,strategy:'adaptive',recordFrames:false});
    let s=await e.initialize(),fault=false,before=null;
    const choose=e._offlineDecision.bind(e);
    if(!corrupt)e._offlineDecision=()=>{const d=choose();if(d.tool==='write_driver')d.args.source=d.args.source.replace('function decode(rawReply) {','function decode(rawReply) { if(JSON.parse(rawReply).auditFault)throw Error("injected decode fault");');return d;};
    const exchange=e._link.exchange.bind(e._link);
    e._link.exchange=(wire,options={})=>{
      const raw=exchange(wire,options);let command;try{command=JSON.parse(wire);}catch{return raw;}
      if(!options.dryRun&&command.op==='lift'&&command.position==='down'){
        fault=true;before=e.snapshot();
        return corrupt?'invalid-ack\n':JSON.stringify({...JSON.parse(raw),auditFault:true})+'\n';
      }
      return raw;
    };
    for(let n=0;n<400&&!s.done;n++)s=await e.next();
    const r=e.report();
    assert(fault&&s.done&&s.failure&&s.kind==='action-failure'&&!s.taskProgress.completed,'Auxiliary post-TX failure did not stop');
    assert(s.diagnostics.pickPlace.lift==='down','Fixture failed to actuate before ACK fault');
    assert(r.commandAttemptCount===before.commandAttemptCount+1&&!e._runtime.passed&&!s.onboarding.ready,'Sent auxiliary command disappeared or failed driver stayed ready');
    if(corrupt)assert(r.actionCount===before.actionCount&&r.unconfirmedActuationCount===1,'Corrupt auxiliary ACK fabricated execution or omitted unknown command');
    else assert(r.actionCount===before.actionCount+1&&r.auxiliaryActionCount===before.auxiliaryActionCount+1&&r.unconfirmedActuationCount===0,'Known execution lost on generated decoder failure');
    const saved=JSON.stringify(r);await e.next();assert(JSON.stringify(e.report())===saved,'Motion continued after failed auxiliary driver');
    outputs.push({fault:corrupt?'corrupt-device-ack':'generated-decoder-failure',confirmedActions:r.actionCount,commandAttempts:r.commandAttemptCount,unconfirmed:r.unconfirmedActuationCount,physicalLift:'down',halted:true});e.dispose();
  }
  return outputs;
}'''


if __name__ == '__main__':
    main()
