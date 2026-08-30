export interface InvestigationRuntimeCapabilities {
  canRead: boolean;
  canCreate: boolean;
  canUpload: boolean;
  canManageLifecycle: boolean;
}

/**
 * Project server capability strings into the only affordances Runtime V1
 * strategies may consume. Static read-only mode suppresses every mutation,
 * but never invents or removes the underlying read capability.
 */
export function projectInvestigationCapabilities(
  capabilities: readonly string[],
  readOnly: boolean,
): InvestigationRuntimeCapabilities {
  const effective = new Set(capabilities);
  const canMutate = !readOnly;
  return {
    canRead: effective.has("investigation:read"),
    canCreate: canMutate && effective.has("investigation:write"),
    canUpload: canMutate && effective.has("investigation:write"),
    canManageLifecycle: canMutate && effective.has("run:strategies"),
  };
}
