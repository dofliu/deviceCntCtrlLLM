"""Local-only Gemini UI integration. All API replies below are fixtures."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import json
import re
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
entries={'STYLES':'src/styles.css','THREE':'vendor/three.min.js','PLANT':'src/plant.js',
 'CONTROLLER':'src/controller.js','AGENT':'src/agent-core.js',
 'CLAUDE_PROVIDER':'src/claude-provider.js','GEMINI_PROVIDER':'src/gemini-provider.js',
 'DEVICE_LINK':'src/device-link.js','DRIVER_RUNTIME':'src/driver-runtime.js',
 'ENGINE':'src/engine.js','ONBOARDING':'src/onboarding.js','PICK_PLACE':'src/pick-place.js',
 'SCENE':'src/scene3d.js','BENCHMARK':'src/benchmark.js','APP':'src/app.js'}
html=(ROOT/'src/index.template.html').read_text(encoding='utf-8')
for key,name in entries.items():
    source=(ROOT/name).read_text(encoding='utf-8')
    if key!='STYLES':source=re.sub(r'</script',lambda m:'<\\/script',source,flags=re.I)
    html=html.replace('/*__'+key+'__*/',source)
payload=html.encode('utf-8')

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length',str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port)
api=[]
errors=[]
mode={'status':200}
def route_api(route):
    request=route.request
    api.append({'method':request.method,'path':request.url.split(origin,1)[-1]})
    if mode['status']!=200:
        route.fulfill(status=mode['status'],json={'error':'fixture missing credential'})
    elif '/models' in request.url:
        route.fulfill(json={'models':[{'name':'models/gemini-ui-fixture','displayName':'UI fixture only','supportedGenerationMethods':['generateContent']}]})
    else:
        route.fulfill(json={'candidates':[{'finishReason':'STOP','content':{'parts':[{'functionCall':{'name':'inspect_device','args':{'args':{'deviceClass':'桌面平面手臂','visibleAxes':2,'modelLabel':'VLAB-P2','uncertainties':'影像未提供尺寸與通訊協定'},'reason':'測試用回覆：從影像先記錄外觀。','expected':'取得未確認的設備假設。'}}}]}}],'usageMetadata':{'promptTokenCount':1,'candidatesTokenCount':1,'totalTokenCount':2}})

try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--disable-background-networking','--enable-unsafe-swiftshader'])
        context=browser.new_context(viewport={'width':1440,'height':900})
        context.route('**/api/gemini/**',route_api)
        page=context.new_page()
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(origin+'/?agent=gemini')
        page.wait_for_function('window.experimentLab?.ready')
        assert not api,'Preset must not spend API calls'
        assert page.locator('#strategy-select').input_value()=='gemini'
        assert page.evaluate('experimentLab.state().page')=='settings'
        assert page.locator('#bridge-url').input_value()==origin
        assert page.locator('#provider-heading').inner_text()=='Gemini 連線'
        assert 'gemini_api_key' in page.locator('#bridge-command').text_content()
        page.click('#refresh-models-btn')
        page.wait_for_function("document.querySelector('#model-input').value==='gemini-ui-fixture'")
        assert len(api)==1 and api[0]['method']=='GET'
        page.click('#apply-settings-btn')
        page.wait_for_function("experimentLab.state().current.strategy==='gemini' && !experimentLab.state().busy")
        assert len(api)==1,'Applying settings must not spend API calls'
        decision=page.evaluate('async()=>await experimentLab.next()')
        assert decision['decision']['source']=='gemini' and decision['decision']['tool']=='inspect_device',decision
        assert page.locator('#decision-source').inner_text()=='Gemini 回應'
        page.evaluate('async()=>await experimentLab.next()')
        page.click('#tab-evidence')
        assert 'Gemini 影像判讀' in page.locator('#hypothesis-detail').inner_text()
        assert len(api)==2 and api[-1]['method']=='POST'
        page.click('#tab-settings')
        mode['status']=503
        page.click('#refresh-models-btn')
        page.wait_for_function("document.querySelector('#provider-status').textContent.includes('金鑰') && !experimentLab.state().busy")
        assert '無法取得模型' in page.locator('#provider-status').inner_text()
        page.select_option('#claude-access','direct')
        page.fill('#api-key','fixture-only-never-a-real-key')
        page.select_option('#strategy-select','claude')
        assert page.locator('#api-key').input_value()==''
        assert page.locator('#model-input').input_value()==''
        assert page.locator('#model-list option').count()==0
        assert page.locator('#provider-heading').inner_text()=='Claude 連線'
        assert page.locator('#bridge-url').input_value()=='http://127.0.0.1:8766'
        page.select_option('#strategy-select','gemini')
        assert page.locator('#bridge-url').input_value()=='http://127.0.0.1:8767'
        page.select_option('#claude-access','bridge')
        dimensions=[]
        for width,height in [(1440,900),(1366,768),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            for tab in ['overview','evidence','driver','records','settings']:
                page.click('#tab-'+tab)
                bounds=page.evaluate('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,bw:document.body.scrollWidth,bh:document.body.scrollHeight})')
                assert bounds['w']<=width and bounds['bw']<=width,(tab,width,bounds)
                assert bounds['h']<=height and bounds['bh']<=height,(tab,height,bounds)
                dimensions.append({'viewport':[width,height],'tab':tab,'wholePageOverflow':False})
        assert not errors,errors
        result={'passed':True,'realAPI':False,'fixturesOnly':True,'presetNoAutomaticCalls':True,'applyNoAutomaticCalls':True,'geminiDecisionAndEvidenceLabels':True,'providerSwitchClearsKeyAndModel':True,'missingKeyVisible':True,'viewports':dimensions,'pageErrors':errors,'mockRequests':api}
        (ROOT/'validation/gemini-ui.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'passed':True,'realAPI':False,'viewportChecks':len(dimensions),'pageErrors':errors}))
        browser.close()
finally:
    server.shutdown()
    server.server_close()
