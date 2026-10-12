"""Bounded decision-repair integration tests. Every model response is a local mock.

Uses the production Claude/Gemini request and response validators, with an explicit
deterministic oracle as the decision fixture. No key is read and no API is called.
This validates recovery plumbing and state preservation, not model intelligence.
"""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def main():
    out = ROOT / 'validation' / 'decision-recovery-workflow.json'
    out.parent.mkdir(exist_ok=True)
    report = {
        'realAPI': False, 'liveModelCalls': 0, 'credentialRead': False,
        'scope': 'Production providers and all three experiment engines, with local fetch fixtures. '
                 'An explicit adaptive oracle supplies valid decisions; this does not measure model intelligence.',
        'cases': [], 'passed': False,
    }
    cases = [
        {'providerName': 'claude', 'mode': 'recover', 'faultPhase': 'control', 'maxFaults': 2},
        {'providerName': 'gemini', 'mode': 'recover', 'faultPhase': 'control', 'maxFaults': 2},
        {'providerName': 'claude', 'mode': 'recover', 'faultPhase': 'onboarding', 'maxFaults': 1},
        {'providerName': 'claude', 'mode': 'recover', 'faultPhase': 'mission', 'maxFaults': 1},
        {'providerName': 'claude', 'mode': 'exhaust', 'faultPhase': 'control', 'maxFaults': 3},
        {'providerName': 'gemini', 'mode': 'exhaust', 'faultPhase': 'mission', 'maxFaults': 3},
        {'providerName': 'claude', 'mode': 'http503', 'faultPhase': 'control', 'maxFaults': 1},
        {'providerName': 'gemini', 'mode': 'http503', 'faultPhase': 'onboarding', 'maxFaults': 1},
    ]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
            headless=True, args=['--enable-unsafe-swiftshader', '--disable-background-networking'])
        context = browser.new_context()
        attempted = []
        context.route('**/*', lambda route: (attempted.append(route.request.url), route.abort()))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
        for name in ['controller', 'agent-core']:
            page.evaluate('(v)=>{const s=document.createElement("script");s.id=v.id;s.type="text/plain";'
                          's.textContent=v.source;document.body.appendChild(s);}', {
                'id': 'controller-source' if name == 'controller' else 'agent-source',
                'source': (ROOT / f'src/{name}.js').read_text(encoding='utf-8')})
        for name in ['plant', 'device-link', 'driver-runtime', 'engine', 'onboarding', 'pick-place',
                     'claude-provider', 'gemini-provider']:
            page.add_script_tag(content=(ROOT / f'src/{name}.js').read_text(encoding='utf-8'))
        try:
            for case in cases:
                result = page.evaluate(RUN, case)
                report['cases'].append(result)
                out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps(result, ensure_ascii=True), flush=True)
            assert not attempted, attempted
            assert not errors, errors
            report.update({'passed': True, 'externalRequests': attempted, 'pageErrors': errors})
        finally:
            out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()
    print(json.dumps({'passed': report['passed'], 'file': str(out)}, ensure_ascii=True))


