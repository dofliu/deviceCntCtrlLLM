"""Exercise the delivered UI: real auto-run, replay, tabs, viewport bounds."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'validation'
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--disable-gpu-sandbox','--enable-unsafe-swiftshader'])
    page=browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.goto((ROOT/'unknown-device-v5.3.html').as_uri())
    page.wait_for_function('window.experimentLab?.ready')
    assert not page.locator('#pause-checkpoints').is_checked()
    assert page.evaluate('experimentLab.state().current.actionCount')==0
    assert page.evaluate('experimentLab.state().current.taskProgress?.completed') is not True
    page.screenshot(path=str(OUT/'ui-desktop-initial.png'))
    page.select_option('#speed-select','0')
    page.click('#play-btn')
    page.wait_for_function('experimentLab.state().current.done && !experimentLab.state().busy',timeout=120000)
    result=page.evaluate('({task:experimentLab.state().current.taskProgress, failure:experimentLab.state().current.failure, actions:experimentLab.state().current.actionCount, history:experimentLab.state().historyLength})')
    assert result['task']['completed'] and not result['failure'], result
    before=page.evaluate('JSON.stringify(experimentLab.report())')
    page.click('#back-btn')
    assert page.evaluate('experimentLab.state().reviewIndex') is not None
    assert not page.locator('#play-btn').is_enabled()
    page.click('#live-btn')
    assert page.evaluate('JSON.stringify(experimentLab.report())')==before
    page.screenshot(path=str(OUT/'ui-desktop-complete.png'))
    dimensions=[]
    for width,height in [(1440,900),(1366,768),(390,844)]:
        page.set_viewport_size({'width':width,'height':height})
        for tab in ['overview','evidence','driver','records','settings']:
            page.click('#tab-'+tab)
            bounds=page.evaluate('''() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,playBottom:document.querySelector('#play-btn').getBoundingClientRect().bottom,tabCount:[...document.querySelectorAll('.page')].filter(e=>!e.hidden).length})''')
            assert bounds['scrollWidth']<=width and bounds['bodyWidth']<=width, (width,tab,bounds)
            assert bounds['scrollHeight']<=height and bounds['bodyHeight']<=height, (width,tab,bounds)
            assert bounds['playBottom']<=height and bounds['tabCount']==1,(width,tab,bounds)
            dimensions.append({'viewport':[width,height],'tab':tab,**bounds})
        page.click('#tab-overview')
        page.screenshot(path=str(OUT/f'ui-{width}x{height}.png'))
    assert not errors,errors
    data={'passed':True,'uiAutoRun':result,'replayDoesNotMutate':True,'defaultCheckpointPause':False,'viewports':dimensions,'pageErrors':errors}
    (OUT/'ui-validation.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(data,ensure_ascii=True))
    browser.close()
