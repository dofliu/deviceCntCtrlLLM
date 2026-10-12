'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, SoftwareCanvas, plain, root } = require('./headless-runtime.cjs');
const { driveTo, cameraRejectsWrongHeight } = require('./test_v6_mechanics.cjs');
const USER_FIXTURE = require('./fixtures/v6-user-platform-failure.json');

const distance = (a,b) => a && b ? Math.hypot(a[0]-b[0],a[1]-b[1]) : Infinity;
const RECORDED = {
  finalJointAngles: USER_FIXTURE.evaluatorDiagnostics.geometry.jointAngles,
  objectWorld: USER_FIXTURE.evaluatorDiagnostics.pickPlace.object,
  targetPixel: USER_FIXTURE.evaluatorDiagnostics.target,
  retreat: [[.0790187378743566,.09],[.053028003386861526,.09],[.0644000685553143,.09]],
  observedOldRelease: USER_FIXTURE.toolResult.data.surfaceEvidence.surface,
  observedOldFinal: USER_FIXTURE.agentContext.observed.destinationSurface
};

// Frozen V6 bounding-box measurement, retained only as a regression comparator.
function oldSurfaceBox({ width, height, pixels }) {
  const box = [Infinity,Infinity,-Infinity,-Infinity]; let n = 0;
  for(let y=0,i=0;y<height;y++)for(let x=0;x<width;x++,i+=4){
    if(pixels[i+3]<128)continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(r>130&&r<180&&g>100&&g<155&&b>210){
      n++;box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
    }
  }
  return n>=8?[(box[0]+box[2])/2,(box[1]+box[3])/2]:null;
}

function downsample(frame, scale) {
  if(scale===1)return frame;
  const width=frame.width/scale,height=frame.height/scale,pixels=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let channel=0;channel<4;channel++){
    let sum=0;
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)sum+=frame.pixels[((y*scale+dy)*frame.width+x*scale+dx)*4+channel];
    pixels[(y*width+x)*4+channel]=Math.round(sum/(scale*scale));
  }
  return {width,height,pixels};
}

async function recordedFrames(global, scale=1) {
  const plant=new global.VirtualPlant({seed:42,width:640*scale,height:480*scale});
  plant.configureTrial(2,{initialPose:true});
  // Evaluator setup uses the recorded true position solely to reconstruct the
  // scene. No geometry, hidden attachment flag or camera truth reaches inspect.
  await driveTo(plant,plant.diagnostics().pickPlace.object,command=>plant.act(command));
  plant.operate({op:'lift',position:'down'});plant.operate({op:'grip',state:'closed'});
  assert.equal(plant.diagnostics().pickPlace.held,true);
  plant.operate({op:'lift',position:'up'});
  await driveTo(plant,RECORDED.objectWorld,command=>plant.act(command));
  plant.setTargetPixel(...plant.diagnostics().manipulation.destination);
  plant.operate({op:'lift',position:'down'});plant.operate({op:'grip',state:'open'});
  const release=downsample(plant.frame(),scale);
  plant.operate({op:'lift',position:'up'});
  plant.setTargetPixel(...RECORDED.targetPixel.map(v=>v*scale));
  for(const command of RECORDED.retreat)plant.act(command);
  const final=downsample(plant.frame(),scale),truth=plain(plant.diagnostics());
  assert.equal(truth.pickPlace.placed,true);
  assert.ok(distance(truth.geometry.jointAngles,RECORDED.finalJointAngles)<1e-8,'Recorded three-command retreat must reconstruct the reported final pose.');
  return {release,final,surfaceTruth:truth.manipulation.destinationSurface.map(v=>v/scale)};
}

