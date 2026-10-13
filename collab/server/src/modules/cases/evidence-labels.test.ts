import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID, parseArtifactAnnotationBulkResult, projectEvidenceLabels, type ArtifactAnnotationBulkRequestV1 } from "@cd-collab/contracts";
import { createSqliteRuntime } from "../../db/sqlite.js";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, PgAuditStore, type AuditStore } from "../audit/index.js";
import { CatalogService, MemoryCatalogStore, PgCatalogStore, type CatalogStore } from "../catalog/index.js";
import { CaseService } from "./service.js";
import { MemoryCaseStore, PgCaseStore, type CaseStore } from "./store.js";

const actor = {id:"local:lead", username:"lead"};
async function fixture(backend: string, fn: (ctx: {cases:CaseService; store:CaseStore; audit:AuditStore; database:Pool|null; reopen:()=>CaseService})=>Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cd-labels-"));
  const evidence = new FilesystemEvidenceStore({rootDir:join(root,"evidence")});
  async function run(url?: string) {
    const pool = url ? new Pool({connectionString:url,max:4}) : null;
    let sqlite = backend === "sqlite" ? createSqliteRuntime(join(root,"state.sqlite")) : null;
    let store:CaseStore = pool ? new PgCaseStore(pool) : sqlite?.cases ?? new MemoryCaseStore();
    let audit:AuditStore = pool ? new PgAuditStore(pool) : sqlite?.audit ?? new MemoryAuditStore();
    let catalog:CatalogStore = pool ? new PgCatalogStore(pool) : sqlite?.catalog ?? new MemoryCatalogStore();
    const make = () => new CaseService(evidence,audit,store,new CatalogService(catalog,audit));
    try { await fn({cases:make(),store,audit,database:pool,reopen:()=>{
      if(sqlite) {sqlite.state.close();sqlite=createSqliteRuntime(join(root,"state.sqlite"));store=sqlite.cases;audit=sqlite.audit;catalog=sqlite.catalog;}
      else if(pool) store=new PgCaseStore(pool);
      return make();
    }}); } finally {sqlite?.state.close();await pool?.end();}
  }
  try {
    if(backend === "postgres") await withDisposableDb(async(client,url)=>{await migrateUp(client);await run(url);});
    else await run();
  } finally {await rm(root,{recursive:true,force:true});}
}
function request(ids:string[], label:string, operation:"add"|"remove", key=randomUUID(), privacyClass:"share_safe"|"owner_only"="share_safe"):ArtifactAnnotationBulkRequestV1 {
  return {schemaId:ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,artifactIds:ids,labelMutation:{label,operation},body:`${operation}: ${label}`,privacyClass,idempotencyKey:key};
}
for(const backend of ["memory","sqlite","postgres"]) describe.skipIf(backend === "postgres" && !adminUrl())(`${backend} structured evidence labels`,()=>{
  it("serializes concurrent intents, preserves bytes/identity, projects ordered append-only history and reloads",async()=>fixture(backend,async({cases,store,reopen,database})=>{
    const c=await cases.createCase(actor,{title:"Synthetic label review"},"test");
    const a=(await cases.addEvidence(c.id,actor,{kind:"attachment",filename:"a.txt",bytes:new TextEncoder().encode("synthetic A"),summary:"A",privacyClass:"share_safe"},"test")).artifact;
    const b=(await cases.addEvidence(c.id,actor,{kind:"log",filename:"b.log",bytes:new TextEncoder().encode("synthetic B"),summary:"B",privacyClass:"owner_only"},"test")).artifact;
    const before=await store.listArtifactsByCase(c.id);
    const bytesBefore=await Promise.all([a.id,b.id].map(id=>cases.getArtifactBytes(c.id,id,actor,true,true,1024)));
    const ids=[a.id,b.id,randomUUID()];const input=request(ids,"Reviewed","add");
    const results=await Promise.all([cases.addArtifactAnnotationsBulk(c.id,actor,input,"test",true),cases.addArtifactAnnotationsBulk(c.id,actor,{...input,artifactIds:[...ids].reverse(),labelMutation:{operation:"add",label:"Reviewed"}},"test",true)]);
    results.forEach(parseArtifactAnnotationBulkResult);
    expect(results.flatMap(row=>row.items.map(item=>item.outcome)).sort()).toEqual(["applied","applied","not_found","not_found","replayed","replayed"]);
    const first=await cases.listArtifactAnnotations(c.id,actor,true,undefined,true);
    expect(first).toHaveLength(2);expect(new Set(first.map(row=>JSON.stringify([row.artifactId,row.privacyClass,row.labelEvent?.sequence]))).size).toBe(2);
    expect((await cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id,b.id],"Reviewed","add"),"test",true)).items.map(row=>row.outcome)).toEqual(["already_desired","already_desired"]);
    expect(await cases.listArtifactAnnotations(c.id,actor,true,undefined,true)).toEqual(first);
    await expect(cases.addArtifactAnnotationsBulk(c.id,actor,{...input,labelMutation:{label:"reviewed",operation:"add"},body:"add: reviewed"},"test",true)).rejects.toThrow(/conflict/);
    await cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id],"reviewed","add"),"test",true);
    await cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id,b.id],"Reviewed","remove"),"test",true);
    expect(projectEvidenceLabels(await cases.listArtifactAnnotations(c.id,actor,true,undefined,true))).toEqual([{artifactId:a.id,label:"reviewed"}]);
    const previousSequence=Math.max(...(await cases.listArtifactAnnotations(c.id,actor,true,undefined,true)).filter(row=>row.artifactId===a.id && row.privacyClass==="share_safe").map(row=>row.labelEvent?.sequence ?? 0));
    const competing=await Promise.all([cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id],"Competing","add"),"test",true),cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id],"Competing","remove"),"test",true)]);
    expect(competing[0]?.items[0]?.outcome).toBe("applied");
    const removeOutcome=competing[1]?.items[0]?.outcome;expect(["applied","already_desired"]).toContain(removeOutcome);
    const history=await cases.listArtifactAnnotations(c.id,actor,true,undefined,true);
    const ordered=history.filter(row=>row.labelEvent?.label==="Competing").sort((x,y)=>x.labelEvent!.sequence-y.labelEvent!.sequence);
    // Promise invocation order is not PostgreSQL lock-acquisition order. Both
    // serializations are valid, but outcomes, durable order and projection must agree.
    expect(ordered.map(row=>row.labelEvent?.operation)).toEqual(removeOutcome==="applied" ? ["add","remove"] : ["add"]);
    expect(ordered.map(row=>row.labelEvent?.sequence)).toEqual(ordered.map((_,index)=>previousSequence+index+1));
    const expectedCurrent=removeOutcome==="applied" ? [{artifactId:a.id,label:"reviewed"}] : [{artifactId:a.id,label:"Competing"},{artifactId:a.id,label:"reviewed"}];
    expect(history.filter(row=>row.labelEvent?.label === "Reviewed").map(row=>row.labelEvent?.operation).sort()).toEqual(["add","add","remove","remove"]);
    expect(projectEvidenceLabels(history)).toEqual(expectedCurrent);
    expect(await store.listArtifactsByCase(c.id)).toEqual(before);
    const restored=reopen();expect(await restored.listArtifactAnnotations(c.id,actor,true,undefined,true)).toEqual(history);
    expect(projectEvidenceLabels(await restored.listArtifactAnnotations(c.id,actor,true,undefined,true))).toEqual(expectedCurrent);
    expect(await Promise.all([a.id,b.id].map(id=>restored.getArtifactBytes(c.id,id,actor,true,true,1024)))).toEqual(bytesBefore);
    if(database) {
      const stored=await database.query("SELECT * FROM artifact_annotations WHERE artifact_id=$1 LIMIT 1",[a.id]);const row=stored.rows[0];
      for(const patch of [{operation:null},{intentKey:null},{extra:true},{label:"bad"+String.fromCharCode(0x202e)},{sequence:25001}]) {
        await expect(database.query("INSERT INTO artifact_annotations(id,case_id,artifact_id,body,content_hash,privacy_class,author_id,author_username,created_at,source_id,label_event) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[randomUUID(),row.case_id,row.artifact_id,row.body,row.content_hash,row.privacy_class,row.author_id,row.author_username,row.created_at,row.source_id,JSON.stringify({...row.label_event,sequence:200,...patch})])).rejects.toThrow(/artifact_label_event_checked/);
      }
      await expect(database.query("UPDATE artifact_annotations SET body=body WHERE id=$1",[row.id])).rejects.toThrow(/insert-only/);
      await expect(database.query("DELETE FROM artifact_annotations WHERE id=$1",[row.id])).rejects.toThrow(/insert-only/);
    }
    expect(await restored.listArtifacts(c.id,actor,true)).toEqual([a,b].sort((x,y)=>x.id.localeCompare(y.id)));
  }));
  it("filters hidden history and replay after private-read revocation without an existence oracle",async()=>fixture(backend,async({cases})=>{
    const c=await cases.createCase(actor,{title:"Privacy fixture"},"test");
    const a=(await cases.addEvidence(c.id,actor,{kind:"attachment",filename:"visible.txt",bytes:new Uint8Array([1]),summary:"Visible",privacyClass:"share_safe"},"test")).artifact;
    const b=(await cases.addEvidence(c.id,actor,{kind:"attachment",filename:"private.txt",bytes:new Uint8Array([2]),summary:"Private",privacyClass:"owner_only"},"test")).artifact;
    const privateIntent=request([a.id],"Private meaning","add",randomUUID(),"owner_only");
    await cases.addArtifactAnnotationsBulk(c.id,actor,privateIntent,"test",true);
    expect(await cases.listArtifactAnnotations(c.id,actor,true,undefined,false)).toEqual([]);
    expect((await cases.listTimeline(c.id,false)).filter(row=>row.kind === "artifact_label_changed")).toEqual([]);
    await expect(cases.addArtifactAnnotationsBulk(c.id,actor,privateIntent,"test",false)).rejects.toThrow(/authority/);
    const shareIntent=request([b.id],"Safe meaning","add");await cases.addArtifactAnnotationsBulk(c.id,actor,shareIntent,"test",true);
    expect((await cases.addArtifactAnnotationsBulk(c.id,actor,shareIntent,"test",false)).items).toEqual([{artifactId:b.id,outcome:"not_found"}]);
    expect((await cases.addArtifactAnnotationsBulk(c.id,actor,request([b.id,randomUUID()],"X","remove"),"test",false)).items.every(row=>row.outcome === "not_found")).toBe(true);
    expect(await cases.listArtifactAnnotations(c.id,actor,true,undefined,false)).toEqual([]);
    expect((await cases.listTimeline(c.id,false)).filter(row=>row.kind === "artifact_label_changed")).toEqual([]);
  }));
  it("rolls back label events, parent intent, timeline and audit as one transaction",async()=>fixture(backend,async({cases,store,audit,reopen})=>{
    const c=await cases.createCase(actor,{title:"Rollback fixture"},"test");
    const a=(await cases.addEvidence(c.id,actor,{kind:"attachment",filename:"x.txt",bytes:new Uint8Array([1]),summary:"X",privacyClass:"share_safe"},"test")).artifact;
    const input=request([a.id],"Rollback","add");const original=audit.append.bind(audit);
    const spy=vi.spyOn(audit,"append").mockImplementation(async row=>{if(row.action === "artifact_annotation_bulk_create") throw new Error("synthetic audit failure");return original(row);});
    await expect(cases.addArtifactAnnotationsBulk(c.id,actor,input,"test",true)).rejects.toThrow(/synthetic audit/);spy.mockRestore();
    expect(await store.listArtifactAnnotationsByCase(c.id)).toEqual([]);
    expect(await store.getArtifactAnnotationBulkIdempotency(c.id,actor.id,input.idempotencyKey)).toBeNull();
    expect((await store.listTimeline(c.id)).filter(row=>row.kind === "artifact_label_changed")).toEqual([]);
    expect(await reopen().listArtifactAnnotations(c.id,actor,true,undefined,true)).toEqual([]);
  }));
});

