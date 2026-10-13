import {expect,test,type Page} from "@playwright/test";
import {spawn,type ChildProcess} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const serverFile=resolve(here,"../../server/dist/index.js");
const staticDir=resolve(here,"../../web/dist");
const headers={"x-cd-collab-csrf":"1"};
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No disposable port");
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}
async function startServer(root: string, port: number, password: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: { ...process.env,
      COLLAB_STORAGE: "sqlite", COLLAB_SQLITE_PATH: join(root, "collab.sqlite"),
      COLLAB_EVIDENCE_ROOT: join(root, "evidence"), COLLAB_STATIC_DIR: staticDir,
      COLLAB_AUTH_MODE: "local", COLLAB_LOCAL_USERS: JSON.stringify([{ username: "lead", password,
        groups: ["local:lead"], displayName: "Synthetic lead" }]),
      COLLAB_GROUP_ROLE_MAP: "local:lead=admin", COLLAB_COOKIE_SECURE: "0",
      COLLAB_HOST: "127.0.0.1", COLLAB_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-3000);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`SQLite server exited: ${diagnostic}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`SQLite server did not start: ${diagnostic}`);
}
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const stopped = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await stopped;
}

async function signIn(page:Page,base:string,password:string) {
 await page.goto(base);await page.getByLabel("Username").fill("lead");await page.getByLabel("Password").fill(password);await page.getByRole("button",{name:"Sign in"}).click();await expect(page.getByRole("button",{name:"Signed in as Synthetic lead"})).toBeVisible();
}
async function presentation(page:Page,name:string) {
 const account=page.getByRole("button",{name:"Signed in as Synthetic lead"});await account.click();const option=page.getByRole("radio",{name:new RegExp(`^${name}\\b`,"u")});await option.check();await page.getByRole("button",{name:"Use selected experience"}).click();await expect(page.locator(".topbar__title-app")).toHaveText(name);await page.keyboard.press("Escape");if(await account.getAttribute("aria-expanded")==="true")await account.click();
}
async function json(page:Page,base:string,path:string,data?:unknown) {
 const response=data===undefined?await page.request.get(base+path):await page.request.post(base+path,{headers,data});expect(response.ok(),await response.text()).toBe(true);return await response.json();
}
test.describe("@joined structured evidence labels",()=>{
 test.skip(!process.env.CD_GOAL10_JOINED,"Requires the built real SQLite server");
 test("adds/removes across Investigation First and Keystone, freezes lost acknowledgment, and persists after restart",async({page},info)=>{
  test.setTimeout(180_000);page.setDefaultTimeout(15_000);const root=await mkdtemp(join(tmpdir(),"cd-goal10-browser-"));const port=await freePort();const base=`http://127.0.0.1:${port}`;const password=randomUUID();let child:ChildProcess|null=null;
  try {
   child=await startServer(root,port,password);await signIn(page,base,password);
   const c=await json(page,base,"/api/cases",{title:"Synthetic structured label review"});
   const ids:string[]=[];
   for(const [filename,privacyClass,kind] of [["synthetic-a.txt","share_safe","attachment"],["synthetic-b.log","owner_only","log"]]) {
    const uploaded=await json(page,base,`/api/cases/${c.id}/evidence`,{filename,privacyClass,kind,mediaType:"text/plain",contentBase64:Buffer.from(`Synthetic bytes: ${filename}`).toString("base64"),summary:"Synthetic evidence"});ids.push(uploaded.artifact.id);
   }
   const before=await json(page,base,`/api/cases/${c.id}/evidence`);
   await page.goto(`${base}/investigations`);await presentation(page,"Investigation First");await page.goto(`${base}/investigations/${c.id}/capture`);
   for(const name of ["synthetic-a.txt","synthetic-b.log"])await page.getByRole("checkbox",{name:new RegExp(name,"u")}).check();
   const workspace=page.locator(".strategy-kit__annotation-workspace");await workspace.getByLabel("Exact label").fill("Reviewed");await workspace.getByLabel("Label privacy").selectOption("share_safe");
   let writes=0;let loseOnce=true;
   await page.route(`**/api/cases/${c.id}/evidence/annotations`,async route=>{
    if(route.request().method()!=="POST"){await route.continue();return;}
    writes++;const response=await route.fetch();if(loseOnce){loseOnce=false;await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"commit_outcome_unknown"})});}else await route.fulfill({response});
   });
   await workspace.getByRole("button",{name:"Add label to selected evidence"}).click();await expect(workspace.getByText("Label outcome is unknown")).toBeVisible();expect(writes).toBe(1);
   await expect(workspace.getByRole("button",{name:"Retry frozen label operation"})).toBeDisabled();await workspace.getByRole("button",{name:"Refresh label history"}).click();await expect(workspace.getByText(/no second mutation was sent/)).toBeVisible();expect(writes).toBe(1);
   await expect(workspace.getByText("Current labels: Reviewed",{exact:true})).toHaveCount(2);
   await workspace.getByRole("button",{name:"Remove label from selected evidence"}).click();await expect(workspace.getByText("Current labels: None visible",{exact:true})).toHaveCount(2);
   const history=await json(page,base,`/api/cases/${c.id}/evidence/annotations`);expect(history.annotations.filter((row:{labelEvent?:{label:string}})=>row.labelEvent?.label==="Reviewed")).toHaveLength(4);expect(history.currentLabels).toEqual([]);
   await page.unroute(`**/api/cases/${c.id}/evidence/annotations`);
   await presentation(page,"Keystone");await page.goto(`${base}/investigations/${c.id}/capture`);
   for(const name of ["synthetic-a.txt","synthetic-b.log"])await page.getByRole("checkbox",{name:`Add ${name} to working set`}).check();
   await workspace.getByLabel("Exact label").fill("reviewed");await workspace.getByLabel("Label privacy").selectOption("share_safe");await workspace.getByRole("button",{name:"Add label to selected evidence"}).click();await expect(workspace.getByText("Current labels: reviewed",{exact:true})).toHaveCount(2);
   await page.setViewportSize({width:390,height:844});await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
   expect(await page.evaluate(()=>matchMedia("(forced-colors: active)").matches)).toBe(true);expect(await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
   const label=workspace.getByLabel("Exact label");await label.focus();await expect(label).toBeFocused();expect(await label.evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe("none");expect(await label.evaluate(el=>getComputedStyle(el).transitionDuration)).toBe("0s");await page.keyboard.press("Tab");await expect(workspace.getByLabel("Label privacy")).toBeFocused();
   expect(await workspace.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath("goal10-keystone-narrow-forced-colors.png"),fullPage:true});
   expect(await json(page,base,`/api/cases/${c.id}/evidence`)).toEqual(before);
   const archive=await page.request.get(`${base}/api/cases/${c.id}/portable-archive`);expect(archive.status()).toBe(422);expect(await archive.text()).toContain("structured label history");
   await page.setViewportSize({width:1280,height:900});await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
   await stopServer(child);child=null;child=await startServer(root,port,password);await page.context().clearCookies();await signIn(page,base,password);
   expect((await json(page,base,`/api/cases/${c.id}/evidence/annotations`)).currentLabels).toEqual(ids.sort().map(artifactId=>({artifactId,label:"reviewed"})));
   await page.goto(`${base}/investigations/${c.id}/capture`);await page.reload();await expect(page.getByRole("heading",{name:"Synthetic structured label review"})).toBeVisible();
  } finally {if(child)await stopServer(child);await rm(root,{recursive:true,force:true});}
 });
});
