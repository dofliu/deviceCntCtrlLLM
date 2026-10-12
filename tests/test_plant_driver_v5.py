"""Stateful mechanics and generated-driver integration (no network or API key)."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

SCRIPT = r"""async () => {
  const checks=[];
  const assert=(condition,name)=>{if(!condition)throw new Error(name);checks.push(name);};
  const near=(a,b,t=1e-7)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<t);
  const copy=x=>JSON.parse(JSON.stringify(x));
  const centroid=(frame,test)=>{let x=0,y=0,n=0;for(let i=0;i<frame.pixels.length;i+=4){const p=frame.pixels;if(test(p[i],p[i+1],p[i+2])){const k=i/4;x+=k%frame.width;y+=Math.floor(k/frame.width);n++;}}return n?[x/n,y/n]:null;};
  for(const seed of [42,1]) {
    const plant=new VirtualPlant({seed});
    const link=new SimulatedDeviceLink({plant,seed});
    const runtime=new DriverRuntime();
    const manual=link.manual('VLAB-P2');
    const endpoint=link.inventory().find(x=>x.deviceModel==='VLAB-P2');
    link.connect({...manual.connection,endpointId:endpoint.endpointId});
    const hello=link.handshake();
    assert(hello.capabilities.grip.includes('closed'),'capabilities-'+seed);
    const before=JSON.stringify(plant.diagnostics());
    await runtime.compile(manual.sampleDriverSource);
    const tests=await runtime.test(link);
    assert(tests.passed,'generic-driver-tests-'+seed);
    assert(JSON.stringify(plant.diagnostics())===before,'dry-run-no-state-change-'+seed);
    const rejected=JSON.parse(link.exchange('{"op":"grip","state":"closed","extra":1}\n'));
    assert(!rejected.ok,'malformed-grip-rejected-'+seed);
    await runtime.operate({op:'grip',state:'closed'},link);
    assert(!plant.diagnostics().pickPlace.held,'closing-high-does-not-grasp-'+seed);
    await runtime.operate({op:'lift',position:'down'},link);
    await runtime.operate({op:'grip',state:'open'},link);
    await runtime.operate({op:'grip',state:'closed'},link);
    assert(!plant.diagnostics().pickPlace.held,'closing-far-does-not-grasp-'+seed);

    // The test fixture may use evaluator geometry; production agents may not.
    const driveTo=async target=>{
      const g=plant.diagnostics().geometry,[l1,l2]=g.lengths;
      const q1=Math.acos(Math.max(-1,Math.min(1,(target[0]**2+target[1]**2-l1*l1-l2*l2)/(2*l1*l2))));
      const q0=Math.atan2(target[1],target[0])-Math.atan2(l2*Math.sin(q1),l1+l2*Math.cos(q1));
      const goal=[q0,q1];
      for(let k=0;k<90;k++){
        const current=plant.diagnostics().geometry;
        const delta=goal.map((v,i)=>{let d=v-current.jointAngles[i];if(i===0)d=((d+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;return d;});
        if(Math.hypot(...delta)<1e-8)return;
        const command=current.channelToJoint.map((j,c)=>Math.max(-.1,Math.min(.1,delta[j]/current.channelGains[c])));
        await runtime.act(command,link);
      }
      throw new Error('Fixture IK move exceeded limit.');
    };
    await runtime.operate({op:'grip',state:'open'},link);
    await runtime.operate({op:'lift',position:'up'},link);
    await driveTo(plant.diagnostics().pickPlace.object);
    await runtime.operate({op:'lift',position:'down'},link);
    const closeAck=await runtime.operate({op:'grip',state:'closed'},link);
    assert(plant.diagnostics().pickPlace.held,'near-low-closing-attaches-'+seed);
    assert(!('held' in closeAck)&&!('held' in JSON.parse(closeAck.reply)),'ack-does-not-leak-held-'+seed);
    await runtime.operate({op:'lift',position:'up'},link);
    const frame=plant.frame();
    const orange=centroid(frame,(r,g,b)=>r>220&&g>135&&g<200&&b<90);
    const cyan=centroid(frame,(r,g,b)=>r<90&&g>175&&b>150);
    assert(orange&&cyan&&Math.abs(orange[0]-cyan[0])<1.5&&Math.abs((cyan[1]-orange[1])-18)<1.5,'raised-object-visible-offset-'+seed);
    await runtime.act([.04,0],link);
    const carry=plant.diagnostics();
    assert(near(carry.manipulation.object,carry.tip),'held-object-follows-actual-tip-'+seed);
    const releasePosition=copy(carry.pickPlace.object);
    await runtime.operate({op:'grip',state:'open'},link);
    assert(near(plant.diagnostics().pickPlace.object,releasePosition),'release-keeps-actual-xy-'+seed);
    assert(!plant.diagnostics().pickPlace.held&&plant.diagnostics().pickPlace.objectHeight===0,'release-falls-to-table-'+seed);
    assert(!plant.diagnostics().pickPlace.placed,'wrong-release-does-not-succeed-'+seed);
    await runtime.act([.03,0],link);
    assert(near(plant.diagnostics().pickPlace.object,releasePosition),'released-object-stays-after-retreat-'+seed);
    await driveTo(plant.diagnostics().pickPlace.object);
    await runtime.operate({op:'lift',position:'down'},link);
    await runtime.operate({op:'grip',state:'closed'},link);
    await runtime.operate({op:'lift',position:'up'},link);
    await driveTo(plant.diagnostics().pickPlace.destination);
    await runtime.operate({op:'lift',position:'down'},link);
    await runtime.operate({op:'grip',state:'open'},link);
    assert(plant.diagnostics().pickPlace.placed,'actual-destination-release-placed-'+seed);
    const traffic=link.traffic();
    assert(traffic.some(x=>x.direction==='TX'&&!x.dryRun&&x.wire.includes('"lift"')),'lift-traverses-real-wire-'+seed);
    assert(traffic.some(x=>x.direction==='TX'&&!x.dryRun&&x.wire.includes('"grip"')),'grip-traverses-real-wire-'+seed);
    runtime.dispose();
  }
  const runaway=new DriverRuntime({timeoutMs:150});
  let timedOut=false;
  try { await runaway.compile('while(true) {} function encode(x){return x;} function decode(x){return x;}'); }
  catch(error) { timedOut=error.code==='DRIVER_EXECUTION_TIMEOUT'; }
  runaway.dispose();
  assert(timedOut,'explicit-short-timeout-terminates-infinite-driver');
  let responsive=false;await new Promise(resolve=>setTimeout(()=>{responsive=true;resolve();},0));
  assert(responsive,'host-remains-responsive-after-worker-termination');
  return {passed:true,checks,scope:'Direct plant + generated driver; mission policy tested separately.',defaultDriverTimeoutMs:5000};
}"""

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page()
        page.set_content('<!doctype html><meta charset="utf-8"><body></body>')
        for name in ('plant.js','device-link.js','driver-runtime.js'):
            page.add_script_tag(content=(ROOT/'src'/name).read_text(encoding='utf-8'))
        result = page.evaluate(SCRIPT)
        browser.close()
    path=ROOT/'validation'/'plant-driver-v5.json'
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'passed':result['passed'],'checks':len(result['checks']),'report':str(path)}))

if __name__ == '__main__':
    main()
