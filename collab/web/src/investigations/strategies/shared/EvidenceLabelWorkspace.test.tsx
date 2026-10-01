import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from "@testing-library/react";
import {useLayoutEffect} from "react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {EvidenceAnnotationWorkspace,useLabelIntent,type EvidenceAnnotationWorkspaceProps} from "./EvidenceAnnotationWorkspace.js";
import {evidenceLabelModel} from "../../runtime/public.js";
afterEach(cleanup);
const unknown={status:"failed",error:{kind:"unavailable",reason:"commit_outcome_unknown"}};
function props(overrides:Partial<EvidenceAnnotationWorkspaceProps>={}):EvidenceAnnotationWorkspaceProps {
 return {labelModel:evidenceLabelModel,scopeKey:"A:alice:authority1",evidence:[{id:"a",filename:"a.log",uri:null},{id:"b",filename:"b.log",uri:null}],selectedArtifactIds:["a","b"],annotations:{availability:"available",value:[],refresh:"settled"},canAnnotate:true,canReadPrivate:true,readOnly:false,bulkCommand:vi.fn(async(_input:unknown)=>unknown),bulkMutation:{status:"idle"},bulkErrorCopy:null,onRefresh:vi.fn(async()=>{}),onClearSelection:vi.fn(),readCompletion:{requested:1,succeeded:1,failed:-1},...overrides};
}
describe("mounted structured label workspace",()=>{
 it("freezes exact explicit operation and targets across selection changes, and requires a causal successful read after every unknown",async()=>{
  const command=vi.fn(async(_input:unknown)=>unknown);let p=props({bulkCommand:command});const view=render(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.change(screen.getByLabelText("Exact label"),{target:{value:"  Reviewed  "}});fireEvent.click(screen.getByRole("button",{name:"Add label to selected evidence"}));
  await screen.findByText("Label outcome is unknown");expect(command).toHaveBeenCalledTimes(1);
  const frozen=command.mock.calls[0]![0];expect(frozen).toMatchObject({artifactIds:["a","b"],labelMutation:{label:"Reviewed",operation:"add"},privacyClass:"owner_only"});
  p={...p,selectedArtifactIds:["b"]};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.click(screen.getByRole("button",{name:"Refresh label history"}));await waitFor(()=>expect(p.onRefresh).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button",{name:"Retry frozen label operation"}).hasAttribute("disabled")).toBe(true);
  p={...p,readCompletion:{requested:2,succeeded:1,failed:-1}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  expect(screen.getByRole("button",{name:"Retry frozen label operation"}).hasAttribute("disabled")).toBe(true);
  p={...p,readCompletion:{requested:2,succeeded:1,failed:2}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  expect(screen.getByRole("button",{name:"Retry frozen label operation"}).hasAttribute("disabled")).toBe(true);
  p={...p,readCompletion:{requested:3,succeeded:3,failed:2}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.click(screen.getByRole("button",{name:"Retry frozen label operation"}));await waitFor(()=>expect(command).toHaveBeenCalledTimes(2));
  expect(command.mock.calls[1]![0]).toEqual(frozen);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Retry frozen label operation"}).hasAttribute("disabled")).toBe(true));
  p={...p,readCompletion:{requested:4,succeeded:4,failed:2}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.click(screen.getByRole("button",{name:"Retry frozen label operation"}));await waitFor(()=>expect(command).toHaveBeenCalledTimes(3));expect(command.mock.calls[2]![0]).toEqual(frozen);
 });
 it("does not attribute a later unknown label result to an earlier definite note failure",async()=>{
  const command=vi.fn(async(input:unknown)=> (input as {labelMutation?:unknown}).labelMutation ? unknown : {status:"failed",error:{kind:"forbidden"}});
  let p=props({bulkCommand:command});const view=render(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.change(screen.getByLabelText("Durable note for these files"),{target:{value:"Synthetic note"}});
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Save one note to selected evidence"})));
  p={...p,bulkMutation:{status:"failed",error:{kind:"forbidden"}},bulkErrorCopy:"Synthetic note permission refusal"};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  expect(screen.getByText("The note was not confirmed")).toBeTruthy();expect(screen.getByText("Synthetic note permission refusal")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Exact label"),{target:{value:"Exact"}});
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Add label to selected evidence"})));
  view.rerender(<EvidenceAnnotationWorkspace {...p} bulkMutation={{status:"failed",error:unknown.error}}/>);
  expect(screen.getByText("Label outcome is unknown")).toBeTruthy();expect(screen.queryByText("The server did not confirm this note")).toBeNull();expect(screen.queryByText("The note was not confirmed")).toBeNull();
  expect(screen.getByLabelText("Durable note for these files").hasAttribute("disabled")).toBe(false);expect(command).toHaveBeenCalledTimes(2);
 });
 it("does not authorize retry from an overlapping read that completes after the unknown result",async()=>{
  let settle:(value:unknown)=>void=()=>{};const command=vi.fn((_input:unknown)=>new Promise<{status:string}>(resolve=>{settle=value=>resolve(value as {status:string});}));
  let p=props({bulkCommand:command});const view=render(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.change(screen.getByLabelText("Exact label"),{target:{value:"Exact"}});fireEvent.click(screen.getByRole("button",{name:"Add label to selected evidence"}));
  p={...p,readCompletion:{requested:2,succeeded:1,failed:-1},annotations:{availability:"available",value:[],refresh:"loading"}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  await act(async()=>settle(unknown));
  p={...p,readCompletion:{requested:2,succeeded:2,failed:-1},annotations:{availability:"available",value:[],refresh:"settled"}};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);
  expect(screen.getByRole("button",{name:"Retry frozen label operation"}).hasAttribute("disabled")).toBe(true);expect(command).toHaveBeenCalledTimes(1);
 });
 it("recovers committed desired state from later history with no second mutation and hides revoked private labels",async()=>{
  const command=vi.fn(async(_input:unknown)=>unknown);let p=props({bulkCommand:command});const view=render(<EvidenceAnnotationWorkspace {...p}/>);
  fireEvent.change(screen.getByLabelText("Exact label"),{target:{value:"Private meaning"}});fireEvent.click(screen.getByRole("button",{name:"Add label to selected evidence"}));await screen.findByText("Label outcome is unknown");
  p={...p,readCompletion:{requested:2,succeeded:2,failed:-1},annotations:{availability:"available",refresh:"settled",value:["a","b"].map(artifactId=>({id:artifactId,artifactId,privacyClass:"owner_only",labelEvent:{label:"Private meaning",operation:"add",sequence:1,intentKey:"test-00000000"}}))}};
  view.rerender(<EvidenceAnnotationWorkspace {...p}/>);await screen.findByText(/no second mutation was sent/);expect(command).toHaveBeenCalledTimes(1);
  p={...p,canReadPrivate:false};view.rerender(<EvidenceAnnotationWorkspace {...p}/>);expect(screen.queryByText(/add label “Private meaning”/)).toBeNull();expect(screen.queryByText(/Current labels: Private meaning/)).toBeNull();expect(screen.getByLabelText("Exact label").getAttribute("value")).toBe("");
 });
 it.each(["network","protocol","unexpected","server_failure"])("freezes equivalent uncertain %s outcomes",async(kind)=>{
  const p=props({bulkCommand:vi.fn(async()=>({status:"failed",error:{kind}}))});render(<EvidenceAnnotationWorkspace {...p}/>);fireEvent.change(screen.getByLabelText("Exact label"),{target:{value:"Exact"}});fireEvent.click(screen.getByRole("button",{name:"Remove label from selected evidence"}));await screen.findByText("Label outcome is unknown");expect(screen.getByLabelText("Exact label").hasAttribute("disabled")).toBe(true);
 });
});
describe("retained structured label callbacks",()=>{
 it("revokes retained retry callbacks after repeated unknown and A→B→A without waiting for passive cleanup",async()=>{
  const command=vi.fn(async(_input:unknown)=>unknown);const initial=props({bulkCommand:command});const hook=renderHook(p=>useLabelIntent(p),{initialProps:initial});
  act(()=>hook.result.current.setText("Exact"));await act(()=>hook.result.current.submit("add"));
  hook.rerender({...initial,readCompletion:{requested:2,succeeded:2,failed:-1}});
  const retainedRetry=hook.result.current.retry;await act(()=>retainedRetry());expect(command).toHaveBeenCalledTimes(2);
  await act(()=>retainedRetry());expect(command).toHaveBeenCalledTimes(2);
  const retainedSubmit=hook.result.current.submit;
  function BeforePassive({p}:{p:EvidenceAnnotationWorkspaceProps}) {useLabelIntent(p);useLayoutEffect(()=>{void retainedRetry();void retainedSubmit("remove");},[p]);return null;}
  // RenderHook independently revalidates retained scope at render time.
  hook.rerender({...initial,scopeKey:"B:bob:authority2"});await act(()=>retainedRetry());await act(()=>retainedSubmit("remove"));
  hook.rerender(initial);await act(()=>retainedRetry());expect(command).toHaveBeenCalledTimes(2);
  render(<BeforePassive p={{...initial,scopeKey:"B:bob:authority2"}}/>);await act(async()=>{});expect(command).toHaveBeenCalledTimes(2);
 });
 it("rejects callbacks retained before authority replacement in layout effect",async()=>{
  let retained:(op:"add"|"remove")=>Promise<void>=async()=>{};const command=vi.fn(async(_input:unknown)=>unknown);let callOld=false;
  function Probe({p}:{p:EvidenceAnnotationWorkspaceProps}) {const labels=useLabelIntent(p);useLayoutEffect(()=>{if(callOld)void retained("add");else retained=labels.submit;},[labels]);return <button onClick={()=>labels.setText("Exact")}>Draft</button>;}
  const p=props({bulkCommand:command});const view=render(<Probe p={p}/>);fireEvent.click(screen.getByText("Draft"));callOld=true;
  view.rerender(<Probe p={{...p,scopeKey:"A:alice:authority2"}}/>);await act(async()=>{});expect(command).not.toHaveBeenCalled();
 });
});
