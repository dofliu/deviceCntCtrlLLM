# V5 contract

User authorizes ANTHROPIC_API_KEY (Machine exists, /models HTTP200). Root alone owns live calls. No real hardware. Build virtual-device-v5, preserve V4. Traditional Chinese interface. Complete actual stateful tabletop pick/place, not scripted object animation.

## Ownership
- plant_driver: src/plant.js, device-link.js, driver-runtime.js and its tests
- mission: src/pick-place.js, src/onboarding.js, src/engine.js as needed, its tests
- ui: app.js, index.template.html, styles.css, scene3d.js and its tests
- claude: claude-provider.js, claude_bridge.py, docs/claude.md and provider tests
- root: build.py, README, integration/live harness, saving

## Mechanics and generated driver
Keep XY array [a,b] and existing step wire/ACK backward compatible.
New commands {op:'lift',position:'up'|'down'}, {op:'grip',state:'open'|'closed'}.
plant.operate(command) mutates actual simulation. Runtime.operate(command,link) uses same tested generated encode/decode; strict host validation. Generic encode accepts XY array OR mechanical object. decode old step returns {applied:[a,b],limited:boolean}; auxiliary ACK decode contract plant_driver owns, share promptly with mission. No ACK includes hidden attached/success. Manual contains exact contract plus real generic JS sample. Dry runs cannot move or change gripper/object.
Default lift up/grip open. Object orange #ffad35; destination blue #4977ef. Only low+closed+near object can attach. Heldobject follows actual tip; open releases at actual currentposition. Object tablefootprint/heldheight visual representation agreed by plant/mission. No hardcoded completion. xy control default tolerance7px; pickup radius compatible but narrow. Plant diagnostics.pickPlace humanonly:
{object:[worldX,worldY],destination:[worldX,worldY],lift:'up'|'down',gripper:'open'|'closed',held:boolean,objectHeight:number,...}; preserve diagnostics geometry/tip etc. UI and plant_agent coordinate exact names immediately.

## Mission and interface
Global PickPlaceExperimentEngine with V4 FullExperimentEngine-compatible API. Full front8tools remains, new overridable controlfactory for mission. Onboarding starts sameplant+link+runtime+camera, then mission gets numericactuator and mechanicalactuator. No extra plant truth to provider.
Mission alternates phase:'mission' task tools and phase:'control' existing numerical tools. On select_goal, existing AutonomousEngine navigates using camera then returns control to mission; retain learned mapping. Overall done only after verify_place succeeds. No motorflip default for V5 pickplace.
Mission tool schema:
- inspect_scene {}
- select_goal {target:'object'|'destination'|'clearance'}
- lift {position:'up'|'down'}
- grip {state:'open'|'closed'}
- verify_grasp {}
- verify_place {}
- stop {}
phase:'mission' context contains allowedTools, observed {tip:[x,y],object:[x,y],destination:[x,y],...image-derived only}, actuator {lift,gripper} from ACKs, taskProgress, lastResult, budgets. Mission agent defines final explicit context and sends provider agent before implementation. No seed/groundtruth/hiddenheld. All invalid prerequisites rejected.
Workflow: inspect, targetobject, visualcalibrate+reach, lower, close, lift, verifygrasp, targetdestination, transport+reach, lower, open, lift, targetclearance, verifyplace. Clearance computed from observed A/B only, 28px toward A from B. Verifygrasp MUST use image change/co-motion evidence (liftimage and latertransport or smallboundedcommand), not only acknowledgedclosed. Finalverification requires actual orangeobject within blueB + raisedopen endeffector visiblyaway. Bounded retries/failure, no fake success or silent Claude->offlinefallback. If verification's direct probe causes motion, countit and refreshcamera.
State.taskProgress minimum {phase:string,objectDetected:boolean,atObject:boolean,graspVerified:boolean,atDestination:boolean,released:boolean,completed:boolean,attempts:number,placementError:number|null}; may add useful fields/label/checks. state.observation for numerical camera stays tip/target/error; missionObserved separate. All history/review/export preserves phases, actualmotion count and camera. ControlactionCount includes XY + auxiliary counts; also expose xyActionCount and auxiliaryActionCount where practical. Keep source/usage/modelcall provenance.

## UI
One viewport desktop app, tabs Overview/Connection evidence/Driver/Experiment log/Settings. Body no long scroll. Main3Dscene, compact rawcamera and agentdecision alwaysaccessible; detailedcode/log may internal scroll. Default auto continuous, optional checkboxpauseonmilestones; single-step/replay remain. Task chips distinct onb vslearning vsgrasp vsplace. Sources/driver/report downloads. No stale V4 targetonly success language. Mobile tabs responsive; allow detailinner scroll where physicallynecessary. Window.experimentLab ready/state/report etc retained. Defaultoffline, Claude explicit.

## Claude
Bridge defaultkey ANT HROPIC name withoutspace: ANTHROPIC_API_KEY; explicit --key-env canselect previouslyauthorized ANTHROPIC_API_KEY_Extra only, no secretfallback. 127.0.0.1:8766, V5HTML. Root actual /models returned claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 etc. Model selection fromactualaccount. Root plans claude-haiku-5-5 live test first, actual tools/code generation no mocks. Keep budgets80 maxCalls unless root changes reasonable boundedretry;45srequesttimeout. Privilegedfacts onlyhumanreport evaluator.

## Evidence
Offline fullpick/place fromseed42 &1, failurewrongpickup/wrongrelease no falseverify, viewport1440x900/1366x768/390x844 no pageoverflow, actualgenerateddriver used allactuation, no secrets inreport/source. Root actualClaude report separately labeled. Simplified 2RXY plus knownlift/grip, not full6DOF/contactphysics/automatic arbitraryfirmwarecreation.
