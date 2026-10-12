"""Real browser integration: generated driver, image control and pick/place."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

async def main():
    results=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
        for seed in [42,1]:
            page=await browser.new_page()
            await page.set_content('<!doctype html><html><body></body></html>')
            for name,element_id in [('controller.js','controller-source'),('agent-core.js','agent-source')]:
                await page.evaluate('([id,source])=>{const el=document.createElement("script");el.id=id;el.type="text/plain";el.textContent=source;document.body.append(el)}',[element_id,(ROOT/'src'/name).read_text(encoding='utf-8')])
            for name in ['plant.js','device-link.js','driver-runtime.js','engine.js','onboarding.js','pick-place.js']:
                await page.add_script_tag(content=(ROOT/'src'/name).read_text(encoding='utf-8'))
            result=await page.evaluate('''async seed=>{
                const e=new PickPlaceExperimentEngine({seed,recordFrames:false});
                await e.initialize();let state=e.snapshot(),steps=0,preReadyChanges=[];
                const initial=JSON.stringify(e._plant.diagnostics().pickPlace);
                while(!state.done&&steps++<360){state=await e.next();
                    if(!state.onboarding.ready&&JSON.stringify(e._plant.diagnostics().pickPlace)!==initial)preReadyChanges.push(steps);
                }
                const report=e.report(),truth=e._plant.diagnostics().pickPlace;
                const out={seed,steps,done:report.done,failure:report.failure,task:report.taskProgress,
                  actions:report.actionCount,xy:report.xyActionCount,auxiliary:report.auxiliaryActionCount,
                  truth,preReadyChanges,trace:report.trace.map(s=>({kind:s.kind,phase:s.taskProgress?.phase,tool:s.decision?.tool,title:s.title,explanation:s.explanation})),
                  traffic:report.onboarding.traffic};
                e.dispose();return out;
            }''',seed)
            results.append(result)
            await page.close()
        await browser.close()
    (ROOT/'validation').mkdir(exist_ok=True)
    (ROOT/'validation'/'mission-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    for r in results:
        print(json.dumps({k:v for k,v in r.items() if k not in ['traffic','trace']},ensure_ascii=True))
        assert r['done'] and not r['failure'],r['failure']
        assert r['task']['completed'] and r['task']['graspVerified'] and r['task']['coMotionVerified']
        assert r['auxiliary']==8
        assert not r['preReadyChanges']

if __name__=='__main__':
    asyncio.run(main())
