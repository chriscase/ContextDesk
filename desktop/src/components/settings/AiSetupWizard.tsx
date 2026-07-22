/**
 * Guided AI setup wizard (#311 follow-up).
 * Path → give us something to look at → narrow options → pick model → apply draft.
 * Mirrors TriageTool’s discover flow using host list_models_for_draft (no browser CORS).
 */
import { useCallback, useState } from "react";
import {
  hostCheckOllama,
  hostListModelsForDraft,
  hostProbeUrl,
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
  const [step, setStep] = useState<WizardStep>("start");
  const [path, setPath] = useState<WizardPath>("ollama");
  const [probeUrl, setProbeUrl] = useState("http://127.0.0.1:11434");
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
      setProbeUrl(ollamaCandidate?.base_url ?? "http://127.0.0.1:11434");
      setProbeKey("");
    } else if (p === "grok") {
      setProbeUrl("https://api.x.ai/v1");
      setProbeKey("");
    } else {
      setProbeUrl("");
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
        const reachable = await hostCheckOllama(base);
        if (reachable === false) {
          errBuf.push(
            `Ollama not reachable at ${base}. Start it and try \`ollama pull mistral\`.`,
          );
        } else if (reachable === null) {
          noteBuf.push("Could not probe Ollama (host unavailable). Trying model list anyway…");
        } else {
          noteBuf.push(`Ollama reachable at ${base}.`);
        }
        const models = preferChatModels(
          await hostListModelsForDraft({
            kind: "ollama",
            baseUrl: base,
            localOnly: true,
          }),
        );
        if (models.length) {
          found.push({
            kind: "ollama",
            label: "Ollama (local)",
            baseUrl: base,
            models,
            note: `${models.length} local model(s)`,
          });
        } else if (reachable !== false) {
          errBuf.push("Ollama responded but listed no chat models.");
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
        // Gateway: paste URL (+ optional key). Probe shape, then try OpenAI + Anthropic.
        const raw = probeUrl.trim();
        if (!raw) {
          errBuf.push("Paste a base URL to look at (e.g. https://…/v1 or …/v1/models).");
          setErrors(errBuf);
          return;
        }
        const probe = await hostProbeUrl(raw, false);
        if (probe.ok) {
          noteBuf.push(
            `URL ok · effective ${probe.effective_base} · ${probe.candidates.length} shape(s)`,
          );
        } else if (probe.error) {
          errBuf.push(probe.error);
        }
        const base = probe.effective_base || raw;
        const key = probeKey.trim() || null;

        const [openaiModels, anthropicModels] = await Promise.all([
          hostListModelsForDraft({
            kind: "openai_compatible",
            baseUrl: base,
            apiKey: key,
            localOnly: false,
          }),
          hostListModelsForDraft({
            kind: "anthropic",
            baseUrl: base,
            apiKey: key,
            localOnly: false,
          }),
        ]);

        const oai = preferChatModels(openaiModels);
        const anth = preferChatModels(anthropicModels);

        // Heuristic: host / catalog leans Anthropic?
        const baseLooksAnthropic = /anthropic/i.test(base);
        const mostlyClaude =
          anth.length > 0 &&
          anth.filter((m) => /claude/i.test(m)).length >= Math.ceil(anth.length / 2);

        if (oai.length) {
          found.push({
            kind: "openai_compatible",
            label: "OpenAI-compatible gateway",
            baseUrl: base,
            models: oai,
            note: `${oai.length} model(s) via /v1/models`,
          });
        }
        if (anth.length) {
          found.push({
            kind: "anthropic",
            label: "Anthropic Messages API",
            baseUrl: base.endsWith("/v1")
              ? base.replace(/\/v1$/, "")
              : base,
            models: anth,
            note: `${anth.length} model(s) via Anthropic /v1/models`,
          });
        }

        if (!found.length) {
          errBuf.push(
            key
              ? "No models listed for this URL+key as OpenAI-compatible or Anthropic. Check the base path and key."
              : "No models listed. Many gateways need an API key — paste one and Discover again.",
          );
        } else if (found.length > 1) {
          noteBuf.push(
            baseLooksAnthropic || mostlyClaude
              ? "Both flavors returned models — Anthropic-looking catalog ranked higher if you pick it."
              : "Both OpenAI-compatible and Anthropic responded — pick the stack that matches your gateway.",
          );
          // Put preferred first
          if (baseLooksAnthropic || mostlyClaude) {
            found.sort((a, b) =>
              a.kind === "anthropic" ? -1 : b.kind === "anthropic" ? 1 : 0,
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
        setPickedModel(first.models[0] ?? "");
        setStep("results");
      }
    } finally {
      setBusy(false);
    }
  }, [
    path,
    probeUrl,
    probeKey,
    grokCandidate,
    draft.hasApiKey,
    ollamaCandidate,
  ]);

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
                    ? "•••• (leave blank to use keychain after Save)"
                    : "Paste key for discovery"
                }
                hint="Used only to list models and stored in the OS keychain on Settings Save — never in the webview."
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