it("keeps public mutation capacity independent of a full protected history allocation",async()=>fixture("memory",async({cases,store})=>{
 const c=await cases.createCase(actor,{title:"Capacity isolation"},"test");
 const a=(await cases.addEvidence(c.id,actor,{kind:"attachment",filename:"public.txt",bytes:new Uint8Array([1]),summary:"Public",privacyClass:"share_safe"},"test")).artifact;
 await cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id],"Private meaning","add",randomUUID(),"owner_only"),"test",true);
 const memory=store as MemoryCaseStore;const snapshot=memory.capture() as {artifactAnnotations:[string,Record<string,unknown>][]};const template=snapshot.artifactAnnotations[0]![1];
 snapshot.artifactAnnotations=Array.from({length:25000},(_,index)=>{const id=randomUUID();return [id,{...template,id,labelEvent:{label:"Private meaning",operation:"add",sequence:index+1,intentKey:"capacity-private-0001"}}];});memory.restore(snapshot);
 const result=await cases.addArtifactAnnotationsBulk(c.id,actor,request([a.id],"Public meaning","add"),"test",false);
 expect(result.items[0]?.outcome).toBe("applied");
 const visible=await cases.listArtifactAnnotations(c.id,actor,true,undefined,false);
 expect(visible).toHaveLength(1);expect(visible[0]?.labelEvent?.sequence).toBe(1);expect(projectEvidenceLabels(visible)).toEqual([{artifactId:a.id,label:"Public meaning"}]);
}));
