import {
  hostSaveConfluence,
  hostTestConfluence,
  hostTestX,
  type ConnectorDto,
  type NewsSourceDto,
} from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import {
  SecretField,
  SelectField,
  TextField,
  ToggleField,
} from "../forms";
import { HelpTip, HelpTitle } from "../HelpTip";

export type ConnectorsSectionProps = {
  baseId: string;
  draft: AppSetupState;
  setDraft: React.Dispatch<React.SetStateAction<AppSetupState>>;
  newsSources: NewsSourceDto[];
  setNewsSources: React.Dispatch<React.SetStateAction<NewsSourceDto[]>>;
  newsByGroup: { key: string; label: string; items: NewsSourceDto[] }[];
  setSourceEnabled: (id: string, enabled: boolean) => void;
  setGroupEnabled: (group: string, enabled: boolean) => void;
  connectors: ConnectorDto[];
  setConnectors: React.Dispatch<React.SetStateAction<ConnectorDto[]>>;
  connectorKinds: string[];
  newConnectorKind: string;
  setNewConnectorKind: (v: string) => void;
  connectorsNote: string | null;
  pgPasswordDrafts: Record<string, string>;
  setPgPasswordDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  httpBearerDrafts: Record<string, string>;
  setHttpBearerDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  cfTokenDraft: string;
  setCfTokenDraft: (v: string) => void;
  cfStatus: string | null;
  setCfStatus: (v: string | null) => void;
  confluenceUrlError: string | null;
  xTokenDraft: string;
  setXTokenDraft: (v: string) => void;
  xStatus: string | null;
  setXStatus: (v: string | null) => void;
};

