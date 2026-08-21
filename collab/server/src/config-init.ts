import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";

export const LOCAL_DEMO_ENV = `# Generated private local War Room configuration.
# Change the placeholder password before using this outside a throwaway demo.
COLLAB_STORAGE=sqlite
COLLAB_SQLITE_PATH=.data/collab.sqlite
COLLAB_EVIDENCE_ROOT=.data/evidence
COLLAB_STATIC_DIR=web/dist
COLLAB_HOST=127.0.0.1
COLLAB_PORT=8787
COLLAB_SERVICE_NAME=cd-collab-local
COLLAB_AUTH_MODE=local
COLLAB_LOCAL_USERS='[{"username":"lead","password":"CHANGE-ME","displayName":"Case Lead","groups":["local:case-lead"]}]'
COLLAB_GROUP_ROLE_MAP=local:case-lead=case-lead
COLLAB_COOKIE_SECURE=0
`;

export async function initializeLocalConfig(output: string, force = false): Promise<string> {
  const target = resolve(output);
  if (!force) {
    try {
      await access(target, fsConstants.F_OK);
      throw new Error("output already exists; pass --force to replace it");
    } catch (error) {
      if (error instanceof Error && error.message.includes("output already exists")) throw error;
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const baseDir = dirname(target);
  await mkdir(resolve(baseDir, ".data", "evidence"), { recursive: true });
  await writeFile(target, LOCAL_DEMO_ENV, {
    encoding: "utf8",
    mode: 0o600,
    flag: force ? "w" : "wx",
  });
  return target;
}
