"""Gemini integration contract test. ALL model replies are local mocks.

No credential is read. No Gemini/Anthropic/other API is contacted. A local
deterministic oracle supplies function calls through the production Gemini
provider's fetch boundary, so this verifies plumbing, not model intelligence.
"""
import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    spec = importlib.util.spec_from_file_location('gemini_bridge_contract', ROOT / 'gemini_bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge_checks = []

    def validate_bridge_request(body):
        # Receive the exact production provider body through a local Playwright
        # binding. This calls only the pure validator, never key lookup/upstream.
        passed = bridge.validate_message(body)
        bridge_checks.append(passed)
        return passed

    out = ROOT / 'validation' / 'gemini-workflow-mock.json'
    out.parent.mkdir(exist_ok=True)
    report = {
        'version': '0.5.0', 'realAPI': False, 'liveModelCalls': 0,
        'credentialRead': False,
        'scope': 'Production GeminiAgentProvider with locally mocked generateContent responses. '
                 'Decisions are supplied by the explicit local adaptive oracle, never a Gemini model. '
                 'Gemini source/usage below are injected transport-contract fixtures, not live provenance.',
        'fullWorkflow': [], 'failures': [], 'sourceMismatch': [],
    }
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
            headless=True, args=['--enable-unsafe-swiftshader', '--disable-background-networking'])
        context = browser.new_context()
        attempted = []
        context.route('**/*', lambda route: (attempted.append(route.request.url), route.abort()))
        page = context.new_page()
        page.expose_function('__validate_gemini_bridge', validate_bridge_request)
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
            for seed in [42, 1]:
                report['fullWorkflow'].append(page.evaluate(RUN, {'seed': seed}))
                print(json.dumps({'case': 'complete', 'result': report['fullWorkflow'][-1]}, ensure_ascii=True), flush=True)
            for phase in ['onboarding', 'mission', 'control']:
                report['failures'].append(page.evaluate(RUN, {'seed': 42, 'failPhase': phase}))
                print(json.dumps({'case': 'failure', 'result': report['failures'][-1]}, ensure_ascii=True), flush=True)
            for phase in ['onboarding', 'mission', 'control']:
                report['sourceMismatch'].append(page.evaluate(RUN, {'seed': 42, 'mismatchPhase': phase}))
                print(json.dumps({'case': 'sourceMismatch', 'result': report['sourceMismatch'][-1]}, ensure_ascii=True), flush=True)
            assert not attempted, attempted
            assert not errors, errors
            expected_requests = sum(result['mockRequests'] for group in
                                    ['fullWorkflow', 'failures', 'sourceMismatch'] for result in report[group])
            assert len(bridge_checks) == expected_requests and all(bridge_checks), bridge_checks
            report.update({'passed': True, 'externalRequests': attempted, 'pageErrors': errors})
        finally:
            report['productionBridgeValidation'] = {
                'checkedRequestBodies': len(bridge_checks),
                'allAccepted': bool(bridge_checks) and all(bridge_checks),
                'validator': 'gemini_bridge.validate_message',
                'scope': 'Exact production request bodies including all declared tool schemas, '
                         'PNG images and fake model ID; no API key lookup or upstream call.',
            }
            out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()
    print(json.dumps({'passed': report['passed'], 'file': str(out)}, ensure_ascii=True))


