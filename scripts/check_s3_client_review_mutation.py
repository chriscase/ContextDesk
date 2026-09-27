#!/usr/bin/env python3
"""Reversibly remove keyed-form layout revocation; synthetic, task-owned worktree only."""
import hashlib,json,subprocess,sys,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=root/'collab/web/src/investigations/strategies/shared/evidence-upload-reconciliation.ts'
test='src/investigations/strategies/shared/EvidenceUploadReconciliationForm.lifecycle.test.tsx'
def run(output):
 command=['npm','exec','-w','@cd-collab/web','--','vitest','run',test,'-t','replacement layout before passive cleanup|blocks obsolete form action','--reporter=json','--outputFile='+str(output)]
 result=subprocess.run(command,cwd=root/'collab',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60)
 data=json.loads(output.read_text())
 failures=[{'test':t['fullName'],'reason':t['failureMessages'][0].split('\n')[0][:500]} for s in data['testResults'] for t in s['assertionResults'] if t['status']=='failed']
 return {'command':[('--outputFile=<temporary-json>' if a.startswith('--outputFile=') else a) for a in command],'exit':result.returncode,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'skipped':data['numPendingTests'],'failures':failures}
original=source.read_bytes();text=original.decode();assert text.count('useLayoutEffect')==2
with tempfile.TemporaryDirectory(prefix='cd-s3-client-review-') as directory:
 try:
  source.write_text(text.replace('useLayoutEffect','useEffect'))
  negative=run(Path(directory)/'negative.json')
 finally:source.write_bytes(original)
 restored=run(Path(directory)/'restored.json')
 assert source.read_bytes()==original
 assert negative['exit']!=0 and negative['failed']==30 and restored['exit']==0 and restored['passed']==30
 receipt={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'source':str(source.relative_to(root)),'original_sha256':hashlib.sha256(original).hexdigest(),'mutation':'replace layout cleanup with passive cleanup','negative':negative,'restored':restored}
 destination=Path(sys.argv[1]) if len(sys.argv)>1 else Path(directory)/'receipt.json'
 destination.write_text(json.dumps(receipt,indent=2)+'\n')
 print('layout-revocation mutation: 30 intended failures; restored: 30 passed; exact source bytes restored')
