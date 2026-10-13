import {describe,expect,it} from "vitest";
import {parseEvidenceLabel,parseEvidenceLabelEvent,projectEvidenceLabels} from "./evidence-labels.js";
import {parseArtifactAnnotationBulkRequest,parseArtifactAnnotationBulkResult,parseArtifactAnnotationList,ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,type ArtifactAnnotationV1} from "./artifact-annotation.js";
const id="11111111-1111-4111-8111-111111111111";
const event=(label:string,operation:"add"|"remove",sequence:number,privacyClass:"share_safe"|"owner_only"="share_safe"):ArtifactAnnotationV1=>({schemaId:"cd-collab.artifact_annotation.v1",id,caseId:id,artifactId:id,body:`${operation}: ${label}`,contentHash:"a".repeat(64),privacyClass,authorId:"alice",authorUsername:"alice",createdAt:"2026-10-01T00:00:00Z",sourceId:id,labelEvent:{label,operation,sequence,intentKey:"label-intent-0001"}});
describe("canonical exact evidence labels",()=>{
 it("accepts ordinary exact text and rejects whitespace, controls, bidi, unbounded and ambiguous operations",()=>{
  expect(parseEvidenceLabel("Reviewed")).toBe("Reviewed");expect(parseEvidenceLabel("reviewed")).toBe("reviewed");expect(parseEvidenceLabel("Ｃase")).toBe("Ｃase");
  for(const text of [""," "," A","A ","A\nB","A"+String.fromCharCode(0x202e),"x".repeat(121)]) expect(()=>parseEvidenceLabel(text)).toThrow();
  for(const patch of [{operation:"toggle"},{extra:true},{sequence:0},{sequence:25001},{sequence:1.5},{intentKey:"bad"}])expect(()=>parseEvidenceLabelEvent({...event("A","add",1).labelEvent,...patch})).toThrow();
 });
 it("collapses exact duplicates, preserves case variants and historical adds, and projects by durable sequence",()=>{
  const history=[event("A","remove",4),event("a","add",3),event("A","add",1),event("A","add",2)];
  expect(projectEvidenceLabels(history)).toEqual([{artifactId:id,label:"a"}]);expect(history.filter(row=>row.labelEvent?.operation === "add")).toHaveLength(3);
  expect(projectEvidenceLabels([...history,event("A","add",5,"owner_only")])).toEqual([{artifactId:id,label:"A"},{artifactId:id,label:"a"}]);
 });
 it("strictly binds intent, event and server projection envelopes",()=>{
  const request={schemaId:ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,artifactIds:[id],body:"add: A",privacyClass:"share_safe",idempotencyKey:"label-intent-0001",labelMutation:{label:"A",operation:"add"}};
  expect(parseArtifactAnnotationBulkRequest(request)).toEqual(request);
  for(const patch of [{artifactIds:[]},{artifactIds:Array(65).fill(id)},{body:"remove: A"},{privacyClass:undefined},{extra:true}])expect(()=>parseArtifactAnnotationBulkRequest({...request,...patch})).toThrow();
  const result={schemaId:ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,caseId:id,items:[{artifactId:id,outcome:"applied",annotation:event("A","add",1)}],labelMutation:request.labelMutation,privacyClass:"share_safe",idempotencyKey:request.idempotencyKey};
  expect(parseArtifactAnnotationBulkResult(result)).toEqual(result);
  expect(()=>parseArtifactAnnotationBulkResult({...result,labelMutation:{label:"B",operation:"add"}})).toThrow();
  expect(()=>parseArtifactAnnotationBulkResult({...result,idempotencyKey:"other-intent-0001"})).toThrow();
  const list={schemaId:ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,caseId:id,annotations:[event("A","add",1)],currentLabels:[{artifactId:id,label:"A"}]};
  expect(parseArtifactAnnotationList(list)).toEqual(list);expect(()=>parseArtifactAnnotationList({...list,currentLabels:[]})).toThrow();
 });
});
