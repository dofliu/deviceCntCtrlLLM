"""Explicit live Claude experiment using only the user-authorized named key.

Runs an actual local bridge, real Messages API tool calls and the built UI.
Never prints or persists credential values. This test incurs API usage.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import os
import threading
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--seed', type=int, default=42)
parser.add_argument('--max-calls', type=int, default=80)
parser.add_argument('--label', default='live-claude')
parser.add_argument('--html', type=Path, default=ROOT / 'unknown-device-v5.3.html')
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('vlab_bridge', ROOT / 'claude_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
key = bridge.read_authorized_key('ANTHROPIC_API_KEY')
if not key:
    raise SystemExit('Authorized ANTHROPIC_API_KEY is not available.')
server = bridge.BridgeServer(0, args.html.resolve(), key, args.max_calls, key_name='ANTHROPIC_API_KEY')
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
out = ROOT / 'validation'
out.mkdir(exist_ok=True)
started = time.time()
errors = []
blocked_browser_hosts = []
rows = []
report = None
# The browser needs only the loopback bridge. API traffic is performed by the
# bridge's fixed Anthropic endpoint; disable unrelated SDK/browser telemetry.
for name in ('POWERSHELL_TELEMETRY_OPTOUT', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'VSCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'):
    os.environ[name] = '1'
os.environ['OTEL_SDK_DISABLED'] = 'true'
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True, args=[
            '--enable-unsafe-swiftshader', '--disable-background-networking',
            '--disable-component-update', '--disable-sync', '--disable-domain-reliability',
            '--disable-breakpad', '--metrics-recording-only',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        def restrict_browser(route):
            url = urlsplit(route.request.url)
            if url.scheme in ('http', 'https') and (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port != server.server_port):
                blocked_browser_hosts.append(url.hostname)
                route.abort()
            else:
                route.continue_()
        page.context.route('**/*', restrict_browser)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(server.origin)
        page.wait_for_function('window.experimentLab?.ready', timeout=30000)
        page.evaluate('''async config => { await experimentLab.configure(config); return true; }''',
                      {'seed': args.seed, 'strategy': 'claude', 'model': args.model, 'bridgeUrl': server.origin})
        print(json.dumps({'event': 'started', 'model': args.model, 'seed': args.seed, 'keyName': 'ANTHROPIC_API_KEY', 'maxCalls': args.max_calls}), flush=True)
        for _ in range(400):
            row = page.evaluate('''async () => {
              await experimentLab.next();
              const s=experimentLab.state().current;
              return {eventIndex:s.eventIndex,kind:s.kind,tool:s.decision?.tool,
                args:s.decision?.tool==='write_driver'?{sourceLength:s.decision.args.source.length}:s.decision?.args,
                title:s.title,done:s.done,failure:s.failure,actions:s.actionCount,
                modelCalls:s.modelCalls,task:s.taskProgress,result:s.toolResult?.summary,
                reason:s.decision?.reason,error:s.observation?.error};
            }''')
            rows.append(row)
            (out / (args.label + '-progress.json')).write_text(json.dumps({'realAPI': True, 'model': args.model, 'steps': rows, 'completed': bool(row.get('task', {}).get('completed'))}, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({k: row.get(k) for k in ('eventIndex', 'kind', 'tool', 'done', 'failure', 'actions', 'modelCalls')} | {'phase': row.get('task', {}).get('phase')}, ensure_ascii=True), flush=True)
            if row['done']:
                break
        report = page.evaluate('experimentLab.report()')
        report['liveValidation'] = {'model': args.model, 'seed': args.seed,
            'realAPI': True, 'bridgeRequests': server.calls,
            'interface': 'core harness' if args.html.name != 'unknown-device-v5.3.html' else 'V5 dashboard',
            'durationSeconds': round(time.time() - started, 2), 'pageErrors': errors,
            'networkPolicy': 'Browser loopback-only, external DNS blocked; bridge fixed api.anthropic.com only',
            'blockedBrowserHosts': sorted(set(blocked_browser_hosts)),
            'credentialName': 'ANTHROPIC_API_KEY', 'scope': 'One actual Claude run in simplified virtual pick-and-place; no hardware.'}
        serialized = json.dumps(report, ensure_ascii=False, indent=2)
        if key in serialized:
            raise RuntimeError('Credential found in report; refusing to save.')
        (out / (args.label + '.json')).write_text(serialized, encoding='utf-8')
        page.screenshot(path=str(out / (args.label + '.png')))
        browser.close()
        print(json.dumps({'event': 'finished', 'done': report.get('done'), 'failure': report.get('failure'),
                          'taskProgress': report.get('taskProgress'), 'requests': server.calls,
                          'durationSeconds': report['liveValidation']['durationSeconds']}), flush=True)
finally:
    server.shutdown()
    server.server_close()
    server._api_key = ''
    key = ''
