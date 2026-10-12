"""Recovery event presentation tests; local UI fixtures, no model/API calls.

The real app renders a fixture engine's public event contract. Engine retry
semantics and actual provider validation are tested separately.
"""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ENTRIES = {
    'STYLES': 'src/styles.css', 'THREE': 'vendor/three.min.js',
    'PLANT': 'src/plant.js', 'CONTROLLER': 'src/controller.js',
    'AGENT': 'src/agent-core.js', 'CLAUDE_PROVIDER': 'src/claude-provider.js',
    'GEMINI_PROVIDER': 'src/gemini-provider.js', 'DEVICE_LINK': 'src/device-link.js',
    'DRIVER_RUNTIME': 'src/driver-runtime.js', 'ENGINE': 'src/engine.js',
    'ONBOARDING': 'src/onboarding.js', 'PICK_PLACE': 'src/pick-place.js',
    'SCENE': 'src/scene3d.js', 'BENCHMARK': 'src/benchmark.js', 'APP': 'src/app.js',
}

FIXTURE = r'''
window.__fixtureScenario='exhaust';
window.PickPlaceExperimentEngine=class {
  constructor(){this.items=[];this.n=0;this.scenario=window.__fixtureScenario;}
  get historyLength(){return this.items.length;}
  async initialize(){return this.emit({kind:'ready',title:'已校正，準備靠近物件'});}
  emit(extra){
    const state={strategy:'claude',done:false,failure:null,decision:null,
      eventIndex:this.items.length,actionCount:9,probeCount:7,modelCalls:19+this.n,
      onboarding:{ready:true,phase:'start_control',status:'ready',
        completed:['inspect_device'],connection:{connected:true},handshake:{ok:true},
        driverTests:{passed:true,tests:[]},driverSource:'// explicit UI fixture'},
      taskProgress:{phase:'approach',label:'自我校正並靠近物件',completed:false},
      jacobian:[[2,0],[0,2]],...extra};
    this.items.push(state);return this.snapshot();
  }
  snapshot(){return {...this.items.at(-1),events:this.items.map(e=>({...e}))};}
  review(index){return {...this.items[index],events:this.items.slice(0,index+1)};}
  report(){return {mockOnly:true,trace:this.items};}
  dispose(){}
  async next(){
    this.n++;
    if(this.scenario==='repair'&&this.n===2)return this.emit({kind:'decision',
      title:'模型已修正決策',decision:{tool:'probe',args:{},source:'claude',
      reason:'明確標記的 UI 測試資料',expected:'執行下一個校正工具'}});
    if(this.scenario==='repair'&&this.n>2)return this.emit({kind:'pick-place-complete',
      title:'明確標記的 UI 完成狀態資料',done:true,taskProgress:{completed:true,placementError:2}});
    const auth=this.scenario==='auth',terminal=auth||this.n===3;
    return this.emit({kind:terminal?'failure':'decision-rejected',
      title:terminal?'模型控制已停止':'決策被拒絕，等待修正',
      done:terminal,failure:terminal?'明確標記的 UI 停止狀態資料':null,
      decisionDiagnostic:auth?{code:'AUTHENTICATION_ERROR',issue:'provider-error',message:'API 金鑰驗證失敗。'}:
        this.n===2?{code:'INVALID_ARGUMENTS',issue:'invalid-arguments',
          message:'工具 args 的欄位、型別或數值範圍不符合契約；這次未執行動作。',invalidFields:['amplitude']}:
        {code:'INVALID_DECISION',issue:'invalid-envelope',
          message:'工具輸入必須包含 args、reason；expected 為選填欄位，且不得有額外欄位；這次未執行動作。',
          missingFields:['reason'],extraFieldCount:1},
      decisionRecovery:{attempt:auth?0:this.n,maxCorrections:2,willRetry:!terminal},
      toolResult:{summary:'本次未執行；保留進度。'}});
  }
};
'''


def html_payload():
    html = (ROOT / 'src/index.template.html').read_text(encoding='utf-8')
    for key, filename in ENTRIES.items():
        source = (ROOT / filename).read_text(encoding='utf-8')
        if key == 'APP':
            source = FIXTURE + source
        if key != 'STYLES':
            source = re.sub(r'</script', lambda _: '<\\/script', source, flags=re.I)
        html = html.replace('/*__' + key + '__*/', source)
    return html


