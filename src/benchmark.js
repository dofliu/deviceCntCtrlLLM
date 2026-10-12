(function(global){
  'use strict';
  const SEEDS=Object.freeze([42,...Array.from({length:19},(_,i)=>i+1)]);
  const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const clone=value=>JSON.parse(JSON.stringify(value));
  async function run({strategies=['baseline','adaptive'],seeds=SEEDS,onProgress=()=>{},signal,maxActions=180}={}){
    if(!Array.isArray(strategies)||strategies.some(s=>!['baseline','adaptive'].includes(s)))throw new Error('此比較只執行離線策略；不會自動產生模型 API 費用。');
    if(!Array.isArray(seeds)||!seeds.length||seeds.length>100)throw new Error('請指定 1 至 100 組設備種子。');
    const rows=[],total=seeds.length*strategies.length,started=performance.now();
    let aborted=false;
    for(const seed of seeds){
      for(const strategy of strategies){
        if(signal?.aborted){aborted=true;break;}
        const engine=new AutonomousEngine({seed,strategy,challenge:true,recordFrames:false,maxActions,maxDecisions:500});
        let report=null,error=null;
        try{
          let state=await engine.initialize();
          for(let steps=0;!state.done&&steps<1600;steps++){
            if(signal?.aborted){aborted=true;break;}
            state=await engine.next();
            if(steps%30===0)await new Promise(resolve=>setTimeout(resolve,0));
          }
          report=engine.report();
          if(!report.done&&!aborted)error='超過評測事件上限。';
        }catch(e){error=e.message||'評測中斷';}
        finally{engine.dispose();}
        if(aborted)break;
        const cp=report?.checkpoints||{},trace=report?.trace||[];
        const success=Boolean(report?.done&&!report.failure&&cp.firstReach&&cp.recovered);
        const last=trace.slice().reverse().find(e=>Number.isFinite(e.observation?.error));
        const row={seed,strategy,success,firstReach:cp.firstReach||null,recovered:cp.recovered||null,
          actions:report?.actionCount??0,probes:report?.probeCount??0,recalibrations:report?.recalibrations??0,
          decisions:report?.decisionCount??trace.filter(e=>e.kind==='decision').length,
          error:last?.observation?.error??null,reason:error||report?.failure||(!success?'未完成全部任務':null),
          mismatchSeen:Boolean(cp.mismatchSeen),modelCalls:report?.modelCalls??0,scenario:clone(report?.scenario||{}),
          parameters:clone(report?.parameters||{})};
        rows.push(row);onProgress({completed:rows.length,total,row:clone(row)});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      if(aborted)break;
    }
    const summary=strategies.map(strategy=>{
      const rr=rows.filter(r=>r.strategy===strategy),success=rr.filter(r=>r.success),first=rr.filter(r=>r.firstReach),recovered=rr.filter(r=>r.recovered);
      return {strategy,cases:seeds.length,completed:rr.length,successes:success.length,
        successRate:rr.length?success.length/rr.length:null,firstReaches:first.length,recoveries:recovered.length,
        recoveryRate:first.length?recovered.length/first.length:null,
        meanActions:average(rr.map(r=>r.actions)),meanProbes:average(rr.map(r=>r.probes)),
        meanError:average(success.map(r=>r.error).filter(Number.isFinite)),
        meanSuccessActions:average(success.map(r=>r.actions)),failures:rr.filter(r=>!r.success).length};
    });
    const paired=seeds.map(seed=>{
      const b=rows.find(r=>r.seed===seed&&r.strategy==='baseline'),a=rows.find(r=>r.seed===seed&&r.strategy==='adaptive');
      if(!a||!b)return {seed,complete:false};
      const validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
      const targetsEqual=[a.scenario.target1,a.scenario.target2,b.scenario.target1,b.scenario.target2].every(validPoint)&&JSON.stringify(a.scenario.target1)===JSON.stringify(b.scenario.target1)&&JSON.stringify(a.scenario.target2)===JSON.stringify(b.scenario.target2);
      const faultEqual=a.scenario.changedChannel==null||b.scenario.changedChannel==null?null:a.scenario.changedChannel===b.scenario.changedChannel;
      return {seed,complete:true,targetsEqual,faultEqual,bothSucceeded:a.success&&b.success,
        actionDifferenceAdaptiveMinusBaseline:a.actions-b.actions};
    });
    return {version:'0.3.0',type:'offline-policy-comparison',languageModelTested:false,
      parameters:{seeds:[...seeds],strategies:[...strategies],maxActionsPerGoal:maxActions,tolerancePx:7,
        scenario:'Same two precomputed image targets; one hidden motor reversal after verified goal 1.',
        successDenominator:'completed cases; stopped comparisons explicitly marked partial',
        recoveryDenominator:'cases that reached goal 1',meanActionsIncludesFailures:true},
      rows,summary,paired,aborted,completed:rows.length,total,durationMs:performance.now()-started};
  }
  global.V3Benchmark={run,seeds:SEEDS};
})(globalThis);