RUN = r'''async ({providerName,mode,faultPhase,maxFaults})=>{
  const assert=(value,message)=>{if(!value)throw Error(providerName+'/'+mode+'/'+faultPhase+': '+message);};
  const copy=value=>JSON.parse(JSON.stringify(value));
  const same=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message);
  const forbidden=new Set(['seed','geometry','diagnostics','jointAngles','channelGains','channelToJoint','cameraVersion','target1','target2','held','attached','objectHeight','trueError','pickPlace']);
  const walk=value=>{if(!value||typeof value!=='object')return;for(const[key,child]of Object.entries(value)){assert(!forbidden.has(key),'Hidden state reached model: '+key);walk(child);}};
  const model=providerName+'-explicit-local-recovery-mock';
  const Provider=providerName==='claude'?ClaudeAgentProvider:GeminiAgentProvider;
  const bridgeUrl=providerName==='claude'?'http://127.0.0.1:8766':'http://127.0.0.1:8767';
  const realProvider=new Provider({model,bridgeUrl,maxCalls:80});
  const originalFetch=globalThis.fetch;
  let engine,pending,fetchCalls=0,faults=0,acceptedAfterFault=0,expectedFeedback=null;
  let faultSnapshot=null,faultReturned=false,feedbackChecks=0,cleanContextChecks=0,exercisedControlCalibration=false;
  const rejectionChecks=[],phases=new Set();
  const persistent=()=>{
    const s=engine.snapshot(),n=engine._control?._navigation;
    return {actionCount:s.actionCount,commandAttemptCount:s.commandAttemptCount,probeCount:s.probeCount,
      jacobian:copy(n?._ctx?.model?.jacobian||null),task:copy(s.taskProgress),plant:JSON.stringify(engine._plant.diagnostics()),
      traffic:JSON.stringify(engine._link.traffic()),onboarding:JSON.stringify({connection:s.onboarding.connection,
        driverSource:s.onboarding.driverSource,driverTests:s.onboarding.driverTests,ready:s.onboarding.ready}),
      navigationContext:n?JSON.stringify({observation:n._ctx.observation,model:n._ctx.model,samples:n._ctx.samples,lastOutcome:n._ctx.lastOutcome}):null,
      plantRef:engine._plant,linkRef:engine._link,driverRef:engine._runtime,navigationRef:n};
  };
  const assertPreserved=(before,state)=>{
    const after=persistent();
    for(const key of ['actionCount','commandAttemptCount','probeCount','jacobian','task','plant','traffic','onboarding','navigationContext'])
      same(after[key],before[key],'Rejected decision changed '+key+' from '+JSON.stringify(before[key])+' to '+JSON.stringify(after[key]));
    for(const key of ['plantRef','linkRef','driverRef','navigationRef'])assert(after[key]===before[key],'Rejected decision replaced '+key);
    assert(!state.decision,'Rejected model response became executable proposal');
  };
  globalThis.fetch=async (url,options)=>{
    fetchCalls++;
    const body=JSON.parse(options.body);
    const parts=providerName==='claude'?body.messages[0].content:body.contents[0].parts;
    const text=parts.find(p=>typeof p.text==='string').text;
    const context=JSON.parse(text.split('\n')[1]);
    assert(url===bridgeUrl+(providerName==='claude'?'/api/claude/messages':'/api/gemini/generateContent'),'Unexpected fetch URL');
    assert(options.headers['X-Vlab-Bridge']==='1'&&!options.headers['x-api-key']&&!options.headers['x-goog-api-key'],'Mock request carries credential');
    assert(body.model===model,'Model selection changed');
    walk(context);phases.add(context.phase);
    const declared=providerName==='claude'?body.tools.map(t=>t.name):body.tools[0].functionDeclarations.map(t=>t.name);
    same(declared,context.allowedTools,'Request tool definitions differ from allowed tools');
    if(expectedFeedback){
      assert(context.decisionFeedback,'Correction request omitted rejection feedback');
      assert(context.decisionFeedback.code==='INVALID_DECISION'&&context.decisionFeedback.issue==='invalid-envelope','Feedback lost exact validation issue');
      assert(context.decisionFeedback.attempt===expectedFeedback.attempt&&context.decisionFeedback.maxCorrections===2,'Feedback has wrong retry limit/count');
      same([...context.decisionFeedback.allowedTools].sort(),[...context.allowedTools].sort(),'Feedback omitted current allowed tools');
      assert(context.decisionFeedback.diagnostic.missingFields.includes('reason'),'Feedback omitted missing field');
      feedbackChecks++;
    }else if(faults){assert(!context.decisionFeedback,'Accepted decision did not clear stale correction context');cleanContextChecks++;}
    const calibrated=context.phase!=='control'||(context.model?.jacobian&&engine.snapshot().probeCount>=2);
    const eligible=context.phase===faultPhase&&calibrated&&faults<maxFaults&&
      (mode!=='recover'||faults===0||acceptedAfterFault>0);
    let input={args:copy(pending.decision.args),reason:'EXPLICIT LOCAL ORACLE MOCK: '+pending.decision.reason,expected:pending.decision.expected};
    faultReturned=false;
    if(eligible){
      if(context.phase==='control'){assert(engine.snapshot().onboarding.ready,'Control fault preceded onboarding');exercisedControlCalibration=true;}
      faultSnapshot=persistent();faults++;acceptedAfterFault=0;faultReturned=true;
      if(mode==='http503')return {ok:false,status:503,json:async()=>({error:{message:'Explicit local mock service failure'}})};
      // Omit an envelope field; the real provider must reject it before any actuation.
      delete input.reason;
    }else{if(faults)acceptedAfterFault++;expectedFeedback=null;}
    const response=providerName==='claude'?
      {stop_reason:'tool_use',content:[{type:'tool_use',id:'local-'+fetchCalls,name:pending.decision.tool,input}],usage:{input_tokens:12,output_tokens:8}}:
      {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:pending.decision.tool,args:input}}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:8,totalTokenCount:20}};
    return {ok:true,status:200,json:async()=>response};
  };
  const provider={model,get calls(){return realProvider.calls;},abort(){realProvider.abort();},async decide(context,frame){
    walk(context);
    assert(Object.keys(frame).sort().join(',')==='height,pixels,width','Provider frame leaked evaluator state');
    let decision;
    if(context.phase==='onboarding')decision=engine._offlineDecision();
    else if(context.phase==='mission')decision=engine._control._offlineDecision();
    else decision=await engine._control._navigation._agent.call('decide',{strategy:'adaptive'});
    if(decision.tool==='write_driver')decision.args.source='// EXPLICIT LOCAL ORACLE MOCK; not a real generated driver.\n'+decision.args.source;
    pending={phase:context.phase,decision};
    const parsed=await realProvider.decide(context,frame);
    assert(parsed.source===providerName&&parsed.model===model,'Accepted response changed source');
    return parsed;
  }};
  try{
    engine=new PickPlaceExperimentEngine({seed:42,strategy:providerName,provider,recordFrames:false});
    let state=await engine.initialize(),steps=0;
    while(!state.done&&steps++<800){
      faultReturned=false;
      state=await engine.next();
      if(faultReturned){
        assertPreserved(faultSnapshot,state);
        if(mode==='http503')assert(state.done&&state.failure.includes('HTTP_503'),'HTTP 503 did not stop immediately');
        else{
          assert(state.decisionDiagnostic?.code==='INVALID_DECISION'&&state.decisionDiagnostic?.issue==='invalid-envelope','Exact sanitized rejection absent');
          assert(state.decisionDiagnostic.missingFields.includes('reason'),'Missing-field diagnostic absent');
          const attempt=mode==='recover'?1:faults;
          assert(state.decisionRecovery?.attempt===attempt&&state.decisionRecovery.maxCorrections===2,'Wrong consecutive rejection count or correction limit');
          const willRetry=mode==='recover'||faults<3;
          assert(state.decisionRecovery.willRetry===willRetry,'Wrong retry permission');
          assert(state.done===!willRetry,'Rejection did not preserve/stop session as required');
          if(willRetry)assert(state.kind==='decision-rejected'&&!state.failure,'Recoverable error was treated as final failure');
          else assert(state.failure,'Exhausted correction did not record failure');
          expectedFeedback=willRetry?{attempt}:null;
          rejectionChecks.push({attempt,willRetry,phase:faultPhase,actions:state.actionCount,
            probeCount:state.probeCount,hasJacobian:Boolean(state.jacobian),preserved:true,noActuation:true});
        }
      }
    }
    const report=engine.report();
    assert(faults===maxFaults,'Planned fault count was not exercised');
    assert(report.modelCalls===fetchCalls&&realProvider.calls===fetchCalls,'Retries escaped model call accounting');
    const accepted=report.trace.filter(e=>e.kind==='decision');
    assert(accepted.every(e=>e.decision.source===providerName),'Silent offline fallback');
    assert(report.onboarding.driverSource?.startsWith('// EXPLICIT LOCAL ORACLE MOCK;')||faultPhase==='onboarding'&&mode==='http503','Driver provenance fixture missing');
    if(mode==='recover'){
      assert(state.done&&!state.failure&&state.taskProgress.completed,'Recovery did not finish pick/place: '+state.failure);
      assert(feedbackChecks===maxFaults,'Each rejected decision did not receive one corrected call');
      assert(cleanContextChecks>0,'No accepted response reset feedback');
      assert(report.actionCount===24&&report.xyActionCount===16&&report.auxiliaryActionCount===8,'Retries changed seed-42 physical action sequence');
      assert(state.toolResult?.data?.source==='new-camera-frame'&&Object.values(state.toolResult.data.checks).every(Boolean),'Final result lacks fresh visual verification');
      assert(report.missionEvidence.grasp&&report.missionEvidence.coMotion&&report.missionEvidence.release,'Recovery lost mission evidence');
    }else{
      assert(state.done&&state.failure&&!state.taskProgress.completed,'Terminal failure was relabeled as success');
      assert(mode==='http503'?feedbackChecks===0:feedbackChecks===2,'Unexpected extra corrections');
      const count=fetchCalls,before=JSON.stringify(report);
      await engine.next();
      assert(count===fetchCalls&&JSON.stringify(engine.report())===before,'Stopped engine resumed or retried');
    }
    if(faultPhase==='control')assert(exercisedControlCalibration,'Control failure never tested an existing Jacobian');
    const serialized=JSON.stringify(report);
    assert(!serialized.includes('x-api-key')&&!serialized.includes('x-goog-api-key'),'Export contains transport credentials');
    return {provider:providerName,mode,faultPhase,mockOnly:true,passed:true,completed:Boolean(state.taskProgress.completed),
      injectedFaults:faults,mockRequests:fetchCalls,acceptedDecisions:accepted.length,feedbackChecks,feedbackResetChecks:cleanContextChecks,
      rejectionChecks,actions:state.actionCount,xyActions:report.xyActionCount,auxiliaryActions:report.auxiliaryActionCount,
      modelCallBudgetIncludesRetries:true,noFallback:true,privilegedInputsExcluded:true,phases:[...phases]};
  }finally{engine?.dispose();realProvider.dispose();globalThis.fetch=originalFetch;}
}'''


if __name__ == '__main__':
    main()