export function ConnectorsSection(props: ConnectorsSectionProps) {
  const {
    baseId,
    draft,
    setDraft,
    newsSources,
    setNewsSources,
    newsByGroup,
    setSourceEnabled,
    setGroupEnabled,
    connectors,
    setConnectors,
    connectorKinds,
    newConnectorKind,
    setNewConnectorKind,
    connectorsNote,
    pgPasswordDrafts,
    setPgPasswordDrafts,
    httpBearerDrafts,
    setHttpBearerDrafts,
    cfTokenDraft,
    setCfTokenDraft,
    cfStatus,
    setCfStatus,
    confluenceUrlError,
    xTokenDraft,
    setXTokenDraft,
    xStatus,
    setXStatus,
  } = props;
  return (
<div>
  <p className="section-lead">
    Optional data sources. Use the{" "}
    <span className="section-lead__help-hint" aria-hidden>
      ?
    </span>{" "}
    icons for setup steps where extra configuration is required.
  </p>

  <div className="settings-connector-block">
    <HelpTitle
      title="Connector registry"
      helpLabel="Connector registry"
      helpTitle="Workspace connectors"
    >
      <p>
        Generic connectors (files, memory, SQLite, Postgres, MCP,
        HTTP, Confluence). Kind-specific credentials use the OS
        keychain on Save — never pasted into config JSON.
      </p>
      <p>
        MCP / SQL / HTTP execution arms land in follow-up issues;
        you can still enable entries so they persist.
      </p>
    </HelpTitle>
    <ul className="session-list">
      {connectors.length === 0 ? (
        <li className="field__hint">No connectors yet — add one below.</li>
      ) : (
        connectors.map((c) => (
          <li key={c.id}>
            <div className="session-list__item row--between">
              <span>
                <strong>{c.label || c.kind}</strong>
                <span className="field__hint">
                  {" "}
                  · {c.kind} · {c.id}
                </span>
              </span>
              <div className="field-row">
                <ToggleField
                  id={`${baseId}-conn-${c.id}`}
                  label="Enabled"
                  checked={c.enabled}
                  onChange={(enabled) =>
                    setConnectors((list) =>
                      list.map((x) =>
                        x.id === c.id ? { ...x, enabled } : x,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    setConnectors((list) =>
                      list.filter((x) => x.id !== c.id),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))
      )}
    </ul>
    <div className="field-row">
      <SelectField
        id={`${baseId}-new-conn-kind`}
        label="Add connector kind"
        value={newConnectorKind}
        onChange={(e) => setNewConnectorKind(e.target.value)}
      >
        {(connectorKinds.length
          ? connectorKinds
          : [
              "files",
              "memory",
              "sqlite",
              "postgres",
              "mcp",
              "http",
              "confluence",
            ]
        ).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </SelectField>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={() => {
          const kind = newConnectorKind.trim() || "sqlite";
          const id = `${kind}-${Date.now().toString(36)}`;
          const settings =
            kind === "mcp"
              ? {
                  name: id,
                  command: "",
                  args: [] as string[],
                  read_tools: [] as string[],
                }
              : kind === "sqlite"
                ? { path: "", timeout_ms: 5000 }
                : kind === "postgres"
                  ? {
                      host: "127.0.0.1",
                      port: 5432,
                      database: "",
                      user: "cd_ro",
                      sslmode: "disable",
                      timeout_ms: 5000,
                    }
                  : kind === "http"
                    ? {
                        host: "",
                        base_path: "",
                        get_routes: [] as string[],
                        allow_private: false,
                      }
                    : {};
          setConnectors((list) => [
            ...list,
            {
              id,
              kind,
              enabled: true,
              label: kind,
              settings,
            },
          ]);
        }}
      >
        Add
      </button>
    </div>
    {connectors
      .filter((c) => c.kind === "mcp")
      .map((c) => {
        const settings = (c.settings ?? {}) as {
          name?: string;
          command?: string;
          args?: string[];
        };
        return (
          <div key={`mcp-cfg-${c.id}`} className="settings-connector-block">
            <p className="field__label">MCP: {c.id}</p>
            <TextField
              id={`${baseId}-mcp-cmd-${c.id}`}
              label="Absolute command"
              hint="e.g. /usr/local/bin/my-mcp-server — must be absolute (no shell)."
              value={settings.command ?? ""}
              onChange={(e) => {
                const command = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: {
                            ...(x.settings ?? {}),
                            name:
                              (x.settings as { name?: string })?.name ??
                              x.id,
                            command,
                            args:
                              (x.settings as { args?: string[] })?.args ??
                              [],
                          },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="/absolute/path/to/mcp-server"
            />
            <TextField
              id={`${baseId}-mcp-args-${c.id}`}
              label="Args (space-separated)"
              value={(settings.args ?? []).join(" ")}
              onChange={(e) => {
                const args = e.target.value
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean);
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: {
                            ...(x.settings ?? {}),
                            name:
                              (x.settings as { name?: string })?.name ??
                              x.id,
                            command:
                              (x.settings as { command?: string })
                                ?.command ?? "",
                            args,
                          },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="--flag value"
            />
            {c.discovered_tools && c.discovered_tools.length > 0 ? (
              <p className="field__hint" role="status">
                Discovered tools: {c.discovered_tools.join(", ")}
              </p>
            ) : c.enabled && (settings.command ?? "").trim() ? (
              <p className="field__hint">
                No tools discovered yet — Save to spawn and list tools.
              </p>
            ) : null}
          </div>
        );
      })}
    {connectors
      .filter((c) => c.kind === "sqlite")
      .map((c) => {
        const settings = (c.settings ?? {}) as {
          path?: string;
          timeout_ms?: number;
        };
        return (
          <div key={`sqlite-cfg-${c.id}`} className="settings-connector-block">
            <p className="field__label">SQLite RO: {c.id}</p>
            <TextField
              id={`${baseId}-sqlite-path-${c.id}`}
              label="Absolute database path"
              hint="Opened SQLITE_OPEN_READ_ONLY + query_only; SELECT only."
              value={settings.path ?? ""}
              onChange={(e) => {
                const path = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: {
                            ...(x.settings ?? {}),
                            path,
                            timeout_ms:
                              (x.settings as { timeout_ms?: number })
                                ?.timeout_ms ?? 5000,
                          },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="/absolute/path/to/db.sqlite"
            />
            <p className="field__hint">
              Tool: <code>sql_query__{c.id}</code>
            </p>
          </div>
        );
      })}
    {connectors
      .filter((c) => c.kind === "postgres")
      .map((c) => {
        const settings = (c.settings ?? {}) as {
          host?: string;
          port?: number;
          database?: string;
          user?: string;
          sslmode?: string;
        };
        return (
          <div key={`pg-cfg-${c.id}`} className="settings-connector-block">
            <p className="field__label">Postgres RO: {c.id}</p>
            <TextField
              id={`${baseId}-pg-host-${c.id}`}
              label="Host"
              value={settings.host ?? "127.0.0.1"}
              onChange={(e) => {
                const host = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), host },
                        }
                      : x,
                  ),
                );
              }}
            />
            <TextField
              id={`${baseId}-pg-db-${c.id}`}
              label="Database"
              value={settings.database ?? ""}
              onChange={(e) => {
                const database = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), database },
                        }
                      : x,
                  ),
                );
              }}
            />
            <TextField
              id={`${baseId}-pg-user-${c.id}`}
              label="User (RO role)"
              hint="Prefer a dedicated read-only role — see docs/DEV.md."
              value={settings.user ?? "cd_ro"}
              onChange={(e) => {
                const user = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), user },
                        }
                      : x,
                  ),
                );
              }}
            />
            <TextField
              id={`${baseId}-pg-ssl-${c.id}`}
              label="sslmode"
              hint="This build supports sslmode=disable (TLS residual for prefer/require)."
              value={settings.sslmode ?? "disable"}
              onChange={(e) => {
                const sslmode = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), sslmode },
                        }
                      : x,
                  ),
                );
              }}
            />
            <TextField
              id={`${baseId}-pg-pw-${c.id}`}
              label="Password (keychain)"
              type="password"
              hint="Stored in OS keychain only — never in config.json."
              value={pgPasswordDrafts[c.id] ?? ""}
              onChange={(e) =>
                setPgPasswordDrafts((m) => ({
                  ...m,
                  [c.id]: e.target.value,
                }))
              }
              placeholder="••••••••"
            />
            <p className="field__hint">
              Tool: <code>sql_query__{c.id}</code>
            </p>
          </div>
        );
      })}
    {connectors
      .filter((c) => c.kind === "http")
      .map((c) => {
        const settings = (c.settings ?? {}) as {
          host?: string;
          base_path?: string;
          get_routes?: string[];
          allow_private?: boolean;
        };
        return (
          <div key={`http-cfg-${c.id}`} className="settings-connector-block">
            <p className="field__label">HTTP preset: {c.id}</p>
            <TextField
              id={`${baseId}-http-host-${c.id}`}
              label="Host (exact, no scheme)"
              hint="SSRF-gated public HTTPS by default."
              value={settings.host ?? ""}
              onChange={(e) => {
                const host = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), host },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="api.example.com"
            />
            <TextField
              id={`${baseId}-http-base-${c.id}`}
              label="Base path"
              value={settings.base_path ?? ""}
              onChange={(e) => {
                const base_path = e.target.value;
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: { ...(x.settings ?? {}), base_path },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="/v1"
            />
            <TextField
              id={`${baseId}-http-routes-${c.id}`}
              label="GET routes (comma-separated)"
              hint="Only exact listed routes may be called."
              value={(settings.get_routes ?? []).join(", ")}
              onChange={(e) => {
                const get_routes = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setConnectors((list) =>
                  list.map((x) =>
                    x.id === c.id
                      ? {
                          ...x,
                          settings: {
                            ...(x.settings ?? {}),
                            get_routes,
                          },
                        }
                      : x,
                  ),
                );
              }}
              placeholder="/health, /status"
            />
            <TextField
              id={`${baseId}-http-bearer-${c.id}`}
              label="Bearer token (keychain, optional)"
              type="password"
              hint="Stored in OS keychain only — never in config.json."
              value={httpBearerDrafts[c.id] ?? ""}
              onChange={(e) =>
                setHttpBearerDrafts((m) => ({
                  ...m,
                  [c.id]: e.target.value,
                }))
              }
              placeholder="••••••••"
            />
            <p className="field__hint">
              Tool: <code>http_get__{c.id}</code> — private/LAN blocked unless
              advanced allow_private is set in config.
            </p>
          </div>
        );
      })}
    {connectorsNote ? (
      <p className="field__hint" role="status">
        {connectorsNote}
      </p>
    ) : (
      <p className="field__hint">
        Changes apply on <strong>Save</strong> (rebuilds tool host).
      </p>
    )}
  </div>

  <ToggleField
    id={`${baseId}-web-research`}
    label="Enable web research"
    hint="Adds web_search / web_fetch. No API key. Public web only; SSRF-gated."
    checked={draft.webResearchEnabled ?? false}
    onChange={(webResearchEnabled) =>
      setDraft((d) => ({ ...d, webResearchEnabled }))
    }
    help={{
      label: "web research setup",
      title: "Web research",
      body: (
        <>
          <p>
            Turns on agent tools that search and fetch public web
            pages. No account or API key is required.
          </p>
          <ol>
            <li>
              Toggle <strong>Enable web research</strong> on.
            </li>
            <li>
              Optionally disable individual publisher feeds you do
              not want used (groups match{" "}
              <code>packs</code> the model can pass).
            </li>
            <li>
              Click <strong>Save</strong>. New chat turns can call{" "}
              <code>web_search</code> and <code>web_fetch</code>.
            </li>
          </ol>
          <p>
            Backends: Google News RSS, curated publisher RSS, then
            DuckDuckGo fallbacks. Private/loopback URLs are blocked.
          </p>
        </>
      ),
    }}
  />
  {draft.webResearchEnabled && newsSources.length > 0 ? (
    <div className="news-sources">
      <div className="news-sources__lead-row">
        <p className="field__hint news-sources__lead">
          Publisher allowlist. Groups map to agent{" "}
          <code>packs</code>. Cached ~8 minutes.
        </p>
        <HelpTip
          label="publisher packs"
          title="Publisher feeds & packs"
        >
          <p>
            These feeds supply real article URLs alongside Google
            News. Everything is on by default.
          </p>
          <ul>
            <li>
              <strong>User toggles</strong> are the hard max —
              disabled sources never run.
            </li>
            <li>
              The model may pass{" "}
              <code>
                packs: [&quot;middle_east&quot;,
                &quot;security&quot;]
              </code>{" "}
              to narrow fan-in further.
            </li>
            <li>
              Pack ids:{" "}
              <code>public_intl</code>,{" "}
              <code>us_mainstream</code>,{" "}
              <code>middle_east</code>, <code>security</code>,{" "}
              <code>progressive</code>,{" "}
              <code>conservative</code>.
            </li>
          </ul>
        </HelpTip>
      </div>
      <div className="news-sources__bulk">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setNewsSources((all) =>
              all.map((s) => ({ ...s, enabled: true })),
            )
          }
        >
          Enable all
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setNewsSources((all) =>
              all.map((s) => ({ ...s, enabled: false })),
            )
          }
        >
          Disable all
        </button>
      </div>
      {newsByGroup.map((g) => (
        <div key={g.key} className="news-sources__group">
          <div className="news-sources__group-head">
            <span className="news-sources__group-label">
              {g.label}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                const allOn = g.items.every((i) => i.enabled);
                setGroupEnabled(g.key, !allOn);
              }}
            >
              {g.items.every((i) => i.enabled)
                ? "Disable group"
                : "Enable group"}
            </button>
          </div>
          {g.items.map((s) => (
            <ToggleField
              key={s.id}
              id={`${baseId}-src-${s.id}`}
              label={s.label}
              hint={s.hint}
              checked={s.enabled}
              onChange={(enabled) =>
                setSourceEnabled(s.id, enabled)
              }
            />
          ))}
        </div>
      ))}
    </div>
  ) : null}
  <div className="settings-connector-block">
    <HelpTitle
      title="X (Twitter)"
      helpLabel="X search setup"
      helpTitle="Set up X search"
    >
      <p>
        Optional connector for recent posts via the official X
        API. This is <strong>not free RSS</strong> — search needs
        a paid/usable X API plan. Free tier is effectively
        unusable for reading/search.
      </p>
      <ol>
        <li>
          Create an app at{" "}
          <strong>developer.x.com</strong> and subscribe to a plan
          that includes recent search.
        </li>
        <li>
          Copy a <strong>Bearer token</strong> (OAuth 2.0 app
          token).
        </li>
        <li>
          Toggle <strong>Enable X search</strong> on, paste the
          token below, then <strong>Save</strong>.
        </li>
        <li>
          Use <strong>Test X config</strong> to confirm a key is
          on file (does not call the live API).
        </li>
      </ol>
      <p>
        The token is stored only in the OS keychain — never in{" "}
        <code>config.json</code>. When both enable + key are set,
        the agent gets the <code>x_search</code> tool.
      </p>
    </HelpTitle>
    <ToggleField
      id={`${baseId}-x-enabled`}
      label="Enable X search"
      hint="Tool appears only when a bearer is also saved."
      checked={draft.x?.enabled ?? false}
      onChange={(enabled) =>
        setDraft((d) => ({
          ...d,
          x: {
            enabled,
            hasToken: d.x?.hasToken ?? false,
          },
        }))
      }
    />
    <SecretField
      id={`${baseId}-x-key`}
      label="X API bearer token"
      hint="Stored in keychain on Save."
      help={{
        label: "X API bearer",
        title: "Where the bearer goes",
        body: (
          <>
            <p>
              Paste the Bearer token from the X developer
              portal. ContextDesk sends it only as{" "}
              <code>Authorization: Bearer …</code> to{" "}
              <code>api.x.com</code>.
            </p>
            <p>
              Leave blank on later saves to keep the existing
              key. Masked dots mean a key is already stored.
            </p>
          </>
        ),
      }}
      value={
        xTokenDraft
          ? xTokenDraft
          : draft.x?.hasToken
            ? "••••••••••••"
            : ""
      }
      error={
        draft.x?.enabled && !draft.x.hasToken && !xTokenDraft
          ? "Required when X search is enabled."
          : null
      }
      ok={
        draft.x?.hasToken && !xTokenDraft
          ? "Token on file (masked)"
          : null
      }
      onChange={(e) => {
        const v = e.target.value;
        if (v.includes("•") && draft.x?.hasToken) return;
        setXTokenDraft(v);
        if (v.trim()) {
          setDraft((d) => ({
            ...d,
            x: {
              enabled: d.x?.enabled ?? true,
              hasToken: true,
            },
          }));
        }
      }}
      placeholder="Paste bearer token"
    />
    <div className="field-row">
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          void (async () => {
            try {
              const msg = await hostTestX();
              setXStatus(msg);
            } catch (e) {
              setXStatus(
                e instanceof Error ? e.message : String(e),
              );
            }
          })();
        }}
      >
        Test X config
      </button>
    </div>
    {xStatus ? (
      <p className="field__hint" role="status">
        {xStatus}
      </p>
    ) : null}
  </div>

  <div className="settings-connector-block">
    <HelpTitle
      title="Confluence (read-only)"
      helpLabel="Confluence setup"
      helpTitle="Set up Confluence"
    >
      <p>
        Read-only access to a Confluence wiki. The agent can
        search and open pages; it cannot create or edit content.
      </p>
      <ol>
        <li>
          Note your wiki base URL (e.g.{" "}
          <code>https://wiki.example.com</code> — no{" "}
          <code>/wiki</code> or API path required).
        </li>
        <li>
          Create a personal access token (PAT) or API token in
          your Atlassian/Confluence account.
        </li>
        <li>
          Toggle enable on, enter base URL + PAT, optionally
          restrict to space keys (e.g. <code>ENG, DOCS</code>).
        </li>
        <li>
          <strong>Save</strong>, then Test configuration.
        </li>
      </ol>
      <p>
        The PAT is stored only in the OS keychain. Tools:{" "}
        <code>confluence_search</code>,{" "}
        <code>confluence_get_page</code>.
      </p>
    </HelpTitle>
  <ToggleField
    id={`${baseId}-cf-enabled`}
    label="Enable Confluence"
    hint="PAT stays in the OS keychain only."
    checked={draft.confluence?.enabled ?? false}
    onChange={(enabled) =>
      setDraft((d) => ({
        ...d,
        confluence: {
          enabled,
          baseUrl: d.confluence?.baseUrl ?? "",
          spaces: d.confluence?.spaces ?? "",
          hasToken: d.confluence?.hasToken ?? false,
        },
      }))
    }
  />
  <TextField
    id={`${baseId}-cf-url`}
    label="Confluence base URL"
    hint="e.g. https://wiki.example.com — no API path required"
    help={{
      label: "Confluence URL",
      title: "Base URL format",
      body: (
        <>
          <p>
            Use the site origin only. ContextDesk appends the
            REST paths it needs.
          </p>
          <ul>
            <li>
              Good: <code>https://wiki.company.com</code>
            </li>
            <li>
              Good:{" "}
              <code>https://yoursite.atlassian.net/wiki</code>{" "}
              if that is how your Cloud wiki is reached
            </li>
            <li>
              Avoid pasting full page or API URLs with query
              strings
            </li>
          </ul>
        </>
      ),
    }}
    value={draft.confluence?.baseUrl ?? ""}
    error={confluenceUrlError}
    ok={
      draft.confluence?.enabled &&
      draft.confluence.baseUrl &&
      !confluenceUrlError
        ? "Looks like a valid URL"
        : null
    }
    onChange={(e) =>
      setDraft((d) => ({
        ...d,
        confluence: {
          enabled: d.confluence?.enabled ?? true,
          baseUrl: e.target.value,
          spaces: d.confluence?.spaces ?? "",
          hasToken: d.confluence?.hasToken ?? false,
        },
      }))
    }
    placeholder="https://your-confluence.example.com"
  />
  <SecretField
    id={`${baseId}-cf-pat`}
    label="Personal access token"
    hint="Stored in keychain only."
    help={{
      label: "Confluence PAT",
      title: "Personal access token",
      body: (
        <>
          <p>
            Create a PAT or API token in your Atlassian/Confluence
            account settings with read access to the spaces you
            need.
          </p>
          <p>
            Paste once and Save. Leave blank later to keep the
            existing token; masked dots mean a token is already
            stored.
          </p>
        </>
      ),
    }}
    value={
      cfTokenDraft
        ? cfTokenDraft
        : draft.confluence?.hasToken
          ? "••••••••••••"
          : ""
    }
    error={
      draft.confluence?.enabled && !draft.confluence.hasToken && !cfTokenDraft
        ? "Required when Confluence is enabled."
        : null
    }
    ok={
      draft.confluence?.hasToken && !cfTokenDraft
        ? "Token on file (masked)"
        : null
    }
    onChange={(e) => {
      const v = e.target.value;
      if (v.includes("•") && draft.confluence?.hasToken) return;
      setCfTokenDraft(v);
      if (v.trim()) {
        setDraft((d) => ({
          ...d,
          confluence: {
            enabled: d.confluence?.enabled ?? true,
            baseUrl: d.confluence?.baseUrl ?? "",
            spaces: d.confluence?.spaces ?? "",
            hasToken: true,
          },
        }));
      }
    }}
    placeholder="Paste token"
  />
  <TextField
    id={`${baseId}-cf-spaces`}
    label="Space keys (optional allowlist)"
    hint="Comma-separated, e.g. ENG, DOCS. Empty = no extra filter."
    value={draft.confluence?.spaces ?? ""}
    onChange={(e) =>
      setDraft((d) => ({
        ...d,
        confluence: {
          enabled: d.confluence?.enabled ?? true,
          baseUrl: d.confluence?.baseUrl ?? "",
          spaces: e.target.value,
          hasToken: d.confluence?.hasToken ?? false,
        },
      }))
    }
    placeholder="ENG, DOCS"
  />
  <ToggleField
    id={`${baseId}-cf-write`}
    label="Enable Confluence writes (create/update)"
    hint="Default off. HardWrite + type-confirm WRITE. Requires non-empty space allowlist."
    checked={draft.confluence?.writeEnabled ?? false}
    onChange={(on) =>
      setDraft((d) => ({
        ...d,
        confluence: {
          enabled: d.confluence?.enabled ?? true,
          baseUrl: d.confluence?.baseUrl ?? "",
          spaces: d.confluence?.spaces ?? "",
          hasToken: d.confluence?.hasToken ?? false,
          writeEnabled: on,
        },
      }))
    }
  />
  <div className="field-row">
    <button
      type="button"
      className="btn btn--ghost"
      onClick={() => {
        void (async () => {
          try {
            // Save first so test sees latest URL/token
            await hostSaveConfluence({
              enabled: draft.confluence?.enabled ?? false,
              baseUrl: draft.confluence?.baseUrl ?? "",
              spaces: draft.confluence?.spaces ?? "",
              pat: cfTokenDraft.trim() || undefined,
              writeEnabled: draft.confluence?.writeEnabled ?? false,
            });
            const msg = await hostTestConfluence();
            setCfStatus(msg);
          } catch (e) {
            setCfStatus(
              e instanceof Error ? e.message : String(e),
            );
          }
        })();
      }}
    >
      Test configuration
    </button>
  </div>
  {cfStatus ? (
    <p className="section-lead" role="status">
      {cfStatus}
    </p>
  ) : null}
  </div>
</div>

  );
}
