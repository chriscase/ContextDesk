import type { RuntimeFailure } from "./errors.js";
import type { ResourceState } from "./types.js";

/** A presentation-safe projection that keeps refresh state separate from data. */
export type ResourceView<T> =
  | { availability: "idle" }
  | { availability: "loading" }
  | {
      availability: "available";
      value: T;
      refresh: "settled" | "loading";
    }
  | {
      availability: "available";
      value: T;
      refresh: "failed";
      refreshError: RuntimeFailure;
    }
  | { availability: "unavailable"; error: RuntimeFailure };

/**
 * Preserve a previously published value during refresh and refresh failure.
 * A ready value is available even when it is an empty array or empty object.
 */
export function selectResourceView<T>(state: ResourceState<T>): ResourceView<T> {
  switch (state.status) {
    case "idle":
      return { availability: "idle" };
    case "loading":
      return state.previous === undefined
        ? { availability: "loading" }
        : {
            availability: "available",
            value: state.previous,
            refresh: "loading",
          };
    case "ready":
      return {
        availability: "available",
        value: state.value,
        refresh: "settled",
      };
    case "failed":
      return state.previous === undefined
        ? { availability: "unavailable", error: state.error }
        : {
            availability: "available",
            value: state.previous,
            refresh: "failed",
            refreshError: state.error,
          };
  }
}

export interface EvidenceWithAnnotation<TEvidence, TAnnotation> {
  evidence: TEvidence;
  annotation: TAnnotation | null;
}

export interface EvidenceInventoryView<TEvidence, TAnnotation> {
  inventory: ResourceView<readonly EvidenceWithAnnotation<TEvidence, TAnnotation>[]>;
  annotations: ResourceView<readonly TAnnotation[]>;
}

interface EvidenceAnnotationLink {
  summaryContributionId?: string | null;
}

interface AnnotationIdentity {
  id: string;
}

function availableValue<T>(view: ResourceView<T>): T | undefined {
  return view.availability === "available" ? view.value : undefined;
}

/**
 * Join evidence to its summary contribution without making annotations a
 * prerequisite for showing the evidence inventory. Annotation load state is
 * returned alongside the inventory so a strategy can report that partial
 * failure honestly and offer the appropriate retry.
 */
export function selectEvidenceInventory<
  TEvidence extends EvidenceAnnotationLink,
  TAnnotation extends AnnotationIdentity,
>(
  evidenceState: ResourceState<readonly TEvidence[]>,
  annotationState: ResourceState<readonly TAnnotation[]>,
): EvidenceInventoryView<TEvidence, TAnnotation> {
  const evidence = selectResourceView(evidenceState);
  const annotations = selectResourceView(annotationState);

  if (evidence.availability !== "available") {
    return { inventory: evidence, annotations };
  }

  const annotationById = new Map(
    (availableValue(annotations) ?? []).map((annotation) => [annotation.id, annotation]),
  );
  const value = evidence.value.map((item) => ({
    evidence: item,
    annotation: item.summaryContributionId
      ? annotationById.get(item.summaryContributionId) ?? null
      : null,
  }));

  if (evidence.refresh === "failed") {
    return {
      inventory: {
        availability: "available",
        value,
        refresh: "failed",
        refreshError: evidence.refreshError,
      },
      annotations,
    };
  }
  return {
    inventory: {
      availability: "available",
      value,
      refresh: evidence.refresh,
    },
    annotations,
  };
}
