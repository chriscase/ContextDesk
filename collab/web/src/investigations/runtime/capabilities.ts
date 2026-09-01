export interface InvestigationRuntimeCapabilities {
  canRead: boolean;
  canReadPrivate: boolean;
  canCreate: boolean;
  canUpload: boolean;
  canContribute: boolean;
  canEditSituation: boolean;
  canManageLifecycle: boolean;
}

/**
 * Project server capability strings into the only affordances Runtime V1
 * strategies may consume. Static read-only mode suppresses every mutation,
 * but never invents or removes the underlying read capability.
 *
 * `canContribute` and `canEditSituation` are projected separately from
 * `canCreate` and `canUpload` even though the server currently gates all four
 * on `investigation:write`. A strategy asks for the affordance it needs, so a
 * later split of the write capability changes this projection alone.
 *
 * `canReadPrivate` is exact `evidence:private:read`. It is read authority, so
 * static read-only mode does not clear it, and no write, run, or role implies
 * it.
 */
export function projectInvestigationCapabilities(
  capabilities: readonly string[],
  readOnly: boolean,
): InvestigationRuntimeCapabilities {
  const effective = new Set(capabilities);
  const canMutate = !readOnly;
  return {
    canRead: effective.has("investigation:read"),
    canReadPrivate: effective.has("evidence:private:read"),
    canCreate: canMutate && effective.has("investigation:write"),
    canUpload: canMutate && effective.has("investigation:write"),
    canContribute: canMutate && effective.has("investigation:write"),
    canEditSituation: canMutate && effective.has("investigation:write"),
    canManageLifecycle: canMutate && effective.has("run:strategies"),
  };
}
