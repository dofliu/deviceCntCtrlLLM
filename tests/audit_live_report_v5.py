"""Read-only audit of a completed live Claude run; does not call an API."""
from collections import Counter
from pathlib import Path
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]


def fnv_js(source):
    value = 2166136261
    raw = source.encode('utf-16-le')
    for i in range(0, len(raw), 2):
        value = ((value ^ int.from_bytes(raw[i:i+2], 'little')) * 16777619) & 0xffffffff
    return f'fnv1a-{value:08x}'


def audit(path):
    report = json.loads(path.read_text(encoding='utf-8'))
    trace = report['trace']
    decisions = [row['decision'] for row in trace if row.get('kind') == 'decision']
    live = report['liveValidation']
    onboarding = report['onboarding']
    source = onboarding.get('driverSource') or ''
    checks = {}
    checks['real_api_harness'] = live['realAPI'] is True and report['languageModel'] is True and report['strategy'] == 'claude'
    checks['all_decisions_from_claude'] = bool(decisions) and all(d.get('source') == 'claude' and d.get('model') == live['model'] for d in decisions)
    checks['decision_and_request_counts_match'] = len(decisions) == report['decisionCount'] == report['modelCalls'] == live['bridgeRequests']
    checks['claude_driver_provenance'] = onboarding.get('driverSourceOrigin') == 'claude-generated' and report['provenance']['driverSource'] == 'claude-generated'
    writes = [d for d in decisions if d['tool'] == 'write_driver']
    checks['executed_source_matches_claude_tool'] = bool(writes) and writes[-1]['args']['source'] == source
    source_hash = fnv_js(source)
    checks['source_hash_matches_compilation_and_tests'] = onboarding.get('compileResult', {}).get('sourceHash') == source_hash == onboarding.get('driverTests', {}).get('sourceHash')
    checks['driver_tests_passed'] = onboarding.get('driverTests', {}).get('passed') is True
    commands, replies = [], []
    pending = None
    pairs_correct = True
    for entry in onboarding['traffic']:
        if entry.get('dryRun'):
            continue
        if entry['direction'] not in ('TX', 'RX'):
            continue
        payload = json.loads(entry['wire'])
        if entry['direction'] == 'TX':
            pending = payload
            if payload.get('op') in ('step', 'lift', 'grip'):
                commands.append(payload)
        elif pending and pending.get('op') in ('step', 'lift', 'grip'):
            replies.append(payload)
            if payload.get('ok') is not True:
                pairs_correct = False
            elif pending['op'] == 'step':
                applied = payload.get('accepted')
                if not isinstance(applied, list) or len(applied) != 2:
                    pairs_correct = False
                elif not payload.get('limited') and applied != pending['channels']:
                    pairs_correct = False
            elif payload.get('accepted') != pending:
                pairs_correct = False
            pending = None
    counts = Counter(c['op'] for c in commands)
    checks['all_wire_commands_have_matching_ack'] = pairs_correct and len(commands) == len(replies)
    checks['all_action_counts_match_wire'] = len(commands) == report['actionCount'] == report['commandAttemptCount'] and counts['step'] == report['xyActionCount'] and counts['lift'] + counts['grip'] == report['auxiliaryActionCount'] and report['unconfirmedActuationCount'] == 0
    applied_aux = [r for r in trace if r.get('kind') == 'mission-result' and (r.get('decision') or {}).get('tool') in ('lift', 'grip') and (r.get('toolResult') or {}).get('ok')]
    checks['aux_ack_records_reference_same_driver'] = len(applied_aux) == report['auxiliaryActionCount'] and all(r['toolResult']['data'].get('sourceHash') == source_hash for r in applied_aux)
    motion_states = [r for r in trace if r.get('actionCount', 0) > 0]
    checks['driver_gate_precedes_all_actuation'] = bool(motion_states) and all(r.get('onboarding', {}).get('driverTests', {}).get('passed') is True for r in motion_states)
    checks['all_api_decisions_have_usage'] = all(d.get('usage', {}).get('input_tokens', 0) > 0 and d.get('usage', {}).get('output_tokens', 0) > 0 for d in decisions)
    usage = Counter()
    for d in decisions:
        usage.update(d.get('usage', {}))
    checks['usage_totals_match_decisions'] = dict(usage) == report['provenance']['usage']
    last = trace[-1]
    final = (last.get('toolResult') or {}).get('data') or {}
    checks['final_visual_verification_passed'] = last.get('kind') == 'pick-place-complete' and final.get('source') == 'new-camera-frame' and bool(final.get('checks')) and all(final['checks'].values())
    checks['completed_without_failure'] = report['done'] is True and report['failure'] is None and report['taskProgress']['completed'] is True
    truth = report['evaluatorTruth'][-1]['diagnostics']['pickPlace']
    checks['actual_physical_state_matches_completion'] = truth['placed'] is True and truth['held'] is False and truth['gripper'] == 'open' and truth['lift'] == 'up' and truth['graspCount'] >= 1 and truth['releaseCount'] >= 1
    checks['grasp_transport_release_evidence'] = all(report['missionEvidence'].get(k) for k in ('grasp', 'coMotion', 'release'))
    checks['browser_runtime_errors_absent'] = not live['pageErrors']
    checks['no_visible_secret_tokens'] = 'sk-ant-' not in path.read_text(encoding='utf-8')
    output = {
        'inputReport': path.name, 'model': live['model'],
        'reviewMode': 'Read-only report and source-path audit; no additional API call.',
        'passed': all(checks.values()), 'checks': checks,
        'metrics': {'apiRequests': live['bridgeRequests'], 'decisions': len(decisions),
                    'actions': len(commands), 'xy': counts['step'], 'lift': counts['lift'], 'grip': counts['grip'],
                    'usage': dict(usage), 'placementErrorPx': final.get('placementError'),
                    'releaseDriftPx': final.get('releaseDrift'), 'gripperSeparationPx': final.get('separation'),
                    'sourceHash': source_hash, 'sourceLength': len(source)},
        'limitation': 'One actual model run in simplified virtual mechanics. The report stores image-derived measurements, not raw camera frame pixels. The final screenshot is reviewed separately.'
    }
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('report', type=Path, nargs='?', default=ROOT / 'validation/live-claude-authorized.json')
    args = parser.parse_args()
    if not args.report.exists():
        raise SystemExit('Completed live report is not available yet; no API call performed.')
    result = audit(args.report)
    output = ROOT / 'validation/live-claude-independent-review.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True))
