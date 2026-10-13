"""Bridge/provider parity: every tool the Claude/Gemini providers can send must be
accepted by the local bridges, including full-size generated driver and
controller sources. Mock only: provider requests are captured with a fake fetch;
no key lookup and no upstream network.

Added after a command-line run failed at the first write_controller request:
both bridge allowlists still lacked the V7 controller tools."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


claude_bridge, gemini_bridge = load("claude_bridge"), load("gemini_bridge")

NODE = r"""
const {createRuntime}=require('./tests/headless-runtime.cjs');
(async()=>{
  const g=createRuntime({extraSources:['gemini-provider.js']}).global, C=g.VlabAgentContract, names=[...C.toolNames];
  const blob=g.URL; class HostURL extends URL {} HostURL.createObjectURL=b=>blob.createObjectURL(b); g.URL=HostURL; Object.assign(g,{AbortController,URLSearchParams,TextEncoder,TextDecoder});
  const frame={dataURL:'data:image/png;base64,'+C.cameraPNG(new g.VirtualPlant({seed:2026,width:640,height:480}).frame())};
  const big='/*'+'x'.repeat(29990)+'*/';
  const contexts=['onboarding','control','mission'].map(phase=>({phase,allowedTools:names,controllerMode:'generated',controllerContract:g.VlabControllerModule.CONTRACT,
    controllerSource:big,driverSource:big,budgets:{actionsUsed:0,maxActions:180,decisionsUsed:0,maxDecisions:300}}));
  const out={names,claude:[],gemini:[]};
  for(const [kind,Ctor,reply] of [['claude',g.ClaudeAgentProvider,n=>({stop_reason:'tool_use',content:[{type:'tool_use',id:'t',name:n,input:{args:{},reason:'r'}}],usage:{input_tokens:1,output_tokens:1}})],
                                  ['gemini',g.GeminiAgentProvider,n=>({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:n,args:{args:{},reason:'r'}}}]}}]})]]){
    for(const context of contexts){
      let body=null;
      g.fetch=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>reply('stop')};};
      const provider=new Ctor({bridgeUrl:'http://127.0.0.1:8766',model:kind==='claude'?'claude-mock-1':'models/gemini-mock',maxCalls:5,minIntervalMs:0,maxRateLimitRetries:0});
      let error=null;try{await provider.decide(context,frame);}catch(e){error=String(e.code||'')+' '+String(e.message).slice(0,200);}
      out[kind].push({phase:context.phase,body,error});
    }
  }
  console.log(JSON.stringify(out));
})();
"""


class BridgeToolParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", "-e", NODE], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120, check=True)
        cls.data = json.loads(result.stdout.strip().splitlines()[-1])

    def test_01_every_provider_tool_is_allowlisted(self):
        names = set(self.data["names"])
        self.assertIn("write_controller", names)
        self.assertIn("test_controller", names)
        self.assertEqual(names - claude_bridge.TOOLS, set())
        self.assertEqual(names - gemini_bridge.TOOLS, set())

    def test_02_full_size_claude_requests_pass_bridge_validation(self):
        sent = set()
        for item in self.data["claude"]:
            self.assertIsNotNone(item["body"], f'{item["phase"]}: {item["error"]}')
            self.assertTrue(claude_bridge.validate_message(item["body"]), item["phase"])
            sent |= {tool["name"] for tool in item["body"]["tools"]}
        self.assertIn("write_controller", sent)
        self.assertIn("test_controller", sent)

    def test_03_full_size_gemini_requests_pass_bridge_validation(self):
        validate = gemini_bridge.validate_message
        sent = set()
        for item in self.data["gemini"]:
            self.assertIsNotNone(item["body"], f'{item["phase"]}: {item["error"]}')
            self.assertTrue(validate(item["body"]), item["phase"])
            sent |= {d["name"] for d in item["body"]["tools"][0]["functionDeclarations"]}
        self.assertIn("write_controller", sent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