def main():
    requests, errors, checks = [], [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            headless=True, args=['--disable-background-networking', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        context.route('**/*', lambda route: (requests.append(route.request.url), route.abort()))
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(html_payload())
        page.wait_for_function('window.experimentLab?.ready')
        assert page.evaluate('experimentLab.version') == '0.5.3'
        page.evaluate('experimentLab.next()')
        assert page.locator('#status-label').inner_text() == '決策待修正'
        assert page.locator('#next-btn').inner_text() == '請模型修正 →'
        assert page.locator('#next-btn').is_enabled() and page.locator('#play-btn').is_enabled()
        assert '缺少：reason' in page.locator('#decision-reason').inner_text()
        assert '額外欄位：1' in page.locator('#decision-reason').inner_text()
        assert '2／2' in page.locator('#decision-expected').inner_text()
        assert '連線、驅動、校正資料' in page.locator('#decision-result').inner_text()
        assert page.locator('#probe-value').inner_text() == '7'
        assert page.locator('#action-value').inner_text() == '9'
        assert page.locator('#device-state-label').inner_text() == '控制通道已開啟'
        checks.append('first rejection shows exact reason, retained progress and enabled correction')
        for width, height in [(1440, 900), (1366, 768), (390, 844)]:
            page.set_viewport_size({'width': width, 'height': height})
            for tab in ['overview', 'evidence', 'driver', 'records', 'settings']:
                page.evaluate('(tab)=>experimentLab.showPage(tab)', tab)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight'), (width, height, tab)
        checks.append('15 page/viewport combinations fit without outer scrolling')
        page.set_viewport_size({'width': 1440, 'height': 900})
        page.evaluate("experimentLab.showPage('records')")
        assert page.locator('#decision-diagnostic-details').is_visible()
        page.locator('#decision-diagnostic-details summary').click()
        assert 'invalid-envelope' in page.locator('#decision-diagnostic').inner_text()
        assert '接手流程已完成' in page.locator('#outcome-note').inner_text()
        page.evaluate('experimentLab.next()')
        assert '1／2' in page.locator('#decision-expected').text_content()
        assert '不合法：amplitude' in page.locator('#decision-reason').text_content()
        page.evaluate('experimentLab.next()')
        assert page.locator('#status-label').inner_text() == '決策修正未通過'
        assert page.locator('#next-btn').is_disabled() and page.locator('#play-btn').is_disabled()
        assert '接手流程已完成' in page.locator('#outcome-note').inner_text()
        checks.append('terminal rejection stops controls and distinguishes successful onboarding')
        page.evaluate('experimentLab.review(1)')
        assert page.locator('#status-label').inner_text() == '歷史回看'
        assert '2／2' in page.locator('#decision-expected').text_content()
        assert page.locator('#next-btn').is_disabled()
        checks.append('history review shows original rejection without enabling execution')
        page.evaluate("async()=>{window.__fixtureScenario='repair';await experimentLab.reset();experimentLab.showPage('overview');}")
        page.locator('#pause-checkpoints').check()
        page.locator('#speed-select').select_option('0')
        page.click('#play-btn')
        page.wait_for_function("experimentLab.state().current.kind==='decision-rejected'&&!experimentLab.state().running&&!experimentLab.state().busy")
        assert page.locator('#next-btn').is_enabled()
        assert page.evaluate('experimentLab.state().historyLength') == 2
        page.locator('#pause-checkpoints').uncheck()
        page.click('#play-btn')
        page.wait_for_function('experimentLab.state().current.done&&!experimentLab.state().busy')
        assert page.locator('#status-label').inner_text() == '取放驗證完成'
        assert page.locator('#decision-diagnostic-details').is_hidden()
        checks.append('checkpoint pauses rejected decision; autoplay continues after correction')
        page.evaluate("async()=>{window.__fixtureScenario='auth';await experimentLab.reset();await experimentLab.next();}")
        assert page.locator('#status-label').inner_text() == '模型呼叫已停止'
        assert '尚可修正' not in page.locator('#decision-expected').text_content()
        assert page.locator('#next-btn').is_disabled()
        checks.append('provider authentication stop does not offer correction retries')
        assert not requests, requests
        assert not errors, errors
        browser.close()
    result = {'passed': True, 'mockOnly': True, 'liveModelCalls': 0,
              'scope': 'Real app rendering explicit engine-event fixtures; no engine correctness claim.',
              'checks': checks, 'externalRequests': requests, 'pageErrors': errors}
    out = ROOT / 'validation/recovery-ui-mock.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
