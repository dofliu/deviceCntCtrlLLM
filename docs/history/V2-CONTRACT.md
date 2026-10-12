# V2 step-by-step unknown-device experiment

User found V1 purpose unclear/too simple. V2 must tell a factual COMPLETE experimental story with user-steppable observation, command, outcome, learning, reaching, changed device, mismatch and recovery. Existing V1 algorithm is real and must remain image-only in Worker. No LLM/no fabricated AI deliberation. Build offline single HTML, source separate, preserve V1.

## Files and ownership
- root: src/app.js integration, build.py, tests, docs, packaging.
- engine agent: src/engine.js, src/controller.js (copy V1 with inspect API), src/plant.js(copy unchanged unless necessary). Own these only.
- UI agent: src/index.template.html, src/styles.css only.
- scene agent: src/scene3d.js only, use local `work/vendor/three.min.js` (global THREE) bundled, human observer only.

## Plant/controller constraints
Reuse V1 VirtualPlant and VisualController. Plant diagnostics hidden from worker; ONLY frame `{width,height,pixels}` + previous `applied` is used for learning. Worker may have stateless `inspect` to locate markers WITHOUT choosing/counting action or changing model. Expose `VisualController.inspect(frame)` from locateMarkers.
Existing plant diagnostics geometry: lengths:[L1,L2], jointAngles:[q1,q2], channelToJoint:[0,1] or [1,0], channelGains:[g0,g1], camera:{angle,scale,x,y,fit}; tip,target are camera-projected. No controller accesses diagnostics or THREE scene. 3D view must be labeled human observation view, camera frame labeled controller input. Device 2D planar kinematics represented by a 3D SCARA-style desktop mechanism, no physical dynamics or actual gripper/pickplace promised.

## Engine interface (global ExperimentEngine)
`new ExperimentEngine({seed:42})`; `await initialize()` returns initial state; `await next()` advances ONE pedagogic step, not entire episode; `await reset(seed=42)` fresh whole experiment; `dispose()`.
Engine uses Worker from #controller-source script + wrapper. Separate actual sense->decide->act->verify into understandable events. Recommended alternation: decision (observe/update and propose next action) -> action result (apply stored proposal, image-only inspect after, show before/after and prediction residual). next decision feeds previous applied ack. Initial intro first, first inspect/decision next.
Phases/macro stages: intro, probe, model, reach, change, recover, complete. Each returned state is serializable except ImageData arrays, no functions. It contains:
`{seed,stage,title,explanation,nextLabel,done,busy?,eventIndex,actionCount,probeCount,recalibrations,observation:{tip,target,error}|null,command:[u0,u1]|null,predicted:[x,y]|null,residual:number|null,jacobian:[[...],[...]]|null,frame:{width,height,pixels},beforeFrame:frame|null,beforeTip:[x,y]|null,afterTip:[x,y]|null,diagnostics,events:[event...],checkpoints:{firstReach:null|{error,actions},changed:boolean,mismatchSeen:boolean,recovered:null|{error,actions}},failure:null|string}`.
State fields command/predicted correspond to presented event; action result has beforeFrame + after frame and endpoints; decision has currentframe and proposedcommand. Title/explanation TraditionalChinese derived from actual measurements/control reason. Provide minimal algorithm interpretation not fictional LLM reasoning. stage=model is an explicit checkpoint once matrix first known; don't silently skip it.
After first goal verified reached, next step announces planned challenge (stage=change, before physical change). Next step newTarget+perturbMotor reverses a channel; retain learned controller mapping via setGoal, do not pass change signal. Ensure exercise produces detectable predictive mismatch under default seed; verify data, don't fabricate. Continue decision/act cycle using stale model; model mismatch triggers actual re-probing in same algorithm. complete only after actual recovery reach; fail if budget/markers not met. Do not finish merely on timer. fixed scenario order okay, trajectories/actions must be computed online.
`snapshot()` returns current state. `report()` returns version, scope, parameters, event trace with observed/commanded/predicted/ack fields, checkpoints and evaluator truth; avoid embedding huge pixel arrays in JSON. For review history: `review(index)` returns stored state with matching frame/diagnostics (bounded whole experiment max400steps~several hundredMB concern; store png dataURL or reducedwidth image; choose approach communicate); can root own snapshot history instead if engine keeps event history with per-step frame references memory bounded at180actions/frame640480 ~450MB. Prefer engine stores PNG dataURL snapshots each step and root renders via image; currentstate stillRGBA. Contract for history can be adjusted ASAP.

## 3D scene interface
global `DeviceScene`; `new DeviceScene(canvas)`; `.update(diagnostics,{predicted?,beforeTip?,afterTip?,command?,stage?})`; `.render()`; `.resize()`; `.dispose()`.
Planar arm rotates horizontally above a designed tabletop, 3D thickness/bolts/motor covers, base, target ring/marker. Interpret world plane as x,z with y vertical. Invert camera transform for target/prediction solely human display. Use separate visible actual tip and predicted ghost/arrow (avoid false physical groundtruth control). Warm neutral tabletop/darkslate equipment with mint/coral target. Automatic fixed isometric camera gives context; optional drag orbit/zoom via pointer controls written locally no external OrbitControls needed. Scene must gracefully report WebGL unsupported so camera remains usable. Root will call update after every step; smooth animation optional but must respect requested step and not run scripted control. Human view can show live postaction diagnostics while evidence panels explicitly before/after.

## UI shell contract IDs
Use placeholders `/*__STYLES__*/`, `/*__THREE__*/`, `/*__PLANT__*/`, `/*__CONTROLLER__*/`, `/*__ENGINE__*/`, `/*__SCENE__*/`, `/*__APP__*/` exactly once. #controller-source type=text/plain inert script. All others normal scripts exceptCSS.
Required:
- canvas #scene-3d width900 height540; canvas #camera-before width640 height480; canvas #camera-after width640 height480. Camera labels #before-label #after-label.
- #scene-fallback hidden by default, can show explanation on WebGL failure.
- #next-btn primary, #play-btn auto/pause, #restart-btn, #seed-input value42; #speed-select values1600,700,0(default1600); #export-btn.
- #back-btn #forward-btn for recorded-step REVIEW only, #live-btn returns latest; input range #history-slider; #history-label. Reviewing NEVER changes plant/agent or executes command, disablesnext/playuntilreturnlive; root owns navigation from engine snapshots or stored view states.
- #stage-list contains7 items data-stage=intro,probe,model,reach,change,recover,complete; current/completed style based class.
- #step-number #step-title #step-explanation #next-hint #status-label #mode-label.
- #error-value #action-value #probe-value #residual-value.
- #command-a #command-b #prediction-text #observation-text.
- #knowledge-a #knowledge-b #knowledge-state #matrix-value (pre in details technicalexpandable).
- #first-result #change-result #recovery-result.
- #event-list (ol), #scope-note.
Prominent description of purpose: watch an unfamiliar device learn, then change motor mapping and watch it recover. A concise first-time how-to three steps, distinguish3Dhumanview vsactualcameraevidence. Explain two numericchannelsknown but directionsgeometryunknown. Label non-LLM algorithm experiment plainly, not fake agent chat. Responsive390px. Clear display hierarchy ~1440desktop; not dense engineering dashboard. Visibly different and more instructive thanV1. No externalassets. Root app writes all dynamictext.
