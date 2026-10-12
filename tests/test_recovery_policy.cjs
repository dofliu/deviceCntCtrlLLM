'use strict';
// Pure local policy test. No browser, network, credentials or provider request.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const sandbox=vm.createContext({});
for(const name of ['claude-provider.js','engine.js']){
  vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),sandbox,{filename:name});
}
const Recovery=sandbox.VlabDecisionRecovery;
const plain=v=>JSON.parse(JSON.stringify(v));
const failure=(code,issue)=>({code,diagnostic:{code,issue}});
const allowed=['observe','probe','fit_model','move','verify','stop'];
const policy=new Recovery();
const rejectionSequence=[
  failure('INVALID_DECISION','invalid-envelope'),
  failure('INVALID_ARGUMENTS','invalid-arguments'),
  failure('INVALID_TOOL_RESPONSE','tool-count')
].map(error=>policy.reject(error,allowed,'Claude'));
assert.deepEqual(rejectionSequence.map(x=>x.willRetry),[true,true,false]);
assert.deepEqual(rejectionSequence.map(x=>x.fields.decisionRecovery.attempt),[1,2,3]);
assert(rejectionSequence.every(x=>x.fields.decision===null));
assert(rejectionSequence[2].summary.includes('2'));
assert.equal(policy.context({}).decisionFeedback,undefined);

policy.accept();
assert.equal(policy.context({}).decisionFeedback,undefined);
const afterAccepted=policy.reject(failure('INVALID_DECISION','invalid-reason'),allowed,'Claude');
assert(afterAccepted.willRetry);
assert.equal(afterAccepted.fields.decisionRecovery.attempt,1);
const existing={phase:'control',observation:{tip:[120,140],target:[250,160]},model:{jacobian:[[12,3],[4,17]]},samples:{count:7}};
const baseline=JSON.stringify(existing),context=policy.context(existing);
assert.equal(JSON.stringify(existing),baseline);
assert.deepEqual(plain(context.model),existing.model);
assert.deepEqual(plain(context.observation),existing.observation);
assert.equal(context.decisionFeedback.issue,'invalid-reason');
assert.deepEqual(plain(context.decisionFeedback.allowedTools),allowed);

const stoppedCodes=['HTTP_503','TIMEOUT','CALL_BUDGET','CREDENTIAL_ECHO'];
for(const code of stoppedCodes){
  const p=new Recovery();
  const result=p.reject({code,message:'untrusted provider text'},allowed,'Gemini');
  assert.equal(result.willRetry,false,code);
  assert.equal(result.fields.decisionRecovery.attempt,0,code);
  assert.equal(p.context({}).decisionFeedback,undefined,code);
  assert(result.summary.includes(code));
  assert(!result.summary.includes('untrusted provider text'));
}

const secret='UNTRUSTED_PRIVATE_VALUE_123456789';
const hostile={code:'INVALID_DECISION',message:secret,usage:{input_tokens:9,output_tokens:2,raw:secret,cache_read_input_tokens:-1},diagnostic:{
  code:'INVALID_DECISION',issue:'invalid-envelope',message:secret,receivedTool:secret,
  missingFields:['args',secret],extraFieldCount:2,arbitrary:{key:secret}
}};
const sanitized=new Recovery().reject(hostile,allowed,'Claude');
assert(!JSON.stringify(sanitized).includes(secret));
assert.equal(sanitized.fields.decisionDiagnostic.receivedTool,'[unknown]');
assert.deepEqual(plain(sanitized.fields.decisionDiagnostic.missingFields),['args']);
assert.deepEqual(plain(sanitized.fields.decisionUsage),{input_tokens:9,output_tokens:2});
const summary={passed:true,pureNode:true,browserUsed:false,networkCalls:0,credentialRead:false,
  checks:['Two corrections then terminal rejection','All validation codes share one limit',
    'Accepted decision resets consecutive limit','Feedback preserves observation and Jacobian',
    'HTTP, timeout, budget and credential errors stop immediately','Diagnostic and usage allowlists discard private data']};
fs.mkdirSync(path.join(root,'validation'),{recursive:true});
fs.writeFileSync(path.join(root,'validation','recovery-policy-node.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
