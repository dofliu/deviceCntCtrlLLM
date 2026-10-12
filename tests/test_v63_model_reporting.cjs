'use strict';
// Reporting only: production recovery/report paths, synthetic metadata, no API.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),box={};vm.createContext(box);
for(const file of ['engine.js','onboarding.js'])vm.runInContext(fs.readFileSync(path.join(root,'src',file),'utf8'),box);
const plain=x=>JSON.parse(JSON.stringify(x)),checks=[];
for(const code of ['RATE_LIMITED','RATE_LIMIT_WAIT_TOO_LONG','BRIDGE_CALL_BUDGET','QUOTA_EXCEEDED']){
 const recovery=new box.VlabDecisionRecovery(),error={code,message:'RAW_PRIVATE_CANARY',requestDiagnostic:{status:429,quotaKind:code==='QUOTA_EXCEEDED'?'daily':'rate',retryAfterMs:241000,retryable:false,retryAttempt:2,maxRetries:2,requestNumber:3,raw:'PRIVATE_RESPONSE_CANARY'}};
 const result=recovery.reject(error,['observe'],'Claude');
 assert.equal(result.willRetry,false);assert.equal(result.fields.decisionRecovery.attempt,0);
 assert.equal(result.fields.modelDiagnostic.code,code);assert.equal(result.fields.modelDiagnostic.retryAfterMs,241000);
 assert(!JSON.stringify(result).includes('CANARY'));assert.equal(result.fields.toolResult.modelDiagnostic.status,429);
}
checks.push('Rate, long-wait, bridge budget and hard-quota failures remain terminal with sanitized transport diagnostics; never consume format-correction retries');
const runtime={minIntervalMs:6000,requests:3,rateLimitRetries:1,waitMs:30000,recent:[{phase:'cooldown',retryAttempt:1,waitMs:30000},{phase:'requesting',requestNumber:3}],lastError:null};
const engine=Object.create(box.FullExperimentEngine.prototype);
Object.assign(engine,{seed:42,strategy:'claude',provider:{model:'mock',requestDiagnostics:runtime},_frontCalls:1,_controlCalls:2,_frontDecisions:1,_events:[],_history:[],_truth:[],_onboarding:{ready:true},_runtime:null,_state:null,_plant:{diagnostics:()=>({})},_link:{frame:()=>({width:1,height:1})},_frontState:()=>({ready:true,traffic:[]}),_context:()=>({}),_png:()=>null});
const state=engine._emit({kind:'decision',decisionCount:1});
assert.equal(state.modelRuntime.requests,3);assert.equal(state.modelRuntime.rateLimitRetries,1);
assert.equal(state.modelRuntime.recent,undefined);assert.equal(state.modelRuntime.last.requestNumber,3);
const report=engine.report();assert.equal(report.version,'0.7.0');assert.deepEqual(plain(report.modelRuntime),runtime);
assert.equal(report.modelCalls,3);assert.equal(report.actionCount,0);
report.modelRuntime.recent[0].waitMs=0;assert.equal(runtime.recent[0].waitMs,30000);
assert.equal(engine._events[0].modelRuntime.waitMs,30000);
checks.push('Full report retains request timing/retry metadata; each event uses a compact independent snapshot and waiting never increments device actions');
const result={passed:true,version:'0.6.3',pureNode:true,browserUsed:false,networkCalls:0,checks};
fs.writeFileSync(path.join(root,'validation','v63-model-reporting.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
