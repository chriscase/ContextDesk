#!/usr/bin/env python3
"""Seven reversible mutations; run only in the owned idle disposable worktree.
Sources are restored byte-for-byte in finally. No mutant is committed.
"""
import hashlib, json, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
COLLAB=ROOT/'collab'
STORE=COLLAB/'server/src/evidence/s3-store.ts'
HOOK=COLLAB/'web/src/investigations/strategies/shared/evidence-upload-reconciliation.ts'

def replace_once(source, old, new):
    if source.count(old)!=1: raise RuntimeError('mutation anchor missing or ambiguous')
    return source.replace(old,new,1)

mutations=[
 ('unknown-as-ordinary', STORE, [('return err instanceof S3EvidenceError\n    && err.commitOutcomeUnknown\n    && CANONICAL_COMMIT_OPERATIONS.has(err.operation);','return false;')], 'server', 'src/modules/cases/evidence-stream.http.test.ts', 'maps JSON and multipart promote ambiguity'),
 ('sdk-copy-replay', STORE, [('requestHandler,\n    maxAttempts: 1,\n    retryStrategy: new ConfiguredRetryStrategy(1, 0),','requestHandler,\n    maxAttempts: 3,\n    retryStrategy: new ConfiguredRetryStrategy(3, 0),')], 'server','src/evidence/s3-copy-retry.test.ts','one wire attempt through opaque production adapter for rejected'),
 ('erase-uncertain-journal',STORE,[('if (journalId && !published && !ownershipUnknown) {','if (journalId && !published) {')],'server','src/evidence/s3-copy-retry.test.ts','durable reopened objects and SQLite references'),
 ('live-retry-intent',HOOK,[('source === "retry" ? active.intent! : Object.freeze({ ...next })','source === "retry" ? next : Object.freeze({ ...next })')],'web','src/investigations/strategies/shared/evidence-upload-reconciliation.test.tsx','freezes caller metadata'),
 ('stale-read-unlock',HOOK,[('latest.current.readCompletion.succeeded >= active.barrier','latest.current.readCompletion.succeeded >= 0')],'web','src/investigations/strategies/shared/evidence-upload-reconciliation.test.tsx','never unlocks from a pre-failure'),
 ('obsolete-scope-callback',HOOK,[('const isCurrent = () => active.live && current.current === active;','const isCurrent = () => true;')],'web','src/investigations/strategies/shared/evidence-upload-reconciliation.test.tsx','drops obsolete callbacks on B and A-B-A'),
 ('double-upload',HOOK,[('if (!allowed() || active.busy) return;','if (!allowed()) return;'),('if (source === "form" && active.intent !== null && active.phase !== "ordinary_failure") return;','// mutation permits a second form call while busy')],'web','src/investigations/strategies/shared/EvidenceUploadReconciliationForm.test.tsx','direct submits cannot bypass recovery'),
]

def run(package, test_file, pattern, output):
    command=['npm','exec','-w','@cd-collab/'+package,'--','vitest','run',test_file,'-t',pattern,'--reporter=json','--outputFile='+str(output)]
    result=subprocess.run(command,cwd=COLLAB,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60)
    data=json.loads(output.read_text())
    failed=[]
    for suite in data['testResults']:
      for item in suite['assertionResults']:
        if item['status']=='failed':
          failed.append({'test':item['fullName'],'reason':item['failureMessages'][0].split('\n')[0][:250]})
    return {'command':command,'exit':result.returncode,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'skipped':data['numPendingTests'],'failures':failed}

receipt={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'mutations':[]}
with tempfile.TemporaryDirectory(prefix='cd-s3-mutants-') as directory:
 for name,path,changes,package,test_file,pattern in mutations:
    original=path.read_bytes(); mutated=original.decode()
    for old,new in changes: mutated=replace_once(mutated,old,new)
    try:
      path.write_text(mutated)
      negative=run(package,test_file,pattern,Path(directory)/'negative.json')
    finally:
      path.write_bytes(original)
    positive=run(package,test_file,pattern,Path(directory)/'positive.json')
    if path.read_bytes()!=original: raise RuntimeError('source restoration failed')
    item={'name':name,'source':str(path.relative_to(ROOT)),'original_sha256':hashlib.sha256(original).hexdigest(),'negative':negative,'restored':positive}
    receipt['mutations'].append(item)
    print(name, 'negative=',negative['exit'],'failures=',negative['failed'],'restored=',positive['exit'],flush=True)
    if negative['exit']==0 or negative['failed']==0 or positive['exit']!=0: raise RuntimeError('mutation did not produce intended failure and restored pass')
 output=Path(directory)/'receipt.json'
 # Optional output is outside worktree by default; caller may publish sanitized receipt.
 import sys
 destination=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'docs/goals/S3_MUTATION_EVIDENCE.json'
 destination.write_text(json.dumps(receipt,indent=2)+'\n')
