(function(global){
  'use strict';
  const copy=x=>x==null?x:JSON.parse(JSON.stringify(x));
  const distance=(a,b)=>a&&b?Math.hypot(a[0]-b[0],a[1]-b[1]):null;
  const TOOLS=['inspect_scene','select_goal','lift','grip','verify_grasp','verify_place','stop'];
  const LABELS={inspect_scene:'辨識物件與放置區',select_goal:'指定影像目標',lift:'控制升降',grip:'控制夾爪',verify_grasp:'驗證物件已抬起',verify_place:'驗證放置與退出',stop:'停止任務'};
  const PHASE_LABELS={inspect_scene:'辨識 A 點物件與 B 區',prepare_lift:'確認夾具升起',prepare_grip:'確認夾爪張開',approach:'自我校正並靠近物件',lower_pick:'下降至取物高度',close:'合攏夾爪',raise_pick:'抬起物件',verify_grasp:'用影像驗證取物',transport:'搬運至 B 區',lower_place:'下降至放置高度',release:'張開夾爪放下物件',raise_clearance:'升起空夾具',clearance:'退出放置區',verify_place:'驗證物件留在 B 區',recover_open:'重新張開夾爪',complete:'取放任務完成'};
  function initialProgress(){return {phase:'inspect_scene',label:PHASE_LABELS.inspect_scene,objectDetected:false,atObject:false,graspVerified:false,coMotionVerified:false,atDestination:false,released:false,cleared:false,completed:false,attempts:0,placementError:null};}

  // Fit the visible annulus instead of its bounding box: another marker or a
  // gripper can cover an extremity without moving the actual placement zone.
  // Radius/stroke are visual marker specifications, not device geometry. Every
  // estimate below is made from the current image; no previous centre is used.
  function inspectCircularMarker(points,radii,strokeWidth,fit){
    const totalBins=16,minPixels=24;
    const empty={accepted:false,reason:points.length?'insufficient-pixels':'not-visible',pixelCount:points.length,inlierCount:0,inlierFraction:0,coverageBins:0,totalBins,largestGapDeg:360,radiusPx:null,residualRmsPx:null};
    if(points.length<minPixels)return {center:null,quality:empty};
    const band=Math.max(1.15,strokeWidth/2+.6*fit);
    const samples=points.length<=600?points:points.filter((_,i)=>i%Math.ceil(points.length/600)===0);
    function leastSquares(selected){
      if(selected.length<3)return null;
      let mx=0,my=0;for(const p of selected){mx+=p[0];my+=p[1];}mx/=selected.length;my/=selected.length;
      let xx=0,xy=0,yy=0,xz=0,yz=0,zmean=0;
      for(const p of selected){const x=p[0]-mx,y=p[1]-my,z=x*x+y*y;xx+=x*x;xy+=x*y;yy+=y*y;xz+=x*z;yz+=y*z;zmean+=z;}
      const det=xx*yy-xy*xy;
      if(det<=1e-9||(det/((xx+yy)*(xx+yy)))<.015)return null;
      const dx=(xz*yy-yz*xy)/(2*det),dy=(yz*xx-xz*xy)/(2*det);
      return [mx+dx,my+dy,Math.sqrt(zmean/selected.length+dx*dx+dy*dy)];
    }
    function throughThree(a,b,c){
      const bx=b[0]-a[0],by=b[1]-a[1],cx=c[0]-a[0],cy=c[1]-a[1],det=2*(bx*cy-by*cx);
      if(Math.abs(det)<1e-6)return null;
      const bz=bx*bx+by*by,cz=cx*cx+cy*cy,dx=(bz*cy-cz*by)/det,dy=(bx*cz-cx*bz)/det;
      return [a[0]+dx,a[1]+dy,Math.hypot(dx,dy)];
    }
    function metrics(circle,source){
      const inliers=[],bins=new Set();let squared=0;
      for(const p of source){const dx=p[0]-circle[0],dy=p[1]-circle[1],residual=Math.hypot(dx,dy)-circle[2];
        if(Math.abs(residual)<=band){inliers.push(p);squared+=residual*residual;bins.add(Math.floor((Math.atan2(dy,dx)+Math.PI)/(2*Math.PI)*totalBins)%totalBins);}}
      let gap=0,longest=0;for(let i=0;i<totalBins*2;i++){gap=bins.has(i%totalBins)?0:gap+1;longest=Math.max(longest,gap);}
      return {inliers,coverage:bins.size,gap:Math.min(totalBins,longest),rms:inliers.length?Math.sqrt(squared/inliers.length):Infinity};
    }
    let chosen=null;
    for(const expectedRadius of radii){
      const radiusTolerance=Math.max(1.25*fit,.075*expectedRadius);
      let best=null,bestScore=-Infinity;
      function consider(circle){
        if(!circle||!circle.every(Number.isFinite)||Math.abs(circle[2]-expectedRadius)>radiusTolerance)return;
        const m=metrics(circle,samples),score=m.inliers.length+3*m.coverage-m.rms;
        if(score>bestScore){best=circle;bestScore=score;}
      }
      consider(leastSquares(samples));
      // Deterministic RANSAC resists false purple anti-alias pixels produced
      // where the magenta target overlaps the blue ground reference.
      let sequence=(points.length*2654435761+Math.round(expectedRadius*101))>>>0;
      const pick=()=>{sequence=(Math.imul(sequence,1664525)+1013904223)>>>0;return samples[sequence%samples.length];};
      for(let i=0;i<96;i++)consider(throughThree(pick(),pick(),pick()));
      // Fixed-radius pair candidates remain useful when noisy triples are
      // nearly collinear. The fit is subsequently refined from image inliers.
      for(let i=0;i<48;i++){
        const a=pick(),b=pick(),dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy);
        if(d<expectedRadius*.65||d>expectedRadius*1.95)continue;
        const half=Math.sqrt(expectedRadius*expectedRadius-d*d/4),mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;
        consider([mx-dy/d*half,my+dx/d*half,expectedRadius]);consider([mx+dy/d*half,my-dx/d*half,expectedRadius]);
      }
      if(!best)continue;
      for(let iteration=0;iteration<3;iteration++){
        const current=metrics(best,points),refined=leastSquares(current.inliers);
        if(!refined||Math.abs(refined[2]-expectedRadius)>radiusTolerance)break;
        best=refined;
      }
      const m=metrics(best,points),fraction=m.inliers.length/points.length;
      const reason=m.inliers.length<minPixels?'insufficient-inliers':fraction<.55?'ambiguous-colour':m.coverage<9||m.gap>7?'insufficient-arc':m.rms>Math.max(1.05,strokeWidth*.55)?'excessive-residual':null;
      const quality={accepted:reason===null,reason:reason||'circle-fit',pixelCount:points.length,inlierCount:m.inliers.length,inlierFraction:fraction,coverageBins:m.coverage,totalBins,largestGapDeg:m.gap*360/totalBins,radiusPx:best[2],residualRmsPx:m.rms};
      const result={center:quality.accepted?best.slice(0,2):null,quality,score:m.inliers.length+3*m.coverage-m.rms};
      if(!chosen||(quality.accepted&&!chosen.quality.accepted)||(quality.accepted===chosen.quality.accepted&&result.score>chosen.score))chosen=result;
    }
    return chosen?{center:chosen.center,quality:chosen.quality}:{center:null,quality:{...empty,reason:'no-supported-circle'}};
  }

  // This detector accepts only an RGBA frame. It has no reference to the plant,
  // kinematics, object attachment state or evaluator diagnostics.
  function inspectTaskFrame(frame){
    const {width,height,pixels}=frame||{};
    const out={tip:null,object:null,destination:null,destinationSurface:null,surfaceOffsetPx:null,objectPixels:0,destinationPixels:0,raisedOffsetError:null,markerQuality:{}};
    if(!Number.isInteger(width)||!Number.isInteger(height)||!pixels||pixels.length<width*height*4)return out;
    const sums={tip:[0,0,0],object:[0,0,0],destination:[0,0,0],destinationSurface:[0,0,0]};
    const ringPixels={destination:[],destinationSurface:[]};
    const bounds=Object.fromEntries(Object.keys(sums).map(k=>[k,[Infinity,Infinity,-Infinity,-Infinity]]));
    for(let y=0,i=0;y<height;y++)for(let x=0;x<width;x++,i+=4){
      if(pixels[i+3]<128)continue;
      const r=pixels[i],g=pixels[i+1],b=pixels[i+2];let key=null;
      if(r<90&&g>175&&b>150)key='tip';
      else if(r>225&&g>125&&g<200&&b<100)key='object';
      else if(r>40&&r<115&&g>75&&g<155&&b>195)key='destination';
      else if(r>130&&r<180&&g>100&&g<155&&b>210)key='destinationSurface';
      if(key){sums[key][0]+=x;sums[key][1]+=y;sums[key][2]++;const box=bounds[key];box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);if(ringPixels[key])ringPixels[key].push([x,y]);}
    }
    for(const key of Object.keys(sums)){const [x,y,n]=sums[key];if(n>=8)out[key]=[x/n,y/n];}
    out.objectPixels=sums.object[2];out.destinationPixels=sums.destination[2];
    const fit=Math.min(width/640,height/480);
    for(const key of ['destination','destinationSurface']){
      const measured=inspectCircularMarker(ringPixels[key],key==='destination'?[34*fit,24*fit]:[18*fit],(key==='destination'?4:3)*fit,fit);
      out[key]=measured.center;out.markerQuality[key]=measured.quality;
    }
    // The object's rectangular silhouette still provides opposite extrema
    // around a central gripper occlusion. Circular references use the separate
    // robust fit above, including an explicit failure when too little is seen.
    // When the endpoint disk hides a whole top or bottom edge (low platform),
    // release-height evidence anchors on the visible edge with the visible width.
    if(ringPixels.destinationSurface.length>=8&&out.object){const b=bounds.object;out.object=[(b[0]+b[2])/2,(b[1]+b[3])/2];
      const w=b[2]-b[0],hgt=b[3]-b[1];out.objectEdgeAnchored=out.object.slice();if(out.tip&&w-hgt>1)out.objectEdgeAnchored[1]=out.tip[1]>out.object[1]?b[1]+w/2:b[3]-w/2;}
    if(out.destinationSurface&&out.destination)out.surfaceOffsetPx=out.destination[1]-out.destinationSurface[1];
    if(out.tip&&out.object)out.raisedOffsetError=distance(out.object,[out.tip[0],out.tip[1]-18*Math.min(width/640,height/480)]);
    return out;
  }
  function validateMissionDecision(value,allowed){
    if(!value||!TOOLS.includes(value.tool)||!allowed.includes(value.tool)||!value.args||typeof value.args!=='object'||Array.isArray(value.args))throw new Error('任務工具或參數格式不正確，或目前尚未允許此工具。');
    const a=value.args,fields={select_goal:['target'],lift:['position'],grip:['state']}[value.tool]||[];
    if(Object.keys(a).length!==fields.length||Object.keys(a).some(k=>!fields.includes(k)))throw new Error('任務工具包含未定義或缺少的參數。');
    if(value.tool==='select_goal'&&!['object','destination','clearance'].includes(a.target))throw new Error('未知的影像目標。');
    if(value.tool==='lift'&&!['up','down'].includes(a.position))throw new Error('升降位置必須為 up 或 down。');
    if(value.tool==='grip'&&!['open','closed'].includes(a.state))throw new Error('夾爪狀態必須為 open 或 closed。');
    const d={tool:value.tool,args:copy(a),reason:String(value.reason||'').slice(0,600),expected:String(value.expected||'').slice(0,400),expectedProvided:Boolean(value.expectedProvided!==false&&typeof value.expected==='string'&&value.expected.trim()),source:['claude','gemini'].includes(value.source)?value.source:'adaptive'};
    if(['claude','gemini'].includes(d.source)){d.model=String(value.model||'').slice(0,120);d.usage={};for(const key of ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens','promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','cachedContentTokenCount'])if(Number.isFinite(value.usage?.[key]))d.usage[key]=value.usage[key];}
    return d;
  }

  class PickPlaceController {
    constructor(options={}){
      Object.assign(this,options);this.challenge=false;this.maxMissionDecisions=40;
      this._state=null;this._events=[];this._busy=false;this._disposed=false;this._epoch=0;this._navigation=null;this._navActive=false;
    }
    async initialize(){
      if(this._state)return this.snapshot();
      this._task=initialProgress();this._actuatorState={lift:null,gripper:null};this._observed=inspectTaskFrame(this.frameGetter());
      this._proposal=null;this._missionDecisions=0;this._auxiliaryCount=0;this._auxiliarySent=0;this._auxiliaryUnconfirmed=0;this._lastResult=null;this._decisionRecovery=new VlabDecisionRecovery();
      this._initialObject=null;this._graspEvidence=null;this._releaseEvidence=null;this._steps=[];this._surfaceRequired=Boolean(this.requireSurfaceEvidence);
      this._trialIndex=0;this._trialStartCounts={};this._trialMissionStart=0;this._coMotionEvidence=null;
      return this._emit({kind:'mission-ready',title:'控制權已取得，開始從 A 取物、放到 B',explanation:'先從相機辨識橘色物件與藍色放置區。升降、開合與平面移動都會經過已產生並測試的驅動程式。',nextLabel:'下一步：辨識取放場景'});
    }
    _setPhase(phase){this._task.phase=phase;this._task.label=PHASE_LABELS[phase]||phase;}
    _expected(){
      const map={inspect_scene:['inspect_scene',{}],prepare_lift:['lift',{position:'up'}],prepare_grip:['grip',{state:'open'}],approach:['select_goal',{target:'object'}],lower_pick:['lift',{position:'down'}],close:['grip',{state:'closed'}],raise_pick:['lift',{position:'up'}],verify_grasp:['verify_grasp',{}],transport:['select_goal',{target:'destination'}],lower_place:['lift',{position:'down'}],release:['grip',{state:'open'}],raise_clearance:['lift',{position:'up'}],clearance:['select_goal',{target:'clearance'}],verify_place:['verify_place',{}],recover_open:['grip',{state:'open'}]};
      return map[this._task.phase]||['stop',{}];
    }
    _allowed(){return [...new Set(['inspect_scene',this._expected()[0],'stop'])];}
    _context(){
      return this._decisionRecovery.context({phase:'mission',scope:'simulated-pick-place',allowedTools:this._allowed(),observed:copy(this._observed),actuator:copy(this._actuatorState),taskProgress:copy(this._task),lastResult:copy(this._lastResult),budgets:{actionsUsed:this._trialCounts().actionCount,maxActions:this.maxActions,decisionsUsed:this._missionDecisions-this._trialMissionStart,maxDecisions:this.maxMissionDecisions}});
    }
    _counts(){
      const s=this._navigation?.snapshot();const xy=s?.actionCount||0;
      return {actionCount:xy+this._auxiliaryCount,xyActionCount:xy,auxiliaryActionCount:this._auxiliaryCount,commandAttemptCount:(s?.commandAttemptCount||0)+this._auxiliarySent,unconfirmedActuationCount:(s?.unconfirmedActuationCount||0)+this._auxiliaryUnconfirmed,probeCount:s?.probeCount||0,recalibrations:s?.recalibrations||0,decisionCount:this._missionDecisions+(s?.decisionCount||0)};
    }
    _trialCounts(){
      const total=this._counts(),base=this._trialStartCounts||{},result={};
      for(const [key,value] of Object.entries(total))result[key]=value-(base[key]||0);
      return result;
    }
    async startNextTrial(){
      if(this._disposed||this._busy)throw new Error('請等待取放步驟結束後再建立下一回合。');
      if(!this._state?.done||this._state.failure||!this._task.completed)throw new Error('只有已通過放置驗證的回合才能接續下一回合。');
      this._epoch++;this._trialIndex++;this._trialStartCounts=this._counts();this._trialMissionStart=this._missionDecisions;
      this._task=initialProgress();this._proposal=null;this._navActive=false;this._navGoal=null;
      this._initialObject=null;this._preLiftObject=null;this._graspEvidence=null;this._coMotionEvidence=null;this._releaseEvidence=null;
      this._surfaceRequired=Boolean(this.requireSurfaceEvidence);this._releaseHeightEvidence=null;
      this._steps=[];this._lastResult=null;this._decisionRecovery.accept();
      // Keep the same navigation worker and its learned local model. Fresh
      // image observations and prediction residuals can still invalidate it.
      return this._emit({kind:'trial-ready',title:'新一回合：重新辨識物件與 B 區',explanation:'已保留同一設備的驅動與平面映射；取放證據已清空，須重新辨識、夾取、搬運並驗證。',nextLabel:'下一步：代理辨識新的取放場景'});
    }
    _emit(fields={}){
      const frame=this.frameGetter();this._observed=inspectTaskFrame(frame);this._task.placementError=distance(this._observed.object,this._observed.destinationSurface||this._observed.destination);
      const s=this._navigation?.snapshot();const state={seed:this.seed,strategy:this.strategy,stage:'mission',kind:'mission-result',title:'',explanation:'',nextLabel:'下一步：請代理選擇任務工具',done:false,failure:null,frame,beforeFrame:null,diagnostics:this.plant.diagnostics(),observation:s?.observation||null,jacobian:s?.jacobian||null,checkpoints:s?.checkpoints||{},command:null,decision:null,predicted:null,residual:null,predictionThreshold:null,applied:null,limited:null,beforeTip:null,afterTip:null,toolResult:null,policyStatus:this._proposal?'execute':'decide',...fields,...this._counts(),modelCalls:Number(this.provider?.calls)||0,taskProgress:copy(this._task),missionObserved:copy(this._observed),mission:{...copy(this._task),observed:copy(this._observed),actuator:copy(this._actuatorState),steps:copy(this._steps)},agentContext:this._navActive?(fields.agentContext||s?.agentContext||{}):this._context(),eventIndex:this._events.length};
      state.trialCounts=this._trialCounts();
      const {frame:raw,beforeFrame,diagnostics,events,...meta}=state;this._events.push(copy(meta));this._state={...state,events:this._events.slice()};return this.snapshot();
    }
    snapshot(){return this._state?{...this._state,historyLength:this._events.length}:null;}
    _failure(message,fields={}){this._proposal=null;this._navActive=false;return this._emit({kind:'failure',title:'取放實驗停止，保留目前結果',explanation:message,done:true,failure:message,nextLabel:'重新開始',...fields});}
    _decisionFailure(error){
      const result=this._decisionRecovery.reject(error,this._allowed(),this.strategy==='gemini'?'Gemini':'Claude');
      if(!result.willRetry)return this._failure(result.summary,result.fields);
      return this._emit({kind:'decision-rejected',title:'決策被拒絕，保留取放進度等待修正',explanation:result.summary,nextLabel:'下一步：請模型修正決策',...result.fields});
    }
    _offlineDecision(){
      const [tool,args]=this._expected();
      return {tool,args,source:'adaptive',reason:`依目前影像與已確認的命令狀態，執行「${this._task.label}」。`,expected:tool==='verify_place'?'物件位於 B 區、夾爪已張開且離開，物件位置保持不變。':tool==='verify_grasp'?'新影像中橘色物件隨升降抬起；搬運時還須驗證共同位移。':'取得新的回覆與影像，通過驗證後才進入下一階段。'};
    }
    async next(){
      if(this._disposed)throw new Error('取放實驗已關閉。');if(!this._state)return this.initialize();if(this._busy||this._state.done)return this.snapshot();
      this._busy=true;const epoch=this._epoch;
      try{
        if(this._navActive)return await this._navigateNext(epoch);
        if(this._proposal)return await this._execute(epoch);
        if(this._missionDecisions-this._trialMissionStart>=this.maxMissionDecisions)return this._failure('已達本回合取放工具決策上限，尚未完成影像驗證。');
        this._observed=inspectTaskFrame(this.frameGetter());let value;
        if(['claude','gemini'].includes(this.strategy)){
          try{value=await this.provider.decide(this._context(),this.frameGetter());}
          catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._decisionFailure(error);}
        }else value=this._offlineDecision();
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        if(['claude','gemini'].includes(this.strategy)&&value?.source!==this.strategy)throw new Error('模型決策來源與目前選擇的代理不符，禁止改用其他策略。');
        const d=validateMissionDecision(value,this._allowed());this._decisionRecovery.accept();this._missionDecisions++;this._proposal=d;
        return this._emit({kind:'decision',title:`代理提案：${LABELS[d.tool]}`,explanation:d.reason,decision:d,controllerPhase:d.tool,nextLabel:`下一步：執行「${LABELS[d.tool]}」`});
      }catch(error){if(epoch!==this._epoch||this._disposed)return this.snapshot();return this._failure(`任務未通過檢查：${String(error.message||error).slice(0,300)}`);}
      finally{if(epoch===this._epoch)this._busy=false;}
    }
    async _execute(epoch){
      const d=this._proposal;this._proposal=null;const beforeFrame=this.frameGetter();let ok=true,summary='',data=null;
      try{
        if(d.tool==='stop')return this._failure(d.reason||'代理選擇停止任務。');
        const [expectedTool,expectedArgs]=this._expected();
        if(d.tool!=='inspect_scene'&&(d.tool!==expectedTool||JSON.stringify(d.args)!==JSON.stringify(expectedArgs)))throw new Error(`目前階段是「${this._task.label}」，這項操作的先決條件尚未成立。`);
        this._observed=inspectTaskFrame(beforeFrame);
        if(d.tool==='inspect_scene'){
          if(!this._observed.tip||!this._observed.object||!this._observed.destination)throw new Error('相機中缺少夾具、橘色物件或藍色放置區，無法開始取放。');
          if(this._task.phase==='inspect_scene'){
            this._surfaceRequired=Boolean(this.requireSurfaceEvidence||this._observed.destinationSurface);this._releaseHeightEvidence=null;
          }
          if(this._surfaceRequired&&!this._observed.destinationSurface)throw new Error('平台頂面標記的影像證據不足，尚不能確認本回合取放場景。');
          this._task.objectDetected=true;if(!this._initialObject)this._initialObject=this._observed.object.slice();
          if(this._task.phase==='inspect_scene')this._setPhase('prepare_lift');
          summary='已從 RGBA 影像定位夾具、橘色物件與藍色 B 區；尚未假設物件已被夾住。';data=copy(this._observed);
        }else if(d.tool==='select_goal'){
          if(this._actuatorState.lift!=='up')throw new Error('請先升起夾具，再進行平面移動。');
          let target;
          if(d.args.target==='object'){
            if(this._actuatorState.gripper!=='open'||!this._observed.object)throw new Error('靠近物件前需先張開夾爪，且物件必須可見。');
            target=this._observed.object.slice();this._task.atObject=false;
          }else if(d.args.target==='destination'){
            if(!this._task.graspVerified||this._actuatorState.gripper!=='closed'||!this._observed.destination)throw new Error('請先完成取物影像驗證。');
            target=this._observed.destination.slice();
          }else{
            if(!this._task.released||this._actuatorState.gripper!=='open'||!this._observed.destination||!this._initialObject)throw new Error('請先在 B 區放下物件並張開夾爪。');
            const b=this._observed.destination,a=this._initialObject,len=distance(a,b);
            if(!len||len<35)throw new Error('影像中 A、B 距離不足以建立退出驗證。');
            target=[b[0]+28*(a[0]-b[0])/len,b[1]+28*(a[1]-b[1])/len];
          }
          if(!this._navigation){
            this._navigation=new AutonomousEngine({seed:this.seed,strategy:this.strategy,provider:this.provider,challenge:false,recordFrames:false,maxActions:this.maxActions,maxDecisions:this.maxDecisions,plant:this.plant,actuator:async command=>{
              if(this._trialCounts().actionCount>=this.maxActions)throw new Error('已達本回合取放動作上限；未送出額外命令。');
              return this.actuator(command);
            },frameGetter:this.frameGetter,preserveTarget:true,controller:this.controller||null});
            await this._navigation.initialize();
          }
          if(epoch!==this._epoch||this._disposed)return this.snapshot();
          // Only the B-zone goal is held fixed: the carried object occludes its ring
          // while approaching. Object and clearance goals keep per-step measurement.
          await this._navigation.setTargetPixel(...target,{fixTarget:this.fixedGoalTarget!==false&&d.args.target==='destination'});if(epoch!==this._epoch||this._disposed)return this.snapshot();
          this._navActive=true;this._navGoal=d.args.target;summary=`已依相機量測指定${d.args.target==='object'?'物件位置':d.args.target==='destination'?'B 區中心':'退出位置'}。平面控制器將自行試動、建立映射並逐步靠近。`;
          data={target:d.args.target,pixel:target,source:'camera-segmentation'};
        }else if(d.tool==='lift'||d.tool==='grip'){
          if(this._trialCounts().actionCount>=this.maxActions)throw new Error('已達本回合取放動作上限。');
          const command=d.tool==='lift'?{op:'lift',position:d.args.position}:{op:'grip',state:d.args.state};
          const ack=await this.mechanicalActuator(command);if(epoch!==this._epoch||this._disposed)return this.snapshot();
          this._auxiliarySent++;this._auxiliaryCount++;data=copy(ack);
          if(ack.driverError)return this._failure('命令已執行，但產生的驅動程式未能正確解碼回覆；已停止任務。',{kind:'action-failure',decision:d,command,applied:ack.applied,toolResult:{ok:false,driverError:ack.driverError,driverErrorCode:ack.driverErrorCode,driverDiagnostic:copy(ack.driverDiagnostic||null),wireSent:true},beforeFrame});
          if(d.tool==='lift')this._actuatorState.lift=d.args.position;else this._actuatorState.gripper=d.args.state;
          const phase=this._task.phase;
          if(phase==='prepare_lift')this._setPhase('prepare_grip');
          else if(phase==='prepare_grip'||phase==='recover_open')this._setPhase('approach');
          else if(phase==='lower_pick')this._setPhase('close');
          else if(phase==='close'){this._task.attempts++;this._preLiftObject=this._observed.object?.slice()||null;this._setPhase('raise_pick');}
          else if(phase==='raise_pick')this._setPhase('verify_grasp');
          else if(phase==='lower_place')this._setPhase('release');
          else if(phase==='release'){
            const released=inspectTaskFrame(this.frameGetter());
            this._task.released=true;this._releaseEvidence=released.object;
            this._releaseHeightEvidence={source:'release-camera-frame',tip:copy(released.tip),object:copy(released.object),destination:copy(released.destination),surface:copy(released.destinationSurface),expectedOffsetPx:released.surfaceOffsetPx,observedOffsetPx:released.tip&&released.object?released.tip[1]-(released.objectEdgeAnchored||released.object)[1]:null};
            this._setPhase('raise_clearance');
          }else if(phase==='raise_clearance')this._setPhase('clearance');
          summary=d.tool==='lift'?`設備已確認升降命令：${d.args.position==='up'?'升起':'下降'}。是否持有物件仍由相機驗證。`:`設備已確認夾爪命令：${d.args.state==='open'?'張開':'合攏'}。回覆本身不代表取放成功。`;
        }else if(d.tool==='verify_grasp'){
          const obs=this._observed,rise=this._preLiftObject&&obs.object?this._preLiftObject[1]-obs.object[1]:null;
          const lifted=this._actuatorState.lift==='up'&&this._actuatorState.gripper==='closed'&&obs.raisedOffsetError!==null&&obs.raisedOffsetError<5&&rise!==null&&rise>9;
          data={raisedOffsetError:obs.raisedOffsetError,observedRise:rise,proof:'橘色物件在升降前後的影像位置變化；搬運時還須通過共同位移驗證。'};
          if(!lifted){
            ok=false;this._task.graspVerified=false;
            if(this._task.attempts>=2)return this._failure('兩次嘗試仍未從影像確認物件抬起，任務停止。',{decision:d,toolResult:{ok:false,data},beforeFrame});
            this._setPhase('recover_open');summary='影像未證明物件已抬起；先張開夾爪，再重新觀察、定位與取物。';
          }else{
            this._task.graspVerified=true;this._graspEvidence={tip:obs.tip.slice(),object:obs.object.slice()};this._setPhase('transport');summary='影像確認橘色物件向上移動且位於夾具上方；搬運過程將繼續比對物件與夾具的共同位移。';
          }
        }else if(d.tool==='verify_place'){
          const obs=this._observed,error=distance(obs.object,obs.destinationSurface||obs.destination),separation=distance(obs.object,obs.tip),stable=distance(obs.object,this._releaseEvidence);
          const checks={objectVisible:Boolean(obs.object),destinationVisible:Boolean(obs.destination),insideDestination:error!==null&&error<=12,objectStayedAfterRelease:stable!==null&&stable<=4,gripperVisiblyAway:separation!==null&&separation>=16,liftCommandConfirmed:this._actuatorState.lift==='up',openCommandConfirmed:this._actuatorState.gripper==='open',graspImageVerified:this._task.graspVerified,transportCoMotionVerified:this._task.coMotionVerified,clearanceReached:this._task.cleared};
          if(this._surfaceRequired){
            const e=this._releaseHeightEvidence;
            checks.surfaceMarkerVisible=Boolean(obs.destinationSurface&&obs.destination);
            checks.releaseHeightMatched=Boolean(e?.tip&&e?.object&&Number.isFinite(e.expectedOffsetPx)&&Number.isFinite(e.observedOffsetPx)&&Math.abs(e.observedOffsetPx-e.expectedOffsetPx)<=2.5&&Math.abs(e.tip[0]-e.object[0])<=2.5);
            checks.platformStayedAfterRelease=Boolean(e?.surface&&obs.destinationSurface&&distance(e.surface,obs.destinationSurface)<=2);
          }
          const failedChecks=Object.keys(checks).filter(key=>!checks[key]),platformDrift=distance(this._releaseHeightEvidence?.surface,obs.destinationSurface);
          data={checks,failedChecks,placementError:error,separation,releaseDrift:stable,platformDrift,surfaceEvidence:copy(this._releaseHeightEvidence),markerQuality:copy(obs.markerQuality||null),source:'new-camera-frame'};
          if(failedChecks.length){
            const names={objectVisible:'物件影像不可見',destinationVisible:'B 區定位標記不足',insideDestination:'物件超出 B 區容差',objectStayedAfterRelease:'物件在釋放後位移超過容差',gripperVisiblyAway:'夾具尚未充分離開物件',liftCommandConfirmed:'尚未確認升起命令',openCommandConfirmed:'尚未確認張爪命令',graspImageVerified:'缺少抬起影像證據',transportCoMotionVerified:'缺少搬運共同位移證據',clearanceReached:'尚未到達退出位置',surfaceMarkerVisible:'平台頂面標記不足或圓心估測不可靠',releaseHeightMatched:'放置高度影像證據不符',platformStayedAfterRelease:platformDrift===null?'缺少前後兩次可信的平台影像':'平台標記的影像位移 '+platformDrift.toFixed(2)+' px 超過 2 px；需檢查遮蔽、相機或平台是否移動'};
            summary='放置驗證未通過：'+failedChecks.map(key=>names[key]||key).join('；')+'。已保留通過項目與實際量測。';
            return this._failure(summary,{decision:d,toolResult:{ok:false,summary,data},beforeFrame});
          }
          this._task.completed=true;this._task.placementError=error;this._setPhase('complete');summary=`取放已由新影像驗證：物件距 B 區中心 ${error.toFixed(2)} px，夾具已退出 ${separation.toFixed(1)} px，放開後物件位移 ${stable.toFixed(2)} px。`;
        }
      }catch(error){
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        if(error.wireSent){this._auxiliarySent++;this._auxiliaryUnconfirmed++;return this._failure('機械命令已送出，但回覆無法確認；可能已發生動作，已重新拍攝並停止。',{kind:'action-failure',decision:d,beforeFrame,toolResult:{ok:false,wireSent:true,error:String(error.message||error),driverErrorCode:error.code||null,driverDiagnostic:copy(error.diagnostic||null)}});}
        if(error.diagnostic)return this._failure(`驅動執行環境未完成命令編碼，尚未送出本次機械命令：${String(error.message||error).slice(0,300)}`,{decision:d,beforeFrame,toolResult:{ok:false,wireSent:false,driverErrorCode:error.code,driverDiagnostic:copy(error.diagnostic)}});
        ok=false;summary=String(error.message||error).slice(0,300);data={error:summary};
      }
      this._lastResult={tool:d.tool,ok,summary,...(!ok?{error:summary}:{})};this._steps.push({tool:d.tool,args:copy(d.args),phase:this._task.phase,ok,summary});
      return this._emit({kind:this._task.completed?'pick-place-complete':ok?'mission-result':'mission-error',title:this._task.completed?'從零到取放：完成影像驗證':`工具結果：${LABELS[d.tool]}`,explanation:summary,done:this._task.completed,decision:d,toolResult:{ok,summary,data},beforeFrame,controllerPhase:d.tool,nextLabel:this._task.completed?'重新開始':this._navActive?'下一步：代理選擇平面控制工具':'下一步：代理選擇任務工具'});
    }
    async _navigateNext(epoch){
      // Observation and verification remain available at the action limit.
      // The actuator boundary above rejects only additional movement commands.
      const state=await this._navigation.next();if(epoch!==this._epoch||this._disposed)return this.snapshot();
      const obs=inspectTaskFrame(this.frameGetter());
      if(this._navGoal==='destination'&&this._graspEvidence&&obs.tip&&obs.object){
        const e=this._graspEvidence,dt=[obs.tip[0]-e.tip[0],obs.tip[1]-e.tip[1]],dobj=[obs.object[0]-e.object[0],obs.object[1]-e.object[1]];
        if(Math.hypot(...dt)>12&&distance(dt,dobj)<4&&obs.raisedOffsetError<5){this._task.coMotionVerified=true;this._coMotionEvidence={tipDisplacement:dt,objectDisplacement:dobj,residual:distance(dt,dobj)};}
      }
      if(state.failure)return this._failure(state.failure,{...state,done:true,failure:state.failure});
      if(state.done){
        const goal=this._navGoal;this._navActive=false;
        if(goal==='object'){this._task.atObject=true;this._setPhase('lower_pick');}
        else if(goal==='destination'){this._task.atDestination=true;this._setPhase('lower_place');}
        else{this._task.cleared=true;this._setPhase('verify_place');}
        const summary=goal==='object'?'夾具已依影像對準物件；尚未取物，接下來下降並合攏夾爪。':goal==='destination'?'已搬運到 B 區上方；尚未放置，接下來下降並張開夾爪。':'夾具已離開放置位置；接下來重新拍攝，確認物件仍留在 B 區。';
        this._lastResult={tool:'select_goal',ok:true,summary};
        return this._emit({...state,stage:'mission',kind:goal==='object'?'object-reached':goal==='destination'?'destination-reached':'clearance-reached',title:goal==='object'?'已對準 A 點物件':goal==='destination'?'已到達 B 區上方':'夾具已退出放置區',explanation:summary,done:false,nextLabel:'下一步：代理選擇任務工具',toolResult:{ok:true,summary,target:goal}});
      }
      return this._emit({...state,stage:'mission-navigation',done:false});
    }
    async setTargetPixel(){throw new Error('完整取放任務的目標由物件與 B 區影像決定；請重新開始以建立另一個場景。');}
    async perturb(kind='motor'){
      if(this._busy)throw new Error('請先暫停並等待目前步驟完成。');
      if(!this._navActive)throw new Error('請在平面移動階段測試干擾。');
      return this._emit({...await this._navigation.perturb(kind),stage:'mission-navigation',done:false});
    }
    report(){return {version:'0.7.0',...this._counts(),done:Boolean(this._state?.done),failure:this._state?.failure||null,parameters:{seed:this.seed,tolerancePx:7,placementTolerancePx:12,maxActions:this.maxActions,maxMissionDecisions:this.maxMissionDecisions,cameraPixels:[640,480]},scenario:{type:'pick-place',challenge:false},taskProgress:copy(this._task),missionObserved:copy(this._observed),actuator:copy(this._actuatorState),evidence:{grasp:copy(this._graspEvidence),coMotion:copy(this._coMotionEvidence),release:copy(this._releaseEvidence),surface:copy(this._releaseHeightEvidence)},decisionRejections:VlabDecisionRecovery.count(this._events),decisionCorrectionLimit:2,trace:copy(this._events)};}
    dispose(){this._disposed=true;this._epoch++;this.provider?.abort?.();this._navigation?.dispose();}
  }
  class PickPlaceExperimentEngine extends FullExperimentEngine {
    constructor(options={}){
      super({...options,challenge:false,controlFactory:config=>new PickPlaceController({...config,requireSurfaceEvidence:true,fixedGoalTarget:options.fixedGoalTarget!==false})});
      this.fixedGoalTarget=options.fixedGoalTarget!==false;
      this.trialCount=this._validateTrialCount(options.trialCount??1);
    }
    _validateTrialCount(value){if(value!==1&&value!==5)throw new Error('請選擇單回合或五回合連續測試。');return value;}
    async reset(seed=this.seed,options={}){
      if('trialCount'in options)this.trialCount=this._validateTrialCount(options.trialCount);
      return super.reset(seed,options);
    }
    _configureInitialScenario(){
      this._trialIndex=0;this._trialResults=[];this._trialTransition=null;this._suiteStatus='running';
      this._suiteConnectionVerified=false;this._trialStartCalls=0;this._trialEventStart=0;
      this._trialScenario=this._plant.configureTrial(0,{initialPose:true});
    }
    _suiteView(){
      return {trialIndex:this._trialIndex||0,trialNumber:(this._trialIndex||0)+1,trialCount:this.trialCount,totalCompleted:(this._trialResults||[]).filter(x=>x.success).length,status:this._suiteStatus||'running',connectionVerified:this._suiteStatus==='failed'&&!this._onboarding?.ready?false:this._trialIndex===0&&!this._trialTransition?Boolean(this._onboarding?.handshake?.ok):Boolean(this._suiteConnectionVerified),reusedDriver:(this._trialIndex||0)>0,results:copy(this._trialResults||[])};
    }
    _emit(fields={}){
      if(fields.done&&fields.failure){this._suiteStatus='failed';this._trialTransition=null;}
      return super._emit({taskProgress:fields.taskProgress||this._control?.snapshot()?.taskProgress||initialProgress(),missionObserved:fields.missionObserved||null,xyActionCount:fields.xyActionCount||0,auxiliaryActionCount:fields.auxiliaryActionCount||0,...fields,suiteProgress:this._suiteView(),trialScenario:copy(this._trialScenario||null)});
    }
    _recordTrial(state){
      if(this._trialResults.some(x=>x.trialIndex===this._trialIndex))return;
      const mission=this._control?.report(),scenario=this._trialScenario||{},counts=state.trialCounts||this._control?._trialCounts?.()||{};
      this._trialResults.push({trialIndex:this._trialIndex,trialNumber:this._trialIndex+1,label:scenario.label||`第 ${this._trialIndex+1} 回合`,destinationHeight:scenario.destinationHeight??null,sourceHeight:scenario.sourceHeight??0,success:Boolean(state.done&&!state.failure&&state.taskProgress?.completed),failure:state.failure||null,placementError:state.taskProgress?.placementError??null,...copy(counts),modelCalls:this._frontCalls+this._controlCalls-this._trialStartCalls,eventStart:this._trialEventStart,eventEnd:this._events.length,evidence:copy(mission?.evidence||null),driverSourceHash:this._onboarding?.driverTests?.sourceHash||this._onboarding?.compileResult?.sourceHash||null,connectionConfirmed:Boolean(this._onboarding?.handshake?.ok),reusedDriver:this._trialIndex>0});
    }
    _appendControl(state){
      if(state.done){
        if(!state.failure&&!state.taskProgress?.completed)state={...state,failure:'控制流程已停止，但本回合尚未通過取放影像驗證。',kind:'failure'};
        this._recordTrial(state);
        if(state.failure||!state.taskProgress?.completed){this._suiteStatus='failed';this._trialTransition=null;}
        else if(this._trialIndex+1<this.trialCount){
          this._suiteStatus='between-trials';this._suiteConnectionVerified=false;this._trialTransition='handshake';
          state={...state,done:false,kind:'trial-complete',title:`第 ${this._trialIndex+1}／${this.trialCount} 回合完成`,explanation:`本回合已通過新的取放影像驗證。下一步只確認原通訊連線，再更換 A、B 場景；沿用已測試的驅動與目前局部映射。`,nextLabel:'下一步：確認同一工作站的通訊連線'};
        }else{
          this._suiteStatus='complete';this._suiteConnectionVerified=true;this._trialTransition=null;
          if(this.trialCount>1)state={...state,kind:'suite-complete',title:`${this.trialCount} 回合連續取放已完成`,explanation:`每一回合都重新建立夾取、搬運與放置影像證據。共完成 ${this._trialResults.filter(x=>x.success).length}／${this.trialCount} 回合；結果與原始通訊紀錄已保留。`};
        }
      }
      return super._appendControl(state);
    }
    _transitionFields(){
      const state=this._control?.snapshot()||{};
      return {...this._control?._counts?.(),decisionCount:this._frontDecisions+(state.decisionCount||0),modelCalls:this._frontCalls+this._controlCalls,taskProgress:copy(state.taskProgress||initialProgress()),trialCounts:copy(state.trialCounts||{}),mission:copy(state.mission||null),missionObserved:copy(state.missionObserved||null),observation:copy(state.observation||null),jacobian:copy(state.jacobian||null),checkpoints:copy(state.checkpoints||{})};
    }
    async next(){
      if(!this._trialTransition)return super.next();
      if(this._disposed)throw new Error('實驗已關閉。');
      if(this._busy||this._state?.done)return this.snapshot();
      this._busy=true;const epoch=this._epoch;
      try{
        if(this._trialTransition==='handshake'){
          const prior=this._onboarding.handshake,connection=this._onboarding.connection;
          if(!this._link.connected||!connection||!prior?.ok)throw new Error('原工作站的通訊連線已中斷。');
          const result=await this._link.handshake();
          if(epoch!==this._epoch||this._disposed)return this.snapshot();
          if(!result?.ok||result.model!==prior.model||result.protocol!==prior.protocol||result.channels!==prior.channels)throw new Error('連線確認的型號、協定或通道能力與原工作站不一致。');
          const tx=this._traffic().slice().reverse().find(item=>item.direction==='TX'&&!item.dryRun);
          if(tx&&(tx.endpointId!==connection.endpointId||tx.transport!==connection.transport))throw new Error('通訊回覆並非來自原先連線的端點。');
          this._onboarding.handshake=copy(result);this._suiteConnectionVerified=true;this._suiteStatus='connection-confirmed';this._trialTransition='prepare';
          return this._emit({...this._transitionFields(),kind:'trial-connection-confirmed',title:'原工作站通訊確認成功',explanation:'已透過保留的連線重新送出 hello 並確認型號、協定與通道。沒有重編譯驅動、沒有試動，也未宣稱取得硬體唯一身分。下一步才更換物件位置。',toolResult:{ok:true,summary:'原端點握手通過；沿用同一連線與已測試驅動。',data:copy(result)},nextLabel:'下一步：更換 A、B 場景並開始新回合'});
        }
        if(!this._suiteConnectionVerified)throw new Error('尚未確認連線，不可更换取放場景。');
        this._trialScenario=this._plant.configureTrial(this._trialIndex+1,{initialPose:false});
        this._trialIndex++;this._trialStartCalls=this._frontCalls+this._controlCalls;this._trialEventStart=this._events.length;
        this._trialTransition=null;this._suiteStatus='running';
        const state=await this._control.startNextTrial();
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        return this._appendControl(state);
      }catch(error){
        if(epoch!==this._epoch||this._disposed)return this.snapshot();
        this._suiteStatus='failed';this._trialTransition=null;this._suiteConnectionVerified=false;
        this._onboarding.ready=false;this._onboarding.status='failed';
        return this._failure(`連續測試停止：${String(error.message||error).slice(0,240)} 已保留先前完成的回合；不再送出取放動作。`,this._transitionFields());
      }finally{if(epoch===this._epoch)this._busy=false;}
    }
    report(){
      const report=super.report(),mission=this._control?.report();
      return {...report,version:'0.7.0',scope:`模擬 ${this.device==='VLAB-G3'?'VLAB-G3 直角座標龍門（十六進位二進位框架協定）':'VLAB-P2 2R 平面手臂（JSON 單行協定）'}搭配離散升降／夾爪介面${this.manualTemplate?'':'；手冊不含驅動範本'}${this.controllerMode==='generated'?'；XY 由通過隔離測試的控制程式執行':''}：首次設備辨識、連線與驅動產生；同工作站後續回合重新握手、沿用驅動與映射，重新驗證取放。高度為模擬平台接觸；未包含跨工作站、真實硬體、6 軸姿態或完整接觸動力學。`,taskProgress:copy(this._state?.taskProgress||initialProgress()),xyActionCount:mission?.xyActionCount||0,auxiliaryActionCount:mission?.auxiliaryActionCount||0,missionEvidence:copy(mission?.evidence||null),suiteProgress:this._suiteView(),trialScenario:copy(this._trialScenario),trials:copy(this._trialResults||[]),trialCounts:copy(this._control?._trialCounts?.()||{}),suiteParameters:{trialCount:this.trialCount,maxActionsPerTrial:this.maxActions,driverReuse:'same-link-runtime-and-source',modelReuse:'same-navigation-worker; image residuals can trigger recalibration',connectionIdentity:'same retained endpoint plus model/protocol/channels; no unique hardware ID',goalTarget:this.fixedGoalTarget===false?'re-measured every step (legacy)':'B-zone goal measured once by camera at select_goal, then held fixed; object and clearance goals re-measured every step'},trafficStorage:{complete:'onboarding.traffic',eventSnapshots:'latest 15 packets per event'}};
    }
  }
  global.inspectTaskFrame=inspectTaskFrame;global.validateMissionDecision=validateMissionDecision;
  global.PickPlaceController=PickPlaceController;global.PickPlaceExperimentEngine=PickPlaceExperimentEngine;
})(globalThis);
