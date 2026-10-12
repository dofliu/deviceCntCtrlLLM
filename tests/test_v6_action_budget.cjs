'use strict';
// Targeted no-network fixture: action limits must not suppress visual checks.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),s=vm.createContext({});
for(const file of ['claude-provider.js','engine.js','onboarding.js','pick-place.js'])vm.runInContext(fs.readFileSync(path.join(root,'src',file),'utf8'),s);
let boundary,actualCommands=0;
s.AutonomousEngine=class {
  constructor(options){boundary=options.actuator;}
  async initialize(){} async setTargetPixel(){}
  snapshot(){return {actionCount:0,decisionCount:0};}
  async next(){return {done:true,failure:null,decisionCount:0};}
};
const pixels=new Uint8ClampedArray(64*64*4);
for(let y=10;y<14;y++)for(let x=10;x<14;x++)pixels.set([255,173,53,255],(y*64+x)*4);
(async()=>{
  const c=new s.PickPlaceController({seed:42,strategy:'adaptive',maxActions:2,maxDecisions:300,plant:{diagnostics:()=>({})},frameGetter:()=>({width:64,height:64,pixels}),actuator:async command=>{actualCommands++;return {applied:command,limited:false};}});
  await c.initialize();c._task.phase='approach';c._actuatorState={lift:'up',gripper:'open'};
  c._proposal={tool:'select_goal',args:{target:'object'},source:'adaptive'};
  await c._execute(c._epoch);assert.equal(typeof boundary,'function');
  c._auxiliaryCount=2;await assert.rejects(()=>boundary([.01,0]),/動作上限/);assert.equal(actualCommands,0);
  c._auxiliaryCount=1;await boundary([.01,0]);assert.equal(actualCommands,1);
  c._auxiliaryCount=2;c._navGoal='clearance';c._navActive=true;
  const result=await c._navigateNext(c._epoch);
  assert.equal(result.failure,null);assert.equal(result.done,false);assert.equal(result.taskProgress.phase,'verify_place');
  assert.equal(actualCommands,1);
  console.log(JSON.stringify({passed:true,scope:'Bounded actuator and non-actuating verification fixture; no browser, API or full suite',checks:['No command beyond per-trial limit','Commands below limit remain possible','Final visual verification remains reachable at the action limit']}));
})().catch(e=>{console.error(e);process.exitCode=1;});
