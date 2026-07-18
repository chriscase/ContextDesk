import type { LocalCandidateDto } from "../../lib/host";
import { normalizeProviderKind } from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import {
  SecretField,
  SelectField,
  TextField,
  ToggleField,
} from "../forms";
export type AiSectionProps = {
  baseId: string;
  draft: AppSetupState;
  setDraft: React.Dispatch<React.SetStateAction<AppSetupState>>;
  candidates: LocalCandidateDto[];
  apiKeyDraft: string;
  setApiKeyDraft: (v: string) => void;
  probeNote: string | null;
  remoteUrlCheck: {
    error?: string | null;
    ok?: string | null;
    pending?: string | null;
  };
  urlError: string | null;
  recheck: () => void | Promise<void>;
  checking: boolean;
};

export function AiSection({
  baseId,
  draft,
  setDraft,
  candidates,
  apiKeyDraft,
  setApiKeyDraft,
  probeNote,
  remoteUrlCheck,
  urlError,
  recheck,
  checking,
}: AiSectionProps) {
  return (
<div>
  <p className="section-lead">
    Discover or configure models here. Keys go to the OS keychain;
    profiles never need a hand-edited secrets file.
  </p>
  {candidates.length > 0 ? (
    <div className="field">
      <span className="field__label">Local candidates</span>
      <ul className="session-list">
        {candidates.map((c) => {
          const candKind = normalizeProviderKind(c.kind);
          const inUse =
            candKind !== "none" &&
            draft.providerKind === candKind &&
            (candKind !== "openai_compatible" ||
              !c.base_url ||
              draft.baseUrl === c.base_url);
          return (
            <li key={c.id}>
              <div className="session-list__item row--between">
                <span>
                  {c.label}
                  {c.credentials_present ? " · credentials present" : ""}
                  {c.notes[0] ? ` · ${c.notes[0]}` : ""}
                  {inUse ? " · selected" : ""}
                </span>
                <button
                  type="button"
                  className={
                    inUse ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"
                  }
                  disabled={inUse}
                  onClick={() => {
                    const kind = normalizeProviderKind(c.kind);
                    if (kind === "none") {
                      void import("../../lib/dialogs").then(
                        ({ dialogMessage }) =>
                          dialogMessage(
                            `This candidate (${c.kind}) is not supported yet.`,
                            { title: "Provider", kind: "info" },
                          ),
                      );
                      return;
                    }
                    if (kind === "xai_grok_build") {
                      void import("../../lib/dialogs").then(
                        async ({ dialogConfirm }) => {
                          const ok = await dialogConfirm(
                            [
                              "Use Grok Build session credentials?",
                              "",
                              "ContextDesk will call api.x.ai using your local",
                              "~/.grok/auth.json session (not auto-enabled until you Save).",
                              "Tokens stay on this machine and are never written to settings JSON.",
                            ].join("\n"),
                            {
                              title: "Grok Build session",
                              kind: "warning",
                            },
                          );
                          if (!ok) return;
                          setDraft((d) => ({
                            ...d,
                            providerKind: "xai_grok_build",
                            providerLabel: c.label,
                            baseUrl:
                              c.base_url ?? "https://api.x.ai/v1",
                            chatModel:
                              d.providerKind === "xai_grok_build" &&
                              d.chatModel.trim()
                                ? d.chatModel
                                : d.chatModel.trim() || "grok-3",
                            localOnly: false,
                            hasApiKey:
                              c.credentials_present || d.hasApiKey,
                            ollamaReachable: null,
                            remoteReachable: null,
                          }));
                        },
                      );
                      return;
                    }
                    setDraft((d) => ({
                      ...d,
                      providerKind: kind,
                      providerLabel: c.label,
                      baseUrl:
                        c.base_url ??
                        (kind === "ollama"
                          ? "http://127.0.0.1:11434"
                          : kind === "anthropic"
                            ? "https://api.anthropic.com"
                            : d.baseUrl),
                      localOnly: kind === "ollama",
                      hasApiKey: c.credentials_present || d.hasApiKey,
                      chatModel:
                        kind === "ollama" && !d.chatModel.trim()
                          ? "mistral"
                          : kind === "anthropic" && !d.chatModel.trim()
                            ? "claude-sonnet-4-20250514"
                            : d.chatModel,
                      ollamaReachable: null,
                      remoteReachable: null,
                    }));
                  }}
                >
                  {inUse ? "Selected" : "Use"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <span className="field__hint">
        Candidates are discovered on this machine. Grok requires an
        explicit Use + Save opt-in before session credentials are sent
        to api.x.ai.
      </span>
    </div>
  ) : null}
  <SelectField
    id={`${baseId}-kind`}
    label="Provider"
    value={draft.providerKind}
    onChange={(e) => {
      const kind = e.target.value as AppSetupState["providerKind"];
      setDraft((d) => ({
        ...d,
        providerKind: kind,
        providerLabel:
          kind === "ollama"
            ? "Ollama (local)"
            : kind === "openai_compatible"
              ? "OpenAI-compatible gateway"
              : kind === "anthropic"
                ? "Anthropic"
                : kind === "xai_grok_build"
                  ? "Grok Build session"
                  : null,
        ollamaReachable: null,
        remoteReachable: null,
        localOnly: kind === "ollama",
        baseUrl:
          kind === "ollama"
            ? "http://127.0.0.1:11434"
            : kind === "xai_grok_build"
              ? "https://api.x.ai/v1"
              : kind === "anthropic"
                ? "https://api.anthropic.com"
                : d.baseUrl,
        chatModel:
          kind === "xai_grok_build" && !d.chatModel.trim()
            ? "grok-3"
            : kind === "anthropic" && !d.chatModel.trim()
              ? "claude-sonnet-4-20250514"
              : d.chatModel,
      }));
    }}
  >
    <option value="none">Select…</option>
    <option value="ollama">Ollama (local)</option>
    <option value="openai_compatible">OpenAI-compatible gateway</option>
    <option value="anthropic">Anthropic</option>
    <option value="xai_grok_build">Grok Build session</option>
  </SelectField>

  {draft.providerKind === "openai_compatible" ||
  draft.providerKind === "anthropic" ? (
    <>
      <TextField
        id={`${baseId}-url`}
        label="Base URL"
        hint={
          draft.providerKind === "anthropic"
            ? "Default https://api.anthropic.com — custom base only if using a proxy."
            : "Paste origin or …/v1/models — we normalize and probe."
        }
        value={draft.baseUrl}
        error={remoteUrlCheck.error ?? urlError}
        ok={remoteUrlCheck.ok}
        pending={remoteUrlCheck.pending}
        onChange={(e) =>
          setDraft((d) => ({
            ...d,
            baseUrl: e.target.value,
            remoteReachable: null,
          }))
        }
        placeholder={
          draft.providerKind === "anthropic"
            ? "https://api.anthropic.com"
            : "https://gateway.example.com/v1"
        }
      />
      <SecretField
        id={`${baseId}-key`}
        label="API key"
        help={{
          label: "API key storage",
          title: "API key",
          body: (
            <>
              <p>
                {draft.providerKind === "anthropic"
                  ? "Required for Anthropic Messages API. ContextDesk stores the key in the OS keychain — never in local config files or chat history."
                  : "Required for most OpenAI-compatible gateways. ContextDesk stores the key in the OS keychain — never in local config files or chat history."}
              </p>
              <ol>
                <li>
                  {draft.providerKind === "anthropic"
                    ? "Paste the key from the Anthropic Console."
                    : "Paste the key from your provider dashboard."}
                </li>
                <li>
                  Click <strong>Save</strong> so it is written to
                  the keychain.
                </li>
                <li>
                  Leave blank later to keep the existing key;
                  paste a new value only to replace.
                </li>
              </ol>
            </>
          ),
        }}
        value={apiKeyDraft}
        error={
          !draft.hasApiKey && !apiKeyDraft.trim()
            ? draft.providerKind === "anthropic"
              ? "Required for Anthropic."
              : "Required for remote gateways."
            : null
        }
        ok={
          draft.hasApiKey && !apiKeyDraft
            ? "Key in OS keychain (enter a new value to replace)"
            : apiKeyDraft.trim()
              ? "Will store in OS keychain on Save"
              : null
        }
        onChange={(e) => {
          setApiKeyDraft(e.target.value);
          setDraft((d) => ({
            ...d,
            remoteReachable: null,
          }));
        }}
        placeholder={
          draft.hasApiKey
            ? "•••••••• (stored securely)"
            : "Paste key — stored in keychain on Save"
        }
        autoComplete="off"
      />
    </>
  ) : null}

  {draft.providerKind === "xai_grok_build" ? (
    <>
      <TextField
        id={`${baseId}-grok-url`}
        label="API base (api.x.ai only)"
        hint="Session credentials only against api.x.ai after opt-in Save."
        help={{
          label: "Grok Build session",
          title: "Grok Build setup",
          body: (
            <>
              <p>
                Uses your local Grok Build session (
                <code>~/.grok/auth.json</code>) after you opt in
                with Save — not a pasted API key.
              </p>
              <ol>
                <li>Sign in with Grok Build / CLI on this machine.</li>
                <li>
                  Choose <strong>Grok Build session</strong> and
                  leave the base as <code>https://api.x.ai/v1</code>.
                </li>
                <li>
                  Click <strong>Save</strong> so ContextDesk may
                  use the session for chat.
                </li>
              </ol>
            </>
          ),
        }}
        value={draft.baseUrl}
        onChange={(e) =>
          setDraft((d) => ({
            ...d,
            baseUrl: e.target.value,
            remoteReachable: null,
          }))
        }
        placeholder="https://api.x.ai/v1"
      />
      <p className="field__hint" role="status">
        {draft.hasApiKey
          ? "Grok session file detected — Save to activate this profile."
          : "No session file — run `grok login` in a terminal, then re-open Settings."}
      </p>
    </>
  ) : null}

  {draft.providerKind === "ollama" ? (
    <TextField
      id={`${baseId}-ollama-url`}
      label="Ollama URL"
      value={draft.baseUrl}
      onChange={(e) =>
        setDraft((d) => ({
          ...d,
          baseUrl: e.target.value,
          ollamaReachable: null,
        }))
      }
      placeholder="http://127.0.0.1:11434"
    />
  ) : null}

  {draft.providerKind !== "none" ? (
    <TextField
      id={`${baseId}-model`}
      label="Chat model"
      value={draft.chatModel}
      error={!draft.chatModel.trim() ? "Model id is required." : null}
      onChange={(e) =>
        setDraft((d) => ({ ...d, chatModel: e.target.value }))
      }
      placeholder={
        draft.providerKind === "ollama"
          ? "mistral"
          : draft.providerKind === "xai_grok_build"
            ? "grok-3"
            : draft.providerKind === "anthropic"
              ? "claude-sonnet-4-20250514"
              : "provider/model"
      }
    />
  ) : null}

  {draft.providerKind !== "none" &&
  draft.providerKind !== "xai_grok_build" ? (
    <ToggleField
      id={`${baseId}-local-only`}
      label="Local-only profile"
      hint="Refuse non-loopback base URLs (recommended for Ollama). Remote gateways need this off."
      checked={
        draft.localOnly ?? draft.providerKind === "ollama"
      }
      onChange={(localOnly) =>
        setDraft((d) => ({ ...d, localOnly }))
      }
    />
  ) : null}

  <div className="field-row">
    <button
      type="button"
      className="btn btn--ghost"
      onClick={() => void recheck()}
      disabled={checking || draft.providerKind === "none"}
    >
      {checking ? "Testing…" : "Test connection"}
    </button>
  </div>
  {probeNote ? (
    <p className="field__hint" role="status">
      {probeNote}
    </p>
  ) : null}
</div>

  );
}
