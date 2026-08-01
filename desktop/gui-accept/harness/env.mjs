/**
 * Isolated temporary app data + workspace for one acceptance run.
 * Returns env maps for the SUT only — does not mutate the parent process HOME.
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/**
 * @param {string} runDir
 */
export function createIsolatedHomes(runDir) {
  const home = join(runDir, "home");
  const workspace = join(runDir, "workspace", "ContextDesk");
  const configDir = join(home, ".contextdesk");
  const docs = join(home, "Documents", "ContextDesk");
  for (const d of [home, workspace, configDir, docs]) {
    mkdirSync(d, { recursive: true });
  }

  // Minimal AppConfig: provider pre-seeded so AI step is not permanently blocked,
  // but setup_completed=false so PreLaunch wizard still appears (demo install lives there).
  // Workspace pre-created on disk; wizard "Use default folder" / Continue still work.
  // Kind ollama + loopback stub (started separately). No secrets; no production backdoor.
  const profileId = "gui-accept-ollama";
  const config = {
    providers: {
      active_id: profileId,
      profiles: [
        {
          id: profileId,
          label: "GUI Accept Ollama Stub",
          kind: "ollama",
          base_url: "http://127.0.0.1:0",
          chat_model: "gui-accept-stub",
          embedding_model: null,
          embedding_base_url: null,
          api_key_ref: null,
          capabilities: { tools: true, stream: true, embeddings: false },
          local_only: true,
          deadline_preference: "auto",
        },
      ],
    },
    workspace: {
      id: "gui-accept-workspace",
      name: "Workspace",
      roots: [workspace],
    },
    theme: "dark",
    // Keep first-run PreLaunch so "Install demo log corpus" is reachable.
    setup_completed: false,
  };
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(
    join(runDir, "isolation.json"),
    JSON.stringify({ home, workspace, configDir, docs }, null, 2),
  );

  return {
    home,
    workspace,
    configDir,
    docs,
    profileId,
    configPath: join(configDir, "config.json"),
  };
}

/**
 * Minimal Ollama-compatible stub so preflight reachability can pass hermetically.
 * Only answers GET /api/tags. Not a product fake provider plugin.
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export function startOllamaStub() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/tags")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [{ name: "gui-accept-stub", model: "gui-accept-stub" }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("stub bind failed"));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * @param {string} configPath
 * @param {string} baseUrl
 */
export function setConfigOllamaBaseUrl(configPath, baseUrl) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  if (cfg.providers?.profiles?.[0]) {
    cfg.providers.profiles[0].base_url = baseUrl;
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

/**
 * Env map for spawning the ContextDesk binary (SUT only).
 * @param {{ home: string, runDir: string, baseEnv?: NodeJS.ProcessEnv }} opts
 */
export function sutEnv(opts) {
  const { home, runDir, baseEnv = process.env } = opts;
  return {
    ...scrubSensitiveEnv(baseEnv),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    RUST_LOG: process.env.GUI_ACCEPT_RUST_LOG || "info,cd_core=info,contextdesk=info",
    GUI_ACCEPT_RUN_ID: randomBytes(4).toString("hex"),
    GUI_ACCEPT_ARTIFACT_DIR: join(runDir, "logs"),
  };
}

const SENSITIVE_ENV_KEY =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:$|_)/i;
const PROVIDER_ENV_PREFIX =
  /^(?:OPENAI|ANTHROPIC|AZURE|AWS|GOOGLE|GEMINI|GROQ|MISTRAL|COHERE|OLLAMA|BEDROCK|VERTEX)_/i;

/**
 * Keep launch mechanics while preventing ambient provider credentials and
 * endpoints from leaking into the product process or captured diagnostics.
 */
export function scrubSensitiveEnv(baseEnv) {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([key]) =>
        !SENSITIVE_ENV_KEY.test(key) && !PROVIDER_ENV_PREFIX.test(key),
    ),
  );
}

export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
