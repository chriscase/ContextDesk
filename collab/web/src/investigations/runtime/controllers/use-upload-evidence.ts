import type {
  ArtifactKind,
  ArtifactV1,
  ContributionV1,
  EvidenceUploadSuccessV1,
  PrivacyClass,
} from "@cd-collab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationGateway } from "../gateway.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { prepareEvidenceUpload } from "./file-base64.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";

interface UploadScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

export interface UploadEvidenceCommand {
  readonly file: Blob | null | undefined;
  readonly summary: string;
  readonly kind?: ArtifactKind;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
}

export interface UseUploadEvidenceOptions {
  readonly gateway: InvestigationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly canUpload: boolean;
  readonly readOnly: boolean;
  /** Publish only the authoritative upload envelope members. Must not throw. */
  readonly onUploaded: (artifact: ArtifactV1, summary: ContributionV1) => void;
  /** Refresh evidence for this exact investigation. Must not throw. */
  readonly onRefreshEvidence: (investigationId: string) => void;
  /** Refresh collection metadata/counts after the authoritative upload. */
  readonly onRefreshInvestigations: () => void;
}

export interface UploadEvidenceController {
  readonly state: MutationState<EvidenceUploadSuccessV1>;
  readonly upload: (
    command: UploadEvidenceCommand,
  ) => Promise<CommandOutcome<EvidenceUploadSuccessV1>>;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

/** Race-safe browser-file preparation and evidence upload for the active case. */
export function useUploadEvidence(
  options: UseUploadEvidenceOptions,
): UploadEvidenceController {
  const [state, setState] = useState<MutationState<EvidenceUploadSuccessV1>>({ status: "idle" });
  const slotRef = useRef(new RequestSlot<UploadScope>());
  const activeRef = useRef<RequestToken<UploadScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setState({ status: "idle" });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      slotRef.current.dispose();
      activeRef.current = null;
    };
  }, []);

  useEffect(() => {
    invalidate();
    return invalidate;
  }, [
    options.identityKey,
    options.authorityKey,
    options.investigationId,
    options.canUpload,
    options.readOnly,
    invalidate,
  ]);

  const upload = useCallback(async (
    command: UploadEvidenceCommand,
  ): Promise<CommandOutcome<EvidenceUploadSuccessV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };

    const start = latestRef.current;
    if (start.readOnly || !start.canUpload || start.investigationId === null) {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: UploadScope = {
      identityKey: start.identityKey,
      authorityKey: start.authorityKey,
      investigationId: start.investigationId,
    };
    const token = slotRef.current.begin(scope);
    activeRef.current = token;
    setState({ status: "running" });

    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeRef.current === token
        && slotRef.current.isCurrent(token)
        && latest.identityKey === scope.identityKey
        && latest.authorityKey === scope.authorityKey
        && latest.investigationId === scope.investigationId
        && latest.canUpload
        && !latest.readOnly;
    };

    try {
      const prepared = await prepareEvidenceUpload(command.file, command.summary, {
        ...(command.kind === undefined ? {} : { kind: command.kind }),
        ...(command.privacyClass === undefined ? {} : { privacyClass: command.privacyClass }),
        ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
        ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
      });
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      if (prepared.status !== "succeeded") {
        if (prepared.status === "failed") {
          setState({ status: "failed", error: prepared.error });
        }
        return prepared;
      }

      const result = await start.gateway.uploadEvidence(
        scope.investigationId,
        prepared.value,
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      if (!result.ok) {
        const outcome: CommandOutcome<EvidenceUploadSuccessV1> = {
          status: "failed",
          error: result.error,
        };
        setState({ status: "failed", error: result.error });
        return outcome;
      }

      latestRef.current.onUploaded(result.value.artifact, result.value.summary);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshEvidence(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshInvestigations();
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      setState({ status: "succeeded", value: result.value });
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const outcome = unexpected();
      setState({ status: "failed", error: outcome.error });
      return outcome;
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, []);

  return { state, upload };
}
