"""Execute candidate gates against synthetic inputs; not Rust or hosted-runner proof."""
import json, os, shutil, subprocess, tempfile
from pathlib import Path
import yaml

root=Path(__file__).resolve().parents[2]
jobs=yaml.safe_load((root/'.github/workflows/ci.yml').read_text())['jobs']
native=jobs['rust-macos-tests']
steps=native['steps']
assert native['name']=='rust tests (macos-latest aggregate)' and native['runs-on']=='macos-latest'
assert native['timeout-minutes']==120 and native['if']=='always()'
assert native['needs']==['rust-shard-config','rust-macos-tooling']
assert all('cache@' not in str(s.get('uses','')) and 'artifact@' not in str(s.get('uses','')) for s in steps)
assert native['env']['CD_SHARD_COUNT']=='${{ needs.rust-shard-config.outputs.macos_count }}'
outcomes=['probe','prepared','preflight']+[f'shard{i}' for i in range(1,5)]
for k in outcomes:
    assert native['outputs'][k]=='${{ steps.'+k+'.outputs.receipt }}'
    st=next(x for x in steps if x.get('id')==k)
    assert st['run'].rstrip().endswith(f'echo "receipt=$GITHUB_SHA:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT:{k}" >> "$GITHUB_OUTPUT"')
    if k.startswith('shard'):
        assert st['timeout-minutes']==50 and 'continue-on-error' not in st
        assert st['if']=="${{ !cancelled() && steps.prepared.outcome == 'success' }}"
        assert st['run'].index('--assert-dir target')<st['run'].index('ci_run_platform_shard.sh')<st['run'].index('ci_macos_shard_receipt.sh')
assert 'ci_aggregate_shards.sh' in next(x['run'] for x in steps if x.get('name')=='aggregate all expected manifests')
for id,k in [('rust-macos-cache-probe','probe'),('rust-macos-cache-warmup','prepared'),('rust-macos','preflight'),('rust-macos-shard','shard')]:
    job=jobs[id]; gate=job['steps'][0]
    assert job['if']=='always()' and job['needs']==['rust-shard-config','rust-macos-tests']
    assert gate['env']['TOPOLOGY']=='${{ needs.rust-shard-config.result }}' and gate['env']['NATIVE']=='${{ needs.rust-macos-tests.result }}'
    if k!='shard':
        assert gate['env']['RECEIPT']=='${{ needs.rust-macos-tests.outputs.'+k+' }}' and gate['env']['EXPECTED_STEP']==k
    else:
        assert gate['env']['RECEIPT']=="${{ needs.rust-macos-tests.outputs[format('shard{0}', matrix.shard)] }}"
        assert job['strategy']['fail-fast'] is False and 'needs.rust-shard-config.outputs.macos_matrix' in job['strategy']['matrix']['shard']
def step(name): return next(s['run'] for s in steps if s.get('name')==name)
with tempfile.TemporaryDirectory() as tmp:
    work=Path(tmp)
    (work/'scripts').mkdir()
    for name in ('ci_shard_config','ci_shard_plan','ci_record_cache','ci_run_platform_shard','ci_run_shard','ci_aggregate_shards','ci_macos_shard_receipt'):
        shutil.copy(root/'scripts'/f'{name}.sh',work/'scripts')
    (work/'bin').mkdir()
    cargo=work/'bin/cargo'
    cargo.write_text("""#!/bin/sh
case "$1" in
metadata) cat "$FIXTURE_METADATA";;
test) echo 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out';;
*) exit 3;;
esac
""")
    cargo.chmod(0o755)
    (work/'metadata.json').write_text(json.dumps({'packages':[{'name':n,'targets':[{'kind':['bin'],'name':n,'test':True,'doctest':False}]} for n in ('a','b','c','d')]}))
    env={**os.environ,'PATH':str(work/'bin')+':'+os.environ['PATH'],'FIXTURE_METADATA':str(work/'metadata.json'),'CD_SHARD_COUNT':'4','CD_CACHE_STATE':'cold','CD_SHARD_HEARTBEAT_SECONDS':'0','GITHUB_SHA':'fixture','GITHUB_RUN_ID':'230','GITHUB_RUN_ATTEMPT':'1','GITHUB_OUTPUT':str(work/'output')}
    def run(command, success=True):
        r=subprocess.run(['bash','-eo','pipefail','-c',command],cwd=work,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        if (r.returncode==0)!=success: raise AssertionError((command,r.returncode,r.stdout[-1500:]))
        return r.stdout
    run("git init -q && git -c user.name=fixture -c user.email=test@example.invalid commit -q --allow-empty -m fixture")
    out=work/'ci-platform-shards';out.mkdir()
    prepare=step('compile and validate runner-local exact checkout')
    run(prepare,False)
    assert not (out/'target-basis.json').exists()
    deps=work/'target/debug/deps';deps.mkdir(parents=True)
    (deps/'fixture.rlib').write_text('fixture')
    run(prepare,False)
    (deps/'libduckdb.a').write_text('fixture')
    run(prepare)
    basis=out/'target-basis.json'
    assert json.loads(basis.read_text())['initial_cache_state']=='cold'
    correct=basis.read_text()
    basis.write_text(correct.replace('runner-local-after-no-run','wrong'))
    run(step('run macOS shard 1'),False)
    basis.write_text(correct.replace(json.loads(correct)['head'],'wrong'))
    run(step('run macOS shard 1'),False)
    basis.write_text(correct)
    (deps/'libduckdb.a').write_text('')
    run(step('run macOS shard 1'),False)
    (deps/'libduckdb.a').write_text('fixture')
    for i in range(1,5): run(step(f'run macOS shard {i}'))
    agg=step('aggregate all expected manifests')
    run(agg)
    fourth=out/'shard-4/status.json'; receipt=fourth.read_text()
    fourth.unlink(); run(agg,False)
    data=json.loads(receipt);data['status']='timeout';fourth.write_text(json.dumps(data));run(agg,False)
    data=json.loads(receipt);data['units']=json.loads((out/'shard-1/status.json').read_text())['units'];fourth.write_text(json.dumps(data));run(agg,False)
    fourth.write_text(receipt);run(agg)
    # Real alias gate: sibling failures may preserve an independently successful
    # shard, but no absent, cancelled, wrong-identity or stale-attempt receipt passes.
    alias=jobs['rust-macos-shard']['steps'][0]['run']
    env.update(NATIVE='success',TOPOLOGY='success',EXPECTED_STEP='shard2',RECEIPT='fixture:230:1:shard2')
    run(alias)
    for field,value in [('NATIVE','cancelled'),('TOPOLOGY','skipped'),('RECEIPT',''),('RECEIPT','fixture:230:0:shard2'),('RECEIPT','fixture:230:1:shard1'),('RECEIPT','other:230:1:shard2')]:
        old=env[field];env[field]=value;run(alias,False);env[field]=old
    for field,value in [('status','incomplete'),('units_finished',0),('tests_failed',1),('os','windows'),('units',['wrong'])]:
        data=json.loads(receipt);data[field]=value;fourth.write_text(json.dumps(data))
        run('sh scripts/ci_macos_shard_receipt.sh 4 4 ci-platform-shards',False)
    fourth.write_text(receipt)
    manifest=out/'shard-4/manifest.json';manifest.unlink()
    run('sh scripts/ci_macos_shard_receipt.sh 4 4 ci-platform-shards',False)
    print('PASS synthetic CI: cold/absent DuckDB, swapped proof basis, changed HEAD and lost target refused; four distinct real shell-runner manifests accepted; missing, timed-out and overlapping shards refused.')
