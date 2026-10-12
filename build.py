"""Build V7.0: a standalone paged pick-and-place lab with embedded source."""
from pathlib import Path
import base64,io,re,zipfile

ROOT=Path(__file__).resolve().parent
# Only project source and documentation belong in the downloadable source ZIP.
# In particular, initializing a Git repository must not embed its metadata or keys.
ROOT_FILES={'README.md','AGENTS.md','.gitignore','.env.example','build.py',
 'claude_bridge.py','gemini_bridge.py','start-lab.cmd','start-gemini.cmd'}
SOURCE_DIRS={'src','docs','tests','validation','vendor','_research'}
SOURCE_SUFFIXES={'.js','.cjs','.mjs','.css','.html','.py','.md','.json','.txt','.toml','.yaml','.yml','.cmd'}

def source_files():
    for file in sorted(ROOT.rglob('*')):
        if not file.is_file() or file.is_symlink():continue
        rel=file.relative_to(ROOT)
        if len(rel.parts)==1:
            if rel.name in ROOT_FILES:yield file
            continue
        if rel.parts[0] not in SOURCE_DIRS:continue
        if any(part.startswith('.') or part in {'__pycache__','node_modules'} for part in rel.parts):continue
        if file.suffix.lower() not in SOURCE_SUFFIXES:continue
        if file.stem.lower() in {'credentials','secrets','token','tokens','api-key','api_key'}:continue
        if rel.parts[0]=='validation' and file.suffix not in ('.json','.md'):continue
        yield file

entries={'STYLES':'src/styles.css','THREE':'vendor/three.min.js','PLANT':'src/plant.js',
 'CONTROLLER':'src/controller.js','AGENT':'src/agent-core.js',
 'CLAUDE_PROVIDER':'src/claude-provider.js','GEMINI_PROVIDER':'src/gemini-provider.js','PROTOCOLS':'src/protocols.js','DEVICE_LINK':'src/device-link.js',
 'DRIVER_RUNTIME':'src/driver-runtime.js','DRIVER_SYNTH':'src/driver-synthesizer.js','CONTROLLER_MODULE':'src/controller-module.js','ENGINE':'src/engine.js','ONBOARDING':'src/onboarding.js','PICK_PLACE':'src/pick-place.js',
 'SCENE':'src/scene3d.js','BENCHMARK':'src/benchmark.js','APP':'src/app.js'}
html=(ROOT/'src/index.template.html').read_text(encoding='utf-8')
for key,name in entries.items():
    token='/*__'+key+'__*/'
    if html.count(token)!=1:raise ValueError(f'Expected one {token}')
    source=(ROOT/name).read_text(encoding='utf-8')
    if key!='STYLES':source=re.sub(r'</script',lambda m:'<\\/script',source,flags=re.I)
    html=html.replace(token,source)
buffer=io.BytesIO()
with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:
    for file in source_files():
        rel=file.relative_to(ROOT)
        z.write(file,Path('virtual-device-v7.0')/rel)
source=base64.b64encode(buffer.getvalue()).decode('ascii')
html=html.replace('</body>',f'<script id="source-archive" type="application/octet-stream">{source}</script>\n</body>')
out=ROOT/'unknown-device-v7.0.html';out.write_text(html,encoding='utf-8')
print(f'{out} ({out.stat().st_size} bytes)')
