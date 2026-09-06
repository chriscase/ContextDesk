import type { OperationsQueueLocationQuery } from "../app-location.js";
import type { InvestigationRuntimeIdentity } from "../investigations/runtime/public.js";

const STORAGE_PREFIX = "cd-operations-views:";
const MAX_SAVED_VIEWS = 8;
const MAX_VIEW_NAME = 64;
const MAX_QUERY = 256;
const VALID_STATUSES = ["open", "monitoring", "resolved", "archived"] as const;
const VALID_STATUS_SET = new Set<string>(VALID_STATUSES);
const VALID_SCOPES = new Set(["all_visible", "mine", "unassigned"]);

export interface OperationsQueueSavedView {
  readonly id: string;
  readonly name: string;
  readonly query: OperationsQueueLocationQuery;
}

function identityStorageKey(identity: InvestigationRuntimeIdentity): string | null {
  const stableIdentity = identity.id.trim() || identity.username.trim();
  return stableIdentity ? `${STORAGE_PREFIX}${encodeURIComponent(stableIdentity)}` : null;
}

function normalizeQuery(raw: unknown): OperationsQueueLocationQuery | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const q = typeof record.q === "string" ? record.q.trim() : null;
  const status = Array.isArray(record.status) ? record.status : null;
  const coordinationScope = record.coordinationScope;
  if (
    q === null
    || q.length > MAX_QUERY
    || status === null
    || status.some((item) => typeof item !== "string" || !VALID_STATUS_SET.has(item))
    || new Set(status).size !== status.length
    || typeof record.includeArchived !== "boolean"
    || typeof coordinationScope !== "string"
    || !VALID_SCOPES.has(coordinationScope)
  ) return null;
  return Object.freeze({
    q,
    status: Object.freeze(
      VALID_STATUSES.filter((item) => status.includes(item)),
    ) as OperationsQueueLocationQuery["status"],
    includeArchived: record.includeArchived,
    coordinationScope: coordinationScope as OperationsQueueLocationQuery["coordinationScope"],
  });
}

function normalizeView(raw: unknown): OperationsQueueSavedView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const query = normalizeQuery(record.query);
  if (!id || !name || name.length > MAX_VIEW_NAME || query === null) return null;
  return Object.freeze({ id, name, query });
}

function persistableViews(views: readonly unknown[]): OperationsQueueSavedView[] {
  const seen = new Set<string>();
  const next: OperationsQueueSavedView[] = [];
  for (const view of views) {
    const normalized = normalizeView(view);
    if (normalized === null || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    next.push(normalized);
    if (next.length >= MAX_SAVED_VIEWS) break;
  }
  return next;
}

function storageFor(identity: InvestigationRuntimeIdentity): Storage | null {
  if (typeof window === "undefined" || identityStorageKey(identity) === null) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function operationsQueueSavedViewsKey(identity: InvestigationRuntimeIdentity): string | null {
  return identityStorageKey(identity);
}

export function operationsQueueSavedViewQuery(
  query: OperationsQueueLocationQuery,
): OperationsQueueLocationQuery | null {
  return normalizeQuery({
    q: query.q,
    status: query.status,
    includeArchived: query.includeArchived,
    coordinationScope: query.coordinationScope,
  });
}

export function loadOperationsQueueSavedViews(
  identity: InvestigationRuntimeIdentity,
): OperationsQueueSavedView[] {
  const storage = storageFor(identity);
  const key = identityStorageKey(identity);
  if (storage === null || key === null) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return persistableViews(parsed);
  } catch {
    return [];
  }
}

export function writeOperationsQueueSavedViews(
  identity: InvestigationRuntimeIdentity,
  views: readonly OperationsQueueSavedView[],
): boolean {
  const storage = storageFor(identity);
  const key = identityStorageKey(identity);
  if (storage === null || key === null) return false;
  const normalized = persistableViews(views);
  if (views.length > 0 && normalized.length === 0) return false;
  try {
    storage.setItem(key, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function operationsQueueSavedViewNameLimit(): number {
  return MAX_VIEW_NAME;
}

export function operationsQueueSavedViewLimit(): number {
  return MAX_SAVED_VIEWS;
}
