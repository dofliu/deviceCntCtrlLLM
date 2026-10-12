"""Small browser harness to validate the production engine without the layout."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'work' / 'v5-live-core.html'
def content(name):
    return re.sub('</script', r'<\\/script', (ROOT / 'src' / name).read_text(encoding='utf-8'), flags=re.I)
parts = ['<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>V5 core validation harness</title><canvas id="camera" width="640" height="480"></canvas><pre id="status"></pre>']
for name in ['plant.js', 'controller.js', 'agent-core.js', 'claude-provider.js',
             'device-link.js', 'driver-runtime.js', 'engine.js', 'onboarding.js', 'pick-place.js']:
    attrs = ' id="controller-source" type="text/plain"' if name == 'controller.js' else ' id="agent-source" type="text/plain"' if name == 'agent-core.js' else ''
    parts.append('<script' + attrs + '>' + content(name) + '</script>')
parts.append('''<script>
let engine,provider;
function paint(){const s=engine.snapshot();if(s.frame?.pixels)document.querySelector('#camera').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.frame.pixels),640,480),0,0);document.querySelector('#status').textContent=JSON.stringify({title:s.title,actions:s.actionCount,modelCalls:s.modelCalls,task:s.taskProgress,failure:s.failure},null,2);}
async function configure(options={}){engine?.dispose();provider?.dispose();provider=options.strategy==='claude'?new ClaudeAgentProvider({model:options.model,bridgeUrl:options.bridgeUrl,maxCalls:80,timeoutMs:45000}):null;engine=new PickPlaceExperimentEngine({seed:options.seed||42,strategy:options.strategy||'adaptive',provider,recordFrames:true});await engine.initialize();paint();return true;}
window.experimentLab={ready:false,configure,async next(){await engine.next();paint();return true;},state:()=>({current:engine.snapshot()}),report:()=>engine.report()};
configure().then(()=>experimentLab.ready=true);
</script></html>''')
OUT.parent.mkdir(exist_ok=True)
OUT.write_text('\n'.join(parts), encoding='utf-8')
print(OUT)
