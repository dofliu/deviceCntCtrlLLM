/* Constructor and one mocked decision only: no real network or credentials. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const frame={dataURL:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEcAAAAASUVORK5CYII='};
const context={phase:'control',allowedTools:['observe'],observation:{tip:[10,10],target:[20,20],error:14.14}};
async function check(name){
 let wire=null;
 const box={URL,URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{wire=JSON.parse(options.body);return {ok:true,status:200,json:async()=>name==='Claude'?{stop_reason:'tool_use',content:[{type:'tool_use',name:'observe',input:{args:{},reason:'Read the current frame.'}}]}:{candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:'observe',args:{args:{},reason:'Read the current frame.'}}}]}}]}};}};
 vm.createContext(box);for(const filename of ['claude-provider.js','gemini-provider.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',filename),'utf8'),box);
 const Provider=box[name+'AgentProvider'],options={apiKey:'FAKE_TEST_KEY_NO_CREDENTIAL',model:name.toLowerCase()+'-mock'};
 const provider=new Provider({...options,maxCalls:500});assert.equal(provider.calls,0);
 for(const maxCalls of [0,501,1.5])assert.throws(()=>new Provider({...options,maxCalls}),error=>error.code==='INVALID_BUDGET');
 await provider.decide(context,frame);const content=name==='Claude'?wire.messages[0].content:wire.contents[0].parts;
 assert(content.some(part=>part.text?.includes('"modelRequests":{"used":0,"limit":500}')));assert.equal(provider.calls,1);provider.dispose();
 wire=null;const single=new Provider(options);await single.decide(context,frame);const defaultContent=name==='Claude'?wire.messages[0].content:wire.contents[0].parts;
 assert(defaultContent.some(part=>part.text?.includes('"modelRequests":{"used":0,"limit":80}')));single.dispose();
 return name+': 500 accepted, 501 rejected, request budget retained, constructor default 80';
}
(async()=>{console.log(JSON.stringify({passed:true,checks:[await check('Claude'),await check('Gemini')],network:'mock only'}));})().catch(error=>{console.error(error);process.exitCode=1;});
