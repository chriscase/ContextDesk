/**
 * Guided AI setup wizard (#311 follow-up).
 * Path → give us something to look at → narrow options → pick model → apply draft.
 * Mirrors TriageTool’s discover flow using host list_models_for_draft (no browser CORS).
 */
import { useCallback, useState } from "react";
import {
  hostListModelsForDraft,
  hostProbeAiGateway,
  type LocalCandidateDto,
} from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import { SecretField, SelectField, TextField } from "../forms";

type WizardStep = "start" | "configure" | "results";
type WizardPath = "ollama" | "grok" | "gateway";

export type DiscoveredOption = {
  kind: AppSetupState["providerKind"];
  label: string;
  baseUrl: string;
  models: string[];
  note?: string;
};

type Props = {
  baseId: string;
  draft: AppSetupState;
  setDraft: React.Dispatch<React.SetStateAction<AppSetupState>>;
  apiKeyDraft: string;
  setApiKeyDraft: (v: string) => void;
  candidates: LocalCandidateDto[];
  onApplied?: () => void;
  onOpenAdvanced?: () => void;
};

const GATEWAY_PRESETS: { id: string; label: string; base: string; hint: string }[] = [
  {
    id: "blank",
    label: "Corporate / private",
    base: "",
    hint: "Paste your gateway base from docs",
  },
  {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    hint: "api.openai.com",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    base: "https://api.anthropic.com",
    hint: "api.anthropic.com",
  },
];