RUN = r'''async ({seed,failPhase=null,mismatchPhase=null})=>{
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const forbidden=new Set(['seed','geometry','diagnostics','jointAngles','channelGains','channelToJoint','cameraVersion','target1','target2','held','attached','objectHeight','trueError','pickPlace']);
  const walk=value=>{if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){assert(!forbidden.has(key),'Privileged key reached provider: '+key);walk(child);}};
  const usage={promptTokenCount:12,candidatesTokenCount:8,totalTokenCount:20,thoughtsTokenCount:0,cachedContentTokenCount:0};
  const model='gemini-explicit-local-mock';
  let engine,pending,fetchCalls=0,failedAt=null,mismatchAt=null,actionsBeforeFault=null;
  const phases=new Set(),requestPhases=[],originalFetch=globalThis.fetch;
  const realProvider=new GeminiAgentProvider({model,bridgeUrl:'http://127.0.0.1:8767',maxCalls:80});
  globalThis.fetch=async (url,options)=>{
    fetchCalls++;
    assert(url==='http://127.0.0.1:8767/api/gemini/generateContent','Unexpected URL in mock fetch');
    assert(options.headers['X-Vlab-Bridge']==='1'&&!options.headers['x-goog-api-key'],'Bridge mock unexpectedly carries API key');
    const body=JSON.parse(options.body),parts=body.contents?.[0]?.parts;
    assert(await globalThis.__validate_gemini_bridge(body),'Production request rejected by Python bridge validator');
    assert(body.model===model&&Array.isArray(parts),'Production Gemini request shape invalid');
    assert(parts.some(p=>p.inlineData?.mimeType==='image/png'&&p.inlineData.data.length>50),'Camera PNG omitted');
    const context=JSON.parse(parts.find(p=>typeof p.text==='string').text.split('\n')[1]);
    walk(context);requestPhases.push(context.phase);
    assert(context.phase===pending.phase,'Phase lost through request contract');
    assert(body.tools?.[0]?.functionDeclarations.some(t=>t.name===pending.decision.tool),'Chosen tool missing from production declarations');
    if(context.phase===failPhase){failedAt=context.phase;actionsBeforeFault=engine.snapshot().actionCount;return {ok:false,status:503,json:async()=>({error:{message:'Explicit mock service failure'}})};}
    return {ok:true,status:200,json:async()=>({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:pending.decision.tool,args:{args:pending.decision.args,reason:'Explicit local oracle mock: '+pending.decision.reason,expected:pending.decision.expected}}}]}}],usageMetadata:usage})};
  };
  const provider={model,get calls(){return realProvider.calls;},abort(){realProvider.abort();},async decide(context,frame){
    phases.add(context.phase);walk(context);
    assert(Object.keys(frame).sort().join(',')==='height,pixels,width','Provider frame contains hidden state');
    let decision;
    if(context.phase==='onboarding')decision=engine._offlineDecision();
    else if(context.phase==='mission')decision=engine._control._offlineDecision();
    else decision=await engine._control._navigation._agent.call('decide',{strategy:'adaptive'});
    if(decision.tool==='write_driver')decision.args.source='// EXPLICIT LOCAL ORACLE MOCK: not generated by a real Gemini model.\n'+decision.args.source;
    pending={phase:context.phase,decision};
    const parsed=await realProvider.decide(context,frame);
    assert(parsed.source==='gemini'&&parsed.model===model,'Production provider returned incorrect source or model');
    assert(parsed.usage.promptTokenCount===12&&parsed.usage.candidatesTokenCount===8,'Production provider discarded usage');
    if(context.phase===mismatchPhase){mismatchAt=context.phase;actionsBeforeFault=engine.snapshot().actionCount;return {...parsed,source:'adaptive'};}
    return parsed;
  }};
  try{
    engine=new PickPlaceExperimentEngine({seed,strategy:'gemini',provider,recordFrames:false});
    let state=await engine.initialize(),steps=0;
    const initialTruth=JSON.stringify(state.diagnostics),originalPlant=engine._plant;
    while(!state.done&&steps++<800){
      state=await engine.next();
      assert(engine._plant===originalPlant,'Plant swapped between phases');
      if(!state.onboarding.ready)assert(state.actionCount===0&&JSON.stringify(state.diagnostics)===initialTruth,'Onboarding actuated physical mechanism');
    }
    const report=engine.report();
    assert(report.strategy==='gemini'&&report.languageModel===true&&report.model===model,'Gemini experiment provenance lost');
    assert(report.modelCalls===fetchCalls&&realProvider.calls===fetchCalls,'Mock wire/provider/engine call counts disagree');
    const decisions=report.trace.filter(event=>event.kind==='decision').map(event=>event.decision);
    assert(decisions.every(d=>d.source==='gemini'&&d.model===model),'Accepted decision silently relabeled as local adaptive');
    assert(report.provenance.usage.promptTokenCount===decisions.length*12||decisions.length===0&&!report.provenance.usage.promptTokenCount,'Prompt usage was not accumulated exactly');
    assert(report.provenance.usage.candidatesTokenCount===decisions.length*8||decisions.length===0&&!report.provenance.usage.candidatesTokenCount,'Candidate usage was not accumulated exactly');
    if(failPhase||mismatchPhase){
      assert(state.done&&state.failure&&!state.taskProgress.completed,'Fault did not stop Gemini experiment');
      assert((failPhase&&failedAt===failPhase)||(mismatchPhase&&mismatchAt===mismatchPhase),'Requested fault phase not exercised');
      assert(state.actionCount===actionsBeforeFault,'Fault produced physical action');
      const before=JSON.stringify(report),count=fetchCalls;
      await engine.next();
      assert(JSON.stringify(engine.report())===before&&count===fetchCalls,'Stopped engine continued or fell back');
      return {seed,mockOnly:true,failPhase,mismatchPhase,failedAt,mismatchAt,stopped:true,noFallback:true,noActuationAfterFault:true,actions:state.actionCount,mockRequests:fetchCalls,acceptedGeminiSourceDecisions:decisions.length,phases:[...phases]};
    }
    assert(state.done&&!state.failure&&state.taskProgress.completed,'Mock full workflow failed: '+JSON.stringify({failure:state.failure,task:state.taskProgress,steps}));
    assert(phases.size===3&&new Set(requestPhases).size===3,'Missing one of three Gemini request phases');
    assert(report.provenance.frontMode==='gemini-tools'&&report.provenance.driverSource==='gemini-generated','Model path provenance incorrect');
    assert(report.onboarding.driverSource.startsWith('// EXPLICIT LOCAL ORACLE MOCK:')&&report.onboarding.driverTests.passed,'Mock-supplied source did not compile and pass driver tests');
    const traffic=report.onboarding.traffic;
    const commands=traffic.filter(x=>!x.dryRun&&x.direction==='TX').map(x=>JSON.parse(x.wire)).filter(x=>['step','lift','grip'].includes(x.op));
    const acks=traffic.filter(x=>!x.dryRun&&x.direction==='RX').map(x=>JSON.parse(x.wire)).filter(x=>x.ok===true&&x.accepted!==undefined);
    const xy=commands.filter(x=>x.op==='step').length,aux=commands.length-xy;
    assert(commands.length===report.actionCount&&acks.length===commands.length,'Action counts mismatch actual driver traffic');
    assert(report.xyActionCount===xy&&report.auxiliaryActionCount===aux,'XY/auxiliary counts mismatch traffic');
    const final=state.toolResult?.data,truth=state.diagnostics.pickPlace;
    assert(final?.source==='new-camera-frame'&&Object.values(final.checks).every(Boolean),'Fresh image verification not fully passed');
    assert(truth.placed&&!truth.held&&truth.lift==='up'&&truth.gripper==='open'&&truth.graspCount===1&&truth.releaseCount===1,'Evaluator mechanism contradicts image success');
    assert(report.missionEvidence.grasp&&report.missionEvidence.coMotion&&report.missionEvidence.release,'Missing grasp/transport/release visual evidence');
    return {seed,mockOnly:true,completed:true,transport:report.onboarding.connection.transport,mockRequests:fetchCalls,acceptedGeminiSourceDecisions:decisions.length,phases:[...phases],xyActions:xy,auxiliaryActions:aux,totalActions:commands.length,placementErrorPx:final.placementError,checks:final.checks,finalSource:final.source,usageFixture:report.provenance.usage,driverSourceHash:report.onboarding.driverTests.sourceHash,actualCommandsAndAcksMatch:true,samePlantAcrossAllPhases:true,privilegedInputsExcluded:true,sourceFixture:'gemini',decisionOracle:'explicit local adaptive oracle; not a Gemini model'};
  }finally{engine?.dispose();realProvider.dispose();globalThis.fetch=originalFetch;}
}'''


if __name__ == '__main__':
    main()