function syntheticFrame({ surfaceX=300,surfaceY=190,partial=false,outliers=false,shortArc=false,missing=false,tipX=350,wrongObjectHeight=false }={}) {
  const canvas=new SoftwareCanvas();canvas.width=640;canvas.height=480;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#08131c';ctx.fillRect(0,0,640,480);
  ctx.beginPath();ctx.arc(300,201.7,34,0,2*Math.PI);ctx.strokeStyle='#4977ef';ctx.lineWidth=4;ctx.stroke();
  if(!missing){
    ctx.beginPath();ctx.arc(surfaceX,surfaceY,18,0,2*Math.PI);ctx.strokeStyle='#9b7df4';ctx.lineWidth=3;ctx.stroke();
    if(partial){ctx.fillStyle='#08131c';ctx.fillRect(surfaceX-24,surfaceY-9,12,18);}
    if(shortArc){ctx.fillStyle='#08131c';ctx.fillRect(surfaceX-22,surfaceY-22,44,32);}
  }
  if(outliers){
    // The old detector accepts this blended edge color. A few off-circle
    // pixels must not move a stationary marker's measured center.
    ctx.fillStyle='#9879e4';ctx.fillRect(surfaceX-32,surfaceY+19,2,3);
  }
  ctx.fillStyle='#ffad35';ctx.fillRect(292,(wrongObjectHeight?201.7:190)-8,16,16);
  ctx.beginPath();ctx.arc(tipX,201.7,6,0,2*Math.PI);ctx.fillStyle='#2de2df';ctx.fill();
  return {width:640,height:480,pixels:ctx.getImageData(0,0,640,480).data};
}

async function runPlacementCheck(global, release, final, { surfaceRequired=true }={}) {
  let frame=release;
  const controller=new global.PickPlaceController({seed:42,strategy:'adaptive',recordFrames:false,maxActions:180,maxDecisions:300,
    plant:{diagnostics:()=>({})},frameGetter:()=>frame,mechanicalActuator:async command=>({applied:command,limited:false})});
  try{
    await controller.initialize();await controller.next();await controller.next();
    assert.equal(controller._surfaceRequired,surfaceRequired);
    // Previous grasp and transport prerequisites are explicit fixture inputs.
    // Release and final placement evidence are measured by production code.
    Object.assign(controller._task,{phase:'release',graspVerified:true,coMotionVerified:true,atDestination:true});
    controller._actuatorState={lift:'down',gripper:'closed'};
    await controller.next();await controller.next();
    frame=final;Object.assign(controller._task,{phase:'verify_place',cleared:true});controller._actuatorState.lift='up';
    await controller.next();const state=await controller.next();
    return {done:state.done,failure:state.failure,completed:state.taskProgress.completed,checks:plain(state.toolResult.data.checks),placementError:state.toolResult.data.placementError};
  }finally{controller.dispose();}
}

async function requiredMarkerCannotDisappear(global) {
  const frame=syntheticFrame({missing:true});let actions=0;
  const controller=new global.PickPlaceController({seed:42,strategy:'adaptive',requireSurfaceEvidence:true,recordFrames:false,maxActions:180,maxDecisions:300,
    plant:{diagnostics:()=>({})},frameGetter:()=>frame,mechanicalActuator:async command=>{actions++;return {applied:command,limited:false};}});
  try{
    await controller.initialize();await controller.next();const state=await controller.next();
    assert.equal(controller._surfaceRequired,true);
    assert.equal(state.taskProgress.phase,'inspect_scene');
    assert.equal(state.taskProgress.objectDetected,false);
    assert.equal(state.toolResult.ok,false);
    assert.equal(actions,0);
    return {surfaceRequired:true,phase:state.taskProgress.phase,inspectionAccepted:state.toolResult.ok,actions};
  }finally{controller.dispose();}
}

