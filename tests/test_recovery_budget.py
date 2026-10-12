"""A rejected real-provider response consumes budget; correction cannot exceed it.

Both provider HTTP boundaries are mocked locally. No credential or external API
is used, and the browser aborts any unmocked network request.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


RUN = r'''async strategy=>{
  const assert=(v,m)=>{if(!v)throw Error(m);};
  let wireCalls=0,decideCalls=0;const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{
    wireCalls++;
    const input={args:{},reason:'',expected:'explicit local invalid-response fixture'};
    const data=strategy==='claude'?{
      stop_reason:'tool_use',content:[{type:'tool_use',name:'inspect_device',input}],
      usage:{input_tokens:7,output_tokens:3}
    }:{
      candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'inspect_device',args:input}}]}}],
      usageMetadata:{promptTokenCount:7,candidatesTokenCount:3,totalTokenCount:10}
    };
    return {ok:true,status:200,json:async()=>data};
  };
  const Provider=strategy==='claude'?ClaudeAgentProvider:GeminiAgentProvider;
  const real=new Provider({model:strategy+'-explicit-budget-mock',bridgeUrl:'http://127.0.0.1:8767',maxCalls:1});
  const provider={get model(){return real.model;},get calls(){return real.calls;},abort(){real.abort();},
    async decide(...args){decideCalls++;return real.decide(...args);}};
  const engine=new PickPlaceExperimentEngine({seed:42,strategy,provider,recordFrames:false});
  try{
    const initial=await engine.initialize(),truth=JSON.stringify(initial.diagnostics);
    let state=await engine.next();
    assert(state.kind==='decision-rejected'&&!state.done&&!state.failure,'Initial malformed decision should request correction');
    assert(state.decisionRecovery.attempt===1&&state.decisionRecovery.willRetry,'Correction count incorrect');
    assert(state.decisionDiagnostic.issue==='invalid-reason','Specific reason diagnostic lost');
    assert(state.actionCount===0&&state.commandAttemptCount===0&&JSON.stringify(state.diagnostics)===truth,'Rejected decision caused actuation');
    assert(state.modelCalls===1&&wireCalls===1&&real.calls===1,'Rejected request omitted from budget');
    state=await engine.next();
    assert(state.done&&state.failure&&state.decisionDiagnostic.code==='CALL_BUDGET','Budget exhaustion must stop correction');
    assert(!state.decisionRecovery.willRetry,'Budget error must not retry');
    assert(decideCalls===2&&wireCalls===1&&real.calls===1&&state.modelCalls===1,'Budget preflight counted as another API request');
    assert(state.actionCount===0&&JSON.stringify(state.diagnostics)===truth,'Budget stop changed physical state');
    const report=engine.report(),usage=report.provenance.usage;
    assert(report.decisionRejections===1,'Budget failure counted as another rejected response');
    assert(usage[strategy==='claude'?'input_tokens':'promptTokenCount']===7,'Rejected-response usage omitted or double counted');
    assert(usage[strategy==='claude'?'output_tokens':'candidatesTokenCount']===3,'Rejected-response output usage missing');
    assert(report.provenance.frontCalls===1&&report.provenance.controlCalls===0,'Phase request accounting incorrect');
    const stopped=JSON.stringify(report);await engine.next();await engine.next();
    assert(JSON.stringify(engine.report())===stopped&&decideCalls===2&&wireCalls===1,'Stopped engine requested more decisions');
    return {strategy,passed:true,mockOnly:true,liveAPICalls:0,wireCalls,decideCalls,
      rejectedResponses:report.decisionRejections,reportedModelCalls:report.modelCalls,
      failureCode:state.decisionDiagnostic.code,usage,noAction:true,noFallback:true,noCallsAfterStop:true};
  }finally{engine.dispose();real.dispose();globalThis.fetch=originalFetch;}
}'''


def main():
    results = []
    attempted = []
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            headless=True, args=['--disable-background-networking'])
        context = browser.new_context()
        context.route('**/*', lambda route: (attempted.append(route.request.url), route.abort()))
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<!doctype html><html><body></body></html>')
        for name in ['plant', 'device-link', 'driver-runtime', 'engine', 'onboarding',
                     'pick-place', 'claude-provider', 'gemini-provider']:
            page.add_script_tag(content=(ROOT / f'src/{name}.js').read_text(encoding='utf-8'))
        try:
            for strategy in ['claude', 'gemini']:
                results.append(page.evaluate(RUN, strategy))
            assert not attempted, attempted
            assert not errors, errors
        finally:
            browser.close()
    out = ROOT / 'validation' / 'recovery-budget-mock.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({'passed': True, 'externalRequests': attempted,
                               'pageErrors': errors, 'results': results},
                              ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=True))


if __name__ == '__main__':
    main()
