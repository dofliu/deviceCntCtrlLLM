(function (global) {
  'use strict';
  const copy = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
  const norm = a => Math.hypot(...a);
  const mul = (J,u) => J.map(r => r[0]*u[0]+r[1]*u[1]);
  const tools = ['observe','probe','fit_model','move','reset_model','verify','stop'];
  function validateDecision(value) {
    if (!value || !tools.includes(value.tool) || !value.args || typeof value.args!=='object' || Array.isArray(value.args)) throw new Error('決策工具或參數格式錯誤。');
    const d = {tool:value.tool,args:copy(value.args),reason:String(value.reason||'').slice(0,600),expected:String(value.expected||'').slice(0,400),expectedProvided:Boolean(value.expectedProvided!==false&&typeof value.expected==='string'&&value.expected.trim()),source:String(value.source||'adaptive').slice(0,30)};
    if(['gemini','claude'].includes(value.source)) {
      d.model=typeof value.model==='string'?value.model.slice(0,120):null;
      d.usage={};for(const key of ['promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','cachedContentTokenCount','input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'])if(Number.isFinite(value.usage?.[key]))d.usage[key]=value.usage[key];
    }
    const a=d.args;
    if (d.tool==='probe') {
      if (Object.keys(a).some(k=>!['channel','direction','amplitude'].includes(k)) || ![0,1].includes(a.channel)||![-1,1].includes(a.direction)||!Number.isFinite(a.amplitude)||a.amplitude<0.01||a.amplitude>0.10) throw new Error('試動參數超出允許範圍。');
    } else if(d.tool==='move') {
      if(Object.keys(a).some(k=>k!=='scale')||!Number.isFinite(a.scale)||a.scale<=0||a.scale>1)throw new Error('移動比例需介於 0 與 1。');
    } else if(Object.keys(a).length)throw new Error('這個工具不接受額外參數。');
    return d;
  }

  class AgentCore {
    constructor({maxActions=180,maxDecisions=300}={}) {
      this.maxActions=maxActions;this.maxDecisions=maxDecisions;
      this.baseline=new VisualController({tolerance:7,maxActions});
      this.observation=null;this.J=null;this.samples=[];this.lastOutcome=null;
      this.observed=false;this.verified=false;this.stale=false;this.generation=0;
      this.actions=0;this.totalActions=0;this.decisions=0;this.probes=0;this.recalibrations=0;
      this.trust=.09;this.errors=[];this.baselineAck=[0,0];this.baselineResult=null;this.baselineRecal=0;
    }
    goal() {
      this.heldTarget=null;this.actions=0;this.decisions=0;this.verified=false;this.errors=[];
      this.baseline.setGoal();this.baselineAck=[0,0];this.baselineRecal=0;this.baselineResult=null;
      this.baselineBackup=null;
      // Retain the model. Goal updates never announce a device change.
    }
    inspect(frame) {return VisualController.inspect(frame);}
    observe(frame) {
      const seen=this.inspect(frame);
      // holdTarget on the goal frame: measure the goal marker once from the
      // camera and hold it until the next goal, so a carried object that later
      // occludes the marker cannot drag the target. Fallback: requested pixel.
      const valid=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite);
      if(frame?.holdTarget&&!this.heldTarget)this.heldTarget=valid(seen.target)?seen.target.slice():valid(frame.requestedTarget)?frame.requestedTarget.slice():null;
      if(this.heldTarget){seen.target=this.heldTarget.slice();seen.error=seen.tip?norm(sub(seen.target,seen.tip)):null;seen.targetSource='held-goal';}
      this.observation=seen;this.observed=true;
      return copy(this.observation);
    }
    quality() {
      if(!this.J)return null;
      const J=this.J;return Math.abs(J[0][0]*J[1][1]-J[0][1]*J[1][0])/Math.max(1,Math.hypot(J[0][0],J[1][0])*Math.hypot(J[0][1],J[1][1]));
    }
    context() {
      const coverage=[0,0],excitation=[0,0];
      for(const s of this.samples)for(let c=0;c<2;c++)if(Math.abs(s.u[c])>.0001){coverage[c]++;excitation[c]+=s.u[c]**2;}
      return {observation:copy(this.observation),model:{jacobian:copy(this.J),quality:this.quality(),stale:this.stale,generation:this.generation},samples:{count:this.samples.length,coverage,excitation},lastOutcome:copy(this.lastOutcome),budgets:{actionsUsed:this.actions,maxActions:this.maxActions,decisionsUsed:this.decisions,maxDecisions:this.maxDecisions},allowedTools:tools.slice(),tolerancePx:7,observed:this.observed,verified:this.verified};
    }
    adaptiveDecision() {
      const ctx=this.context(),obs=ctx.observation;
      const d=(tool,args,reason,expected)=>({tool,args,reason,expected,source:'adaptive'});
      if(!this.observed)return d('observe',{},'先取得相機影像，確認末端與目標是否可見。','取得兩個標記的像素位置。');
      if(!obs?.tip||!obs?.target)return d('stop',{},'影像缺少可辨識的末端或目標，無法可靠計算控制。','停止送出動作並保留現有量測。');
      if(obs.error<=7)return d('verify',{},`目前量測誤差 ${obs.error.toFixed(2)} px，要求重新拍攝驗證。`,'新影像仍落在 7 px 容許範圍內。');
      if(this.actions>=this.maxActions)return d('stop',{},'本目標的動作預算已用完。','回報未到達，停止控制。');
      if(this.stale)return d('reset_model',{},'實際位移與模型預測不符，或近期誤差沒有改善；需要重新量測。','清除失效的映射，重新選擇有資訊的試動。');
      if(!this.J) {
        const coverage=ctx.samples.coverage;
        if(coverage.every(c=>c>0)&&this.lastOutcome?.tool!=='fit_model')return d('fit_model',{},'兩個獨立輸入通道已有實際位移樣本，可估計局部映射。','用已確認執行的輸入與影像位移擬合 Jacobian。');
        const c=ctx.samples.excitation[0]<=ctx.samples.excitation[1]?0:1;
        const previous=this.samples.slice().reverse().find(s=>Math.abs(s.u[c])>.0001);
        const last=this.lastOutcome,blocked=last?.tool==='probe'&&last.limited&&Math.abs(last.command?.[c]||0)>.0001&&Math.abs(last.applied?.[c]||0)<=.0001;
        // A probe clamped to zero at a joint limit adds no sample; reverse it instead of repeating the same blocked input.
        const direction=blocked ? -Math.sign(last.command[c]) : previous ? (previous.improvement>=0?Math.sign(previous.u[c]):-Math.sign(previous.u[c])) : 1;
        return d('probe',{channel:c,direction,amplitude:.045},`通道 ${c===0?'A':'B'} 的有效激發量較少，選擇一次小幅試動補足量測。`,'量測這個輸入造成的末端位移，供映射估計使用。');
      }
      return d('move',{scale:.72},`已有局部映射，依目前 ${obs.error.toFixed(1)} px 的位置誤差計算有限幅度動作。`,'縮小目標誤差，並以新影像比較預測與實際位移。');
    }
    baselineDecision(frame) {
      if(!this.observed)return {tool:'observe',args:{},reason:'V2 固定策略先取得影像。',expected:'辨識末端與目標。',source:'baseline'};
      this.baselineBackup={baseline:copy(this.baseline),ack:this.baselineAck.slice(),J:copy(this.J),observation:copy(this.observation),recalibrations:this.recalibrations,baselineRecal:this.baselineRecal};
      const r=this.baseline.step({...frame,applied:this.baselineAck});this.baselineAck=[0,0];this.baselineResult=r;
      this.observation={tip:r.tip,target:r.target,error:r.error};this.J=copy(r.jacobian);
      this.recalibrations+=Math.max(0,r.recalibrations-this.baselineRecal);this.baselineRecal=r.recalibrations;
      const source='baseline';
      if(r.status==='success')return {tool:'verify',args:{},reason:'V2 固定策略判定已到達，仍需重新拍攝驗證。',expected:'誤差小於 7 px。',source};
      if(!r.action)return {tool:'stop',args:{},reason:'V2 固定策略無法繼續，保留失敗結果。',expected:'停止動作。',source};
      if(r.phase==='probe'||r.phase==='recalibrate') {
        const c=Math.abs(r.action[0])>0?0:1;
        return {tool:'probe',args:{channel:c,direction:Math.sign(r.action[c]),amplitude:Math.abs(r.action[c])},reason:'V2 基準策略：依序執行固定六次試動，建立或重新建立映射。',expected:'取得該通道的位移樣本。',source};
      }
      return {tool:'move',args:{scale:.72},reason:'V2 基準策略：使用原有阻尼最小平方控制器計算下一步。',expected:'降低目標誤差，下一輪以固定門檻檢查模型。',source};
    }
    cancel() {
      const b=this.baselineBackup;
      if(b){Object.assign(this.baseline,b.baseline);this.baselineAck=b.ack;this.J=b.J;this.observation=b.observation;this.recalibrations=b.recalibrations;this.baselineRecal=b.baselineRecal;}
      this.baselineBackup=null;this.baselineResult=null;return this.context();
    }
    prepare(value,strategy) {
      const d=validateDecision(value);this.decisions++;
      let command=null;
      if(['probe','move'].includes(d.tool)) {
        if(!this.observation?.tip||!this.observation?.target)throw new Error('缺少影像定位，不允許動作。');
        if(this.actions>=this.maxActions)throw new Error('已達本目標動作上限。');
        if(strategy==='baseline'&&this.baselineResult?.action)command=this.baselineResult.action.slice();
        else if(d.tool==='probe'){command=[0,0];command[d.args.channel]=d.args.direction*d.args.amplitude;}
        else {
          if(!this.J||this.stale)throw new Error('沒有可用映射，請先試動與建立模型。');
          command=this.move(sub(this.observation.target,this.observation.tip),d.args.scale);
        }
        if(!command.every(Number.isFinite))throw new Error('控制量不是有限數值。');
        command=command.map(v=>Math.max(-.1,Math.min(.1,v)));
      }
      const displacement=command&&this.J?mul(this.J,command):null;
      return {decision:d,command,predicted:displacement?this.observation.tip.map((p,i)=>p+displacement[i]):null,jacobian:copy(this.J),context:this.context(),recalibrations:this.recalibrations};
    }
    move(e,scale) {
      const J=this.J,damping=4+Math.max(0,.18-this.quality())*80;
      const a=J[0][0]**2+J[0][1]**2+damping**2,b=J[0][0]*J[1][0]+J[0][1]*J[1][1],d=J[1][0]**2+J[1][1]**2+damping**2;
      const det=a*d-b*b,f=Math.min(scale,28/Math.max(1,norm(e))),v=[(d*e[0]-b*e[1])*f/det,(a*e[1]-b*e[0])*f/det];
      const u=[J[0][0]*v[0]+J[1][0]*v[1],J[0][1]*v[0]+J[1][1]*v[1]];
      const limit=Math.min(1,this.trust/Math.max(.000001,...u.map(Math.abs)));return u.map(x=>x*limit);
    }
    outcome({frame,applied,command,tool,limited,strategy}) {
      this.baselineBackup=null;
      const before=copy(this.observation),J=copy(this.J);this.observe(frame);
      this.actions++;this.totalActions++;if(tool==='probe')this.probes++;
      this.baselineAck=applied.slice();
      let predicted=null,residual=null,threshold=null,improvement=null,mismatch=false;
      if(before?.tip&&this.observation.tip) {
        const delta=sub(this.observation.tip,before.tip);improvement=before.error-this.observation.error;
        this.samples.push({u:applied.slice(),delta,improvement});if(this.samples.length>32)this.samples.shift();
        if(J){const expected=mul(J,applied);predicted=before.tip.map((p,i)=>p+expected[i]);residual=norm(sub(delta,expected));threshold=Math.max(6,.65*norm(expected));mismatch=residual>threshold;
          if(strategy!=='baseline'&&tool==='move') {
            if(mismatch){this.stale=true;this.trust=Math.max(.045,this.trust*.7);}
            else {const uu=applied[0]**2+applied[1]**2;if(uu>.00002){const r=sub(delta,expected);for(let i=0;i<2;i++)for(let j=0;j<2;j++)this.J[i][j]+=.55*r[i]*applied[j]/uu;}this.trust=Math.min(.09,this.trust+.005);}
          }
        }
      }
      this.errors.push(this.observation.error);if(this.errors.length>10)this.errors.shift();
      if(strategy!=='baseline'&&tool==='move'&&this.errors.length===10&&Math.min(...this.errors.slice(5))>=Math.min(...this.errors.slice(0,5))-1.5)this.stale=true;
      this.verified=false;
      this.lastOutcome={tool,command:command.slice(),applied:applied.slice(),beforeTip:before?.tip||null,afterTip:this.observation.tip,predicted,residual,threshold,mismatch,limited:Boolean(limited),improvement,ok:Boolean(this.observation.tip&&this.observation.target),summary:mismatch?'實際位移超過模型預測誤差門檻。':`已執行動作，影像誤差 ${this.observation.error?.toFixed(2)??'未知'} px。`};
      return {observation:copy(this.observation),lastOutcome:copy(this.lastOutcome),context:this.context(),jacobian:J};
    }
    execute({decision,frame}) {
      this.baselineBackup=null;
      const d=validateDecision(decision);let ok=true,summary='',observation=this.observation;
      if(d.tool==='observe') {observation=this.observe(frame);ok=Boolean(observation.tip&&observation.target);summary=ok?'已辨識末端與目標。':'影像缺少定位標記。';}
      if(d.tool==='reset_model') {this.J=null;this.samples=[];this.stale=false;this.errors=[];this.recalibrations++;summary='已清除映射與舊樣本，等待新的試動量測。';}
      if(d.tool==='fit_model') {
        let a=0,b=0,dg=0;const n=[[0,0],[0,0]];
        for(const s of this.samples){a+=s.u[0]**2;b+=s.u[0]*s.u[1];dg+=s.u[1]**2;for(let r=0;r<2;r++){n[r][0]+=s.delta[r]*s.u[0];n[r][1]+=s.delta[r]*s.u[1];}}
        const det=a*dg-b*b;ok=det>1e-10;
        if(ok){this.J=n.map(r=>[(r[0]*dg-r[1]*b)/det,(r[1]*a-r[0]*b)/det]);ok=this.J.flat().every(Number.isFinite)&&this.quality()>.005;}
        if(ok){this.stale=false;this.generation++;this.errors=[];summary=`已以 ${this.samples.length} 筆實際位移樣本建立局部映射。`;}
        else{this.J=null;summary='輸入激發不足或映射退化，需要補充不同通道的試動。';}
      }
      if(d.tool==='verify'){observation=this.observe(frame);ok=Boolean(observation.tip&&observation.target&&observation.error<=7);this.verified=ok;summary=ok?'新影像確認誤差在 7 px 內。':'新影像尚未符合到達條件。';}
      if(d.tool==='stop'){ok=false;summary='代理選擇停止，尚未驗證完成。';}
      this.lastOutcome={tool:d.tool,command:null,applied:null,beforeTip:null,afterTip:observation?.tip||null,predicted:null,residual:null,threshold:null,mismatch:false,limited:false,improvement:null,ok,summary};
      return {ok,summary,observation:copy(observation),jacobian:copy(this.J),context:this.context(),recalibrations:this.recalibrations};
    }
  }
  global.AgentCore=AgentCore;global.validateAgentDecision=validateDecision;
})(typeof self!=='undefined'?self:globalThis);