async function run(){
  const rt=createRuntime(),g=rt.global;
  try{
    const raster=[],checks=[];let strongestFrames;
    for(const scale of [1,2,3]){
      const frames=await recordedFrames(g,scale);
      const before=plain(g.inspectTaskFrame(frames.release)),after=plain(g.inspectTaskFrame(frames.final));
      assert.equal(before.markerQuality?.destinationSurface.accepted,true);
      assert.equal(after.markerQuality?.destinationSurface.accepted,true);
      assert.ok(distance(before.destinationSurface,after.destinationSurface)<=2,'Stationary platform must satisfy the unchanged 2 px drift gate.');
      // Pixel indices describe their centers at x+0.5,y+0.5; allow one pixel
      // raster error, without feeding truth into the actual image detector.
      const center=frames.surfaceTruth.map(v=>v-.5);
      assert.ok(distance(before.destinationSurface,center)<1);
      assert.ok(distance(after.destinationSurface,center)<1);
      raster.push({scale,oldRelease:oldSurfaceBox(frames.release),oldFinal:oldSurfaceBox(frames.final),oldDrift:distance(oldSurfaceBox(frames.release),oldSurfaceBox(frames.final)),newRelease:before.destinationSurface,newFinal:after.destinationSurface,newDrift:distance(before.destinationSurface,after.destinationSurface),releaseQuality:before.markerQuality?.destinationSurface,finalQuality:after.markerQuality?.destinationSurface,surfaceTruth:frames.surfaceTruth});
      if(scale===3)strongestFrames=frames;
    }
    assert.ok(raster[2].oldDrift>2,'The AA fixture must first demonstrate the old bounding-box false failure.');
    checks.push('recorded third-trial pose reconstructed by real mechanics and the three recorded retreat commands');
    checks.push('stationary platform: old bounding box fails under AA approximation while circle fit remains within unchanged 2 px gate');
    const placement=await runPlacementCheck(g,strongestFrames.release,strongestFrames.final);
    assert.equal(placement.completed,true);assert.equal(placement.failure,null);
    assert.ok(Object.values(placement.checks).every(Boolean));
    checks.push('production release and final placement validator accepts corrected camera evidence; all 13 checks true');

    const release=syntheticFrame({tipX:300}),occluded=syntheticFrame({partial:true,outliers:true});
    const observedBefore=plain(g.inspectTaskFrame(release)),observedAfter=plain(g.inspectTaskFrame(occluded));
    const synthetic={oldDrift:distance(oldSurfaceBox(release),oldSurfaceBox(occluded)),newDrift:distance(observedBefore.destinationSurface,observedAfter.destinationSurface),quality:observedAfter.markerQuality.destinationSurface};
    assert.ok(synthetic.oldDrift>2);assert.ok(synthetic.newDrift<1);
    assert.equal((await runPlacementCheck(g,release,occluded)).completed,true);
    checks.push('partial occlusion plus blended off-circle purple pixels cannot shift the accepted center');

    const moved=await runPlacementCheck(g,release,syntheticFrame({surfaceX:304}));
    assert.equal(moved.completed,false);assert.ok(moved.failure);
    assert.equal(moved.checks.platformStayedAfterRelease,false);
    checks.push('actual 4 px platform motion still fails the original 2 px drift gate');
    const rejected=[];
    for(const mode of ['shortArc','missing']){
      const frame=syntheticFrame({[mode]:true});
      const observation=plain(g.inspectTaskFrame(frame));
      assert.equal(observation.destinationSurface,null,mode+' must not fabricate a usable center');
      assert.equal(observation.markerQuality.destinationSurface.accepted,false);
      const placement=await runPlacementCheck(g,release,frame);
      assert.equal(placement.completed,false);assert.ok(placement.failure);
      assert.equal(placement.checks.surfaceMarkerVisible,false);
      assert.equal(placement.checks.platformStayedAfterRelease,false);
      rejected.push({mode,quality:observation.markerQuality.destinationSurface,checks:placement.checks});
    }
    checks.push('short arc and missing surface evidence return null and fail production placement verification');

    const requiredMissingMarker=await requiredMarkerCannotDisappear(g);
    checks.push('required but absent platform marker cannot silently downgrade inspection to a tabletop task or trigger motion');

    const wrongHeight=[];
    for(const height of [.35,.65])wrongHeight.push(await cameraRejectsWrongHeight(g,height));
    checks.push('both existing low/high-platform wrong-height negatives still fail release-height verification');

    return {passed:true,checks,scope:'Pure Node focused pixel detector and placement-validator regression. Real plant release/final frames plus software AA approximation; explicit synthetic evidence negatives. No browser, real API, network, or full multi-trial suite.',
      limitation:'Software supersampling reproduces the bounding-box failure mechanism, not the exact browser raster. Previous grasp, co-motion, and clearance prerequisites are fixtures in isolated placement checks, not fresh end-to-end certifications.',
      recordedUserEvidence:{source:USER_FIXTURE.source,oldRelease:RECORDED.observedOldRelease,oldFinal:RECORDED.observedOldFinal,oldDrift:distance(RECORDED.observedOldRelease,RECORDED.observedOldFinal)},raster,placement,synthetic,movedPlatform:moved,rejected,requiredMissingMarker,wrongHeight};
  }finally{rt.close();}
}
module.exports={run,recordedFrames,oldSurfaceBox,syntheticFrame,runPlacementCheck,requiredMarkerCannotDisappear};
if(require.main===module)run().then(result=>{
  const destination=path.join(root,'validation','v61-marker-regression.json');
  fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,checks:result.checks,raster:result.raster.map(({scale,oldDrift,newDrift})=>({scale,oldDrift,newDrift})),report:destination},null,2));
}).catch(error=>{console.error(error);process.exitCode=1;});