function preferChatModels(ids: string[]): string[] {
  const score = (id: string) => {
    const l = id.toLowerCase();
    if (l.includes("embed") || l.includes("whisper") || l.includes("tts")) return -10;
    if (l.includes("grok-3") || l.includes("mistral") || l.includes("sonnet")) return 5;
    if (l.includes("gpt-4") || l.includes("claude") || l.includes("grok")) return 4;
    if (l.includes("mini") || l.includes("haiku")) return 2;
    return 1;
  };
  return [...ids].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function AiSetupWizard({
  baseId,
  draft,
  setDraft,
  setApiKeyDraft,
  candidates,
  onApplied,
  onOpenAdvanced,
}: Props) {
  // Prefill from saved draft so users do not re-paste gateway URL each session.
  const initialPath = ((): WizardPath => {
    if (draft.providerKind === "xai_grok_build") return "grok";
    if (draft.providerKind === "openai_compatible" || draft.providerKind === "anthropic")
      return "gateway";
    return "ollama";
  })();
  const [step, setStep] = useState<WizardStep>("start");
  const [path, setPath] = useState<WizardPath>(initialPath);
  const [probeUrl, setProbeUrl] = useState(() => {
    if (
      draft.providerKind === "openai_compatible" ||
      draft.providerKind === "anthropic" ||
      draft.providerKind === "ollama"
    ) {
      return draft.baseUrl || "http://127.0.0.1:11434";
    }
    if (draft.providerKind === "xai_grok_build") {
      return draft.baseUrl || "https://api.x.ai/v1";
    }
    return "http://127.0.0.1:11434";
  });
  const [probeKey, setProbeKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [options, setOptions] = useState<DiscoveredOption[]>([]);
  const [pickedKind, setPickedKind] = useState<AppSetupState["providerKind"]>("none");
  const [pickedModel, setPickedModel] = useState("");

  const grokCandidate = candidates.find(
    (c) => c.kind === "xai_grok_build" || c.id.includes("grok"),
  );
  const ollamaCandidate = candidates.find((c) => c.kind === "ollama");

  const choosePath = (p: WizardPath) => {
    setPath(p);
    setErrors([]);
    setNotes([]);
    setOptions([]);
    if (p === "ollama") {
      setProbeUrl(
        draft.providerKind === "ollama" && draft.baseUrl
          ? draft.baseUrl
          : (ollamaCandidate?.base_url ?? "http://127.0.0.1:11434"),
      );
      setProbeKey("");
    } else if (p === "grok") {
      setProbeUrl(
        draft.providerKind === "xai_grok_build" && draft.baseUrl
          ? draft.baseUrl
          : "https://api.x.ai/v1",
      );
      setProbeKey("");
    } else {
      // Gateway: keep last saved remote URL when available
      setProbeUrl(
        draft.providerKind === "openai_compatible" ||
          draft.providerKind === "anthropic"
          ? draft.baseUrl
          : "",
      );
      // Key stays blank — host reuses keychain when draft is empty
      setProbeKey("");
    }
    setStep("configure");
  };

  const runDiscover = useCallback(async () => {
    setBusy(true);
    setErrors([]);
    setNotes([]);
    setOptions([]);
    try {
      const found: DiscoveredOption[] = [];
      const noteBuf: string[] = [];
      const errBuf: string[] = [];

      if (path === "ollama") {
        const base = probeUrl.trim() || "http://127.0.0.1:11434";
        // Same native probe path as TriageTool (plain HTTP, /api/tags).
        const result = await hostProbeAiGateway({
          baseUrl: base,
          apiKey: null,
          probeLocal: true,
        });
        if (!result) {
          errBuf.push("Host probe unavailable (need desktop Tauri app).");
        } else {
          noteBuf.push(...result.notes);
          errBuf.push(...result.errors);
          const models = preferChatModels(
            (result.chat_candidates.length
              ? result.chat_candidates
              : result.models.filter((m) => m.kind !== "embedding")
            ).map((m) => m.id),
          );
          if (models.length) {
            found.push({
              kind: "ollama",
              label: "Ollama (local)",
              baseUrl: result.effective_base_url || base,
              models,
              note: `${models.length} local model(s)`,
            });
          } else if (!result.local_ollama_reachable) {
            errBuf.push(
              `Ollama not reachable. Start it and try \`ollama pull mistral\`.`,
            );
          }
        }
      } else if (path === "grok") {
        const base = probeUrl.trim() || "https://api.x.ai/v1";
        const hasSession =
          grokCandidate?.credentials_present || draft.hasApiKey;
        if (!hasSession && !grokCandidate) {
          noteBuf.push(
            "Looking for ~/.grok/auth.json — run `grok login` if discovery finds nothing.",
          );
        }
        const models = preferChatModels(
          await hostListModelsForDraft({
            kind: "xai_grok_build",
            baseUrl: base,
            localOnly: false,
          }),
        );
        if (models.length) {
          found.push({
            kind: "xai_grok_build",
            label: "Grok Build session",
            baseUrl: base,
            models,
            note: hasSession
              ? "Session file present — Save after apply to activate."
              : "Built-in catalog (confirm session with Save).",
          });
          noteBuf.push("Grok path ready — tokens stay in the host, never the webview.");
        } else {
          errBuf.push(
            "Could not list Grok models. Run `grok login`, then Discover again.",
          );
        }
      } else {
        // Gateway: TriageTool-parity probe (multi-path + Bearer + x-api-key).
        // Empty key → host reuses keychain for saved openai/anthropic profiles.
        const raw = probeUrl.trim();
        if (!raw) {
          errBuf.push(
            "Paste a base URL (e.g. https://…/v1 or …/llm/v1/models).",
          );
          setErrors(errBuf);
          return;
        }
        const key = probeKey.trim() || null;
        if (!key && draft.hasApiKey) {
          noteBuf.push(
            "Using API key already in the OS keychain (leave blank to reuse).",
          );
        }
        const result = await hostProbeAiGateway({
          baseUrl: raw,
          apiKey: key,
          // Do not mix local Ollama models into a corporate gateway probe.
          probeLocal: false,
        });
        if (!result) {
          errBuf.push("Host probe unavailable (need desktop Tauri app).");
        } else {
          noteBuf.push(...result.notes);
          errBuf.push(...result.errors.slice(0, 6));
          const chatIds = preferChatModels(
            (result.chat_candidates.length
              ? result.chat_candidates
              : result.models.filter((m) => m.kind !== "embedding")
            ).map((m) => m.id),
          );
          // Prefer full catalog when chat_candidates is only a sorted subset of "known" names.
          // Unknown enterprise ids are still chat-capable — use full non-embed list if larger.
          const fullIds = preferChatModels(
            result.models
              .filter((m) => m.kind !== "embedding")
              .map((m) => m.id),
          );
          const models =
            fullIds.length > chatIds.length ? fullIds : chatIds;

          if (result.ok && models.length) {
            const flavor = result.flavor;
            const kind: AppSetupState["providerKind"] =
              flavor === "anthropic"
                ? "anthropic"
                : flavor === "ollama"
                  ? "ollama"
                  : "openai_compatible";
            const label =
              kind === "anthropic"
                ? "Anthropic Messages API"
                : kind === "ollama"
                  ? "Ollama"
                  : "OpenAI-compatible gateway";
            found.push({
              kind,
              label,
              baseUrl: result.effective_base_url || raw,
              models,
              note: `${models.length} model(s) · ${result.effective_base_url || raw}`,
            });
            // If probe classified openai but also looks anthropic-heavy, offer both.
            if (
              kind === "openai_compatible" &&
              models.filter((m) => /claude/i.test(m)).length >
                models.length / 2
            ) {
              found.push({
                kind: "anthropic",
                label: "Anthropic Messages API (alternate)",
                baseUrl: result.effective_base_url || raw,
                models,
                note: "Catalog looks Claude-heavy — try Anthropic if chat fails.",
              });
            }
          } else if (!result.ok) {
            errBuf.push(
              key || draft.hasApiKey
                ? "Gateway did not return a model list. Check URL path, key, and VPN."
                : "No models listed. Paste the gateway API key (or Save one first) and Discover again.",
            );
          }
        }
      }

      setNotes(noteBuf);
      setErrors(errBuf);
      setOptions(found);
      if (found.length) {
        const first = found[0]!;
        setPickedKind(first.kind);
        setPickedModel(
          draft.chatModel && first.models.includes(draft.chatModel)
            ? draft.chatModel
            : (first.models[0] ?? ""),
        );
        setStep("results");
      }
    } finally {
      setBusy(false);
    }
  }, [path, probeUrl, probeKey, grokCandidate, draft.hasApiKey, draft.chatModel]);

  const activeOption =
    options.find((o) => o.kind === pickedKind) ?? options[0] ?? null;

  const applyToDraft = () => {
    if (!activeOption || !pickedModel.trim()) return;
    const kind = activeOption.kind;
    setDraft((d) => ({
      ...d,
      providerKind: kind,
      providerLabel: activeOption.label,
      baseUrl: activeOption.baseUrl,
      chatModel: pickedModel.trim(),
      localOnly: kind === "ollama",
      ollamaReachable: kind === "ollama" ? true : d.ollamaReachable,
      remoteReachable:
        kind === "openai_compatible" || kind === "anthropic"
          ? true
          : d.remoteReachable,
      hasApiKey:
        kind === "xai_grok_build"
          ? d.hasApiKey || Boolean(grokCandidate?.credentials_present)
          : kind === "ollama"
            ? d.hasApiKey
            : d.hasApiKey || Boolean(probeKey.trim()),
    }));
    if (probeKey.trim() && kind !== "ollama" && kind !== "xai_grok_build") {
      setApiKeyDraft(probeKey.trim());
    }
    onApplied?.();
  };

  return (
    <div className="ai-wizard">
      <p className="section-lead">
        Setup wizard — tell us what you have (local Ollama, Grok Build, or a
        gateway URL). We probe and narrow chat models; click{" "}
        <strong>Apply to draft</strong>, then <strong>Save</strong> in Settings
        to persist.
      </p>

      <div className="ai-wizard__mode-row">
        <span className="field__hint">
          Step:{" "}
          {step === "start"
            ? "1 · Choose path"
            : step === "configure"
              ? "2 · What should we look at?"
              : "3 · Pick a stack & model"}
        </span>
        {onOpenAdvanced ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onOpenAdvanced}
          >
            Advanced form
          </button>
        ) : null}
      </div>

      {step === "start" ? (
        <div className="ai-wizard__paths">
          <button
            type="button"
            className="ai-wizard__path"
            data-primary="true"
            onClick={() => choosePath("ollama")}
          >
            <span className="ai-wizard__path-kicker">Local</span>
            <span className="ai-wizard__path-label">This computer (Ollama)</span>
            <span className="ai-wizard__path-hint">
              Free, private, offline-capable. We list models already pulled.
              {ollamaCandidate ? " · Candidate detected" : ""}
            </span>
          </button>
          <button
            type="button"
            className="ai-wizard__path"
            onClick={() => choosePath("grok")}
          >
            <span className="ai-wizard__path-kicker">Session</span>
            <span className="ai-wizard__path-label">Grok Build account</span>
            <span className="ai-wizard__path-hint">
              Reuse ~/.grok/auth.json after opt-in Save — no pasted API key.
              {grokCandidate?.credentials_present
                ? " · Session file detected"
                : " · Run grok login if needed"}
            </span>
          </button>
          <button
            type="button"
            className="ai-wizard__path"
            onClick={() => choosePath("gateway")}
          >
            <span className="ai-wizard__path-kicker">Remote</span>
            <span className="ai-wizard__path-label">Company or cloud gateway</span>
            <span className="ai-wizard__path-hint">
              Paste a base URL (+ key). We try OpenAI-compatible and Anthropic
              shapes and list models.
            </span>
          </button>
        </div>
      ) : null}

      {step === "configure" ? (
        <div className="ai-wizard__config">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setStep("start");
              setOptions([]);
            }}
          >
            ← Back
          </button>

          {path === "ollama" ? (
            <>
              <p className="field__hint">
                We query <code>/api/tags</code> on your Ollama base. Need models?{" "}
                <code>ollama pull mistral</code>
              </p>
              <TextField
                id={`${baseId}-wiz-ollama-url`}
                label="Ollama URL"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                placeholder="http://127.0.0.1:11434"
              />
            </>
          ) : null}

          {path === "grok" ? (
            <>
              <p className="field__hint">
                Uses your Grok Build / CLI session on this machine. Base must stay
                on <code>api.x.ai</code>.
              </p>
              <TextField
                id={`${baseId}-wiz-grok-url`}
                label="API base"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                placeholder="https://api.x.ai/v1"
              />
            </>
          ) : null}

          {path === "gateway" ? (
            <>
              <p className="field__hint">
                Paste the gateway base from docs (e.g.{" "}
                <code>https://…/v1</code>). Full <code>…/v1/models</code> also
                works — we normalize.
              </p>
              <div className="ai-wizard__presets">
                {GATEWAY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn btn--ghost btn--sm"
                    title={p.hint}
                    onClick={() => p.base && setProbeUrl(p.base)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <TextField
                id={`${baseId}-wiz-gw-url`}
                label="Base URL"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                placeholder="https://gateway.example.com/v1"
              />
              <SecretField
                id={`${baseId}-wiz-gw-key`}
                label="API key (if required)"
                value={probeKey}
                onChange={(e) => setProbeKey(e.target.value)}
                placeholder={
                  draft.hasApiKey
                    ? "•••• keychain — leave blank to reuse"
                    : "Paste key for discovery"
                }
                ok={
                  draft.hasApiKey && !probeKey.trim()
                    ? "Will reuse OS keychain key for Discover and chat"
                    : null
                }
                hint="Leave blank if you already Saved a key — we load it from the keychain. New paste replaces on Settings Save."
              />
            </>
          ) : null}

          <div className="field-row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void runDiscover()}
            >
              {busy ? "Discovering…" : "Discover options"}
            </button>
          </div>
          {errors.map((e) => (
            <p key={e} className="field__error" role="alert">
              {e}
            </p>
          ))}
          {notes.map((n) => (
            <p key={n} className="field__hint" role="status">
              {n}
            </p>
          ))}
        </div>
      ) : null}

      {step === "results" ? (
        <div className="ai-wizard__results">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setStep("configure")}
          >
            ← Adjust URL / key
          </button>

          {notes.map((n) => (
            <p key={n} className="field__hint" role="status">
              {n}
            </p>
          ))}
          {errors.map((e) => (
            <p key={e} className="field__error" role="alert">
              {e}
            </p>
          ))}

          {options.length > 1 ? (
            <div className="field">
              <span className="field__label">Detected stacks</span>
              <div className="ai-wizard__options">
                {options.map((o) => (
                  <button
                    key={o.kind}
                    type="button"
                    className="ai-wizard__option"
                    data-selected={pickedKind === o.kind ? "true" : "false"}
                    onClick={() => {
                      setPickedKind(o.kind);
                      setPickedModel(o.models[0] ?? "");
                    }}
                  >
                    <span className="ai-wizard__option-label">{o.label}</span>
                    <span className="ai-wizard__option-meta">
                      {o.note ?? `${o.models.length} models`} · {o.baseUrl}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : activeOption ? (
            <p className="field__ok" role="status">
              {activeOption.label} — {activeOption.note}
            </p>
          ) : null}

          {activeOption && activeOption.models.length > 0 ? (
            <SelectField
              id={`${baseId}-wiz-model`}
              label="Chat model"
              hint="Sorted toward likely chat models; you can change later in Advanced."
              value={
                activeOption.models.includes(pickedModel)
                  ? pickedModel
                  : activeOption.models[0]
              }
              onChange={(e) => setPickedModel(e.target.value)}
            >
              {activeOption.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </SelectField>
          ) : null}

          <div className="field-row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!activeOption || !pickedModel.trim()}
              onClick={applyToDraft}
            >
              Apply to draft
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void runDiscover()}
            >
              {busy ? "…" : "Re-discover"}
            </button>
          </div>
          <p className="field__hint">
            Apply fills Settings draft only. Use the footer <strong>Save</strong>{" "}
            to write the profile (and keychain) — same as the rest of Settings.
          </p>
        </div>
      ) : null}
    </div>
  );
}
