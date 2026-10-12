'use strict';
// Evaluator-only physics checks use hidden geometry to position the fixture.
// The production agent still receives pixels/ACK only; this is not an agent run.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRuntime,plain,root}=require('./headless-runtime.cjs');
const runtime=createRuntime();
const {VirtualPlant,SimulatedDeviceLink}=runtime.global;
const wrap=v=>((v+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
function moveTo(plant,point){
  const g=plant.diagnostics().geometry,[l1,l2]=g.lengths;
  const q2=Math.acos((point[0]**2+point[1]**2-l1*l1-l2*l2)/(2*l1*l2));
  const target=[Math.atan2(point[1],point[0])-Math.atan2(l2*Math.sin(q2),l1+l2*Math.cos(q2)),q2];
  assert.ok(Number.isFinite(q2)&&q2>=.25&&q2<=2.85,'fixture pose must be reachable');
  for(let i=0;i<150;i++){
    const actual=plant.diagnostics().geometry.jointAngles;
    const error=[wrap(target[0]-actual[0]),target[1]-actual[1]];
    if(Math.hypot(...error)<1e-10)return;
    const command=g.channelToJoint.map((joint,ch)=>Math.max(-.1,Math.min(.1,error[joint]/g.channelGains[ch])));
    plant.act(command);
  }
  throw new Error('Fixture positioning did not converge.');
}
const command=(plant,op,value)=>plant.act(op==='lift'?{op,position:value}:{op,state:value});
try{
  const checks=[];
  const plant=new VirtualPlant({seed:42});
  assert.equal(plant.diagnostics().scenario,null);
  const geometry=plain(plant.diagnostics().geometry);
  const first=plant.configureTrial(0,{initialPose:true}),d0=plain(plant.diagnostics());
  assert.ok(d0.tip[0]<d0.geometry.camera.x&&d0.tip[1]>d0.geometry.camera.y,'first pose is lower-left in camera');
  assert.ok(first.initialDistancePx>150&&first.transferDistancePx>180,'seed42 starts and transfers far apart');
  for(const key of ['lengths','channelToJoint','channelGains','camera'])assert.deepEqual(d0.geometry[key],geometry[key]);
  for(let i=1;i<5;i++){
    const before=plain(plant.diagnostics().geometry);
    const scenario=plant.configureTrial(i);
    const after=plain(plant.diagnostics().geometry);
    for(const key of ['lengths','jointAngles','channelToJoint','channelGains','camera'])assert.deepEqual(after[key],before[key]);
    assert.equal(scenario.destinationHeight,[0,.35,.65,.35,0][i]);
    assert.ok(scenario.transferDistancePx>180);
  }
  checks.push('Five reachable, separated scenes preserve equipment, camera, and current joints between trials; first pose is lower-left');

  for(const trial of [0,1,2,3,4]){
    const p=new VirtualPlant({seed:42});p.configureTrial(trial,{initialPose:true});
    let d=p.diagnostics();moveTo(p,d.pickPlace.object);
    command(p,'lift','down');command(p,'grip','closed');
    assert.equal(p.diagnostics().pickPlace.held,true);
    assert.throws(()=>p.configureTrial(0),/release the held object/);
    command(p,'lift','up');assert.equal(p.diagnostics().pickPlace.objectHeight,1);
    moveTo(p,d.pickPlace.destination);command(p,'lift','down');
    d=p.diagnostics();assert.equal(d.pickPlace.liftHeight,d.pickPlace.destinationHeight);
    assert.equal(d.pickPlace.objectHeight,d.pickPlace.destinationHeight);
    const xy=plain(d.pickPlace.object);command(p,'grip','open');
    d=p.diagnostics();assert.deepEqual(plain(d.pickPlace.object),xy,'release never snaps XY');
    assert.equal(d.pickPlace.objectHeight,[0,.35,.65,.35,0][trial]);
    assert.equal(d.pickPlace.held,false);assert.equal(d.pickPlace.placed,true);
    command(p,'lift','up');assert.equal(p.diagnostics().pickPlace.objectHeight,d.pickPlace.destinationHeight);
  }
  checks.push('All five trials genuinely grasp, lift, contact the supporting surface, and leave the object at its platform height after release');

  const miss=new VirtualPlant({seed:42});miss.configureTrial(2,{initialPose:true});
  const md=plain(miss.diagnostics());moveTo(miss,md.pickPlace.object);
  command(miss,'lift','down');command(miss,'grip','closed');command(miss,'lift','up');
  const outside=md.pickPlace.destination.map(v=>v*.70);moveTo(miss,outside);command(miss,'grip','open');
  assert.equal(miss.diagnostics().pickPlace.objectHeight,0);assert.equal(miss.diagnostics().pickPlace.placed,false);
  assert.ok(Math.hypot(...miss.diagnostics().pickPlace.object.map((v,i)=>v-outside[i]))<1e-8);
  checks.push('Release outside the elevated platform falls onto the table and cannot count as placed');

  const wrongHeight=new VirtualPlant({seed:42});wrongHeight.configureTrial(2,{initialPose:true});
  const wd=plain(wrongHeight.diagnostics());moveTo(wrongHeight,wd.pickPlace.destination);command(wrongHeight,'lift','down');
  assert.equal(wrongHeight.diagnostics().pickPlace.liftHeight,.65);
  moveTo(wrongHeight,wd.pickPlace.object);command(wrongHeight,'grip','closed');
  assert.equal(wrongHeight.diagnostics().pickPlace.held,false,'XY alignment with the wrong height cannot attach');
  checks.push('An XY-aligned closed gripper at a mismatched height cannot grasp a table object');

  const collision=new VirtualPlant({seed:42});collision.configureTrial(2,{initialPose:true});
  const cd=plain(collision.diagnostics()),outsidePlatform=cd.pickPlace.destination.map(v=>v*.70);
  moveTo(collision,outsidePlatform);command(collision,'lift','down');
  assert.equal(collision.diagnostics().pickPlace.liftHeight,0);
  let rejected=false;
  const link=new SimulatedDeviceLink({plant:collision,seed:42});
  link.connect({endpointId:'sim-serial-arm',transport:'serial',protocol:'vlab-p2-json/1',baudRate:115200});link.handshake();
  for(let i=0;i<40;i++){
    const current=plain(collision.diagnostics().geometry),[l1,l2]=current.lengths,p=cd.pickPlace.destination;
    const q2=Math.acos((p[0]**2+p[1]**2-l1*l1-l2*l2)/(2*l1*l2));
    const target=[Math.atan2(p[1],p[0])-Math.atan2(l2*Math.sin(q2),l1+l2*Math.cos(q2)),q2];
    const error=[wrap(target[0]-current.jointAngles[0]),target[1]-current.jointAngles[1]];
    const channels=current.channelToJoint.map((joint,ch)=>Math.max(-.04,Math.min(.04,error[joint]/current.channelGains[ch])));
    const reply=JSON.parse(link.exchange(JSON.stringify({op:'step',channels})+'\n'));
    if(!reply.ok){
      assert.match(reply.error,/COLLISION/);assert.deepEqual(plain(collision.diagnostics().geometry.jointAngles),current.jointAngles);
      rejected=true;break;
    }
  }
  assert.equal(rejected,true);command(collision,'lift','up');moveTo(collision,cd.pickPlace.destination);
  checks.push('The link rejects a low-height platform collision atomically with unchanged joints; raising permits the move');

  const summary={passed:true,browserUsed:false,networkCalls:0,scope:'Production plant and device-link physics with evaluator-driven positioning; not AI planning or browser rendering validation.',firstTrial:plain(first),checks};
  fs.mkdirSync(path.join(root,'validation'),{recursive:true});fs.writeFileSync(path.join(root,'validation','platform-physics-node.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
}finally{runtime.close();}
