/**
 * Optional authorized-set index for collection entity and impact facets.
 *
 * Entity involvements and software-impact records live in other modules.
 * This port lets CaseService count and filter those identities without
 * taking store ownership of their tables. Unbound, those filters match
 * nothing and those facet families stay empty.
 */
import type { SoftwareImpactIdentityV1 } from "@cd-collab/contracts";
import { softwareImpactIdentityKey } from "@cd-collab/contracts";

export interface InvestigationCollectionEntityLink {
  entityId: string;
  label: string;
}

export interface InvestigationCollectionEntityRecord extends InvestigationCollectionEntityLink {
  caseId: string;
}

export interface InvestigationCollectionImpactRecord extends SoftwareImpactIdentityV1 {
  caseId: string;
}

export interface InvestigationCollectionGraphSnapshot {
  entitiesFor(caseId: string): readonly InvestigationCollectionEntityLink[];
  impactsFor(caseId: string): readonly SoftwareImpactIdentityV1[];
}

export interface InvestigationCollectionGraph {
  snapshot(caseIds: readonly string[]): Promise<InvestigationCollectionGraphSnapshot>;
}

export function createInvestigationCollectionGraph(input: {
  loadEntities: (
    caseIds: readonly string[],
  ) => Promise<readonly InvestigationCollectionEntityRecord[]>;
  loadImpacts?: (
    caseIds: readonly string[],
  ) => Promise<readonly InvestigationCollectionImpactRecord[]>;
}): InvestigationCollectionGraph {
  return {
    async snapshot(caseIds) {
      const allowed = new Set(caseIds);
      const entityRows = await input.loadEntities(caseIds);
      const impactRows = input.loadImpacts ? await input.loadImpacts(caseIds) : [];
      const entities = new Map<string, InvestigationCollectionEntityLink[]>();
      const impacts = new Map<string, SoftwareImpactIdentityV1[]>();
      for (const row of entityRows) {
        if (!allowed.has(row.caseId)) continue;
        const list = entities.get(row.caseId) ?? [];
        if (!list.some((candidate) => candidate.entityId === row.entityId)) {
          list.push({ entityId: row.entityId, label: row.label });
          entities.set(row.caseId, list);
        }
      }
      for (const { caseId, ...identity } of impactRows) {
        if (!allowed.has(caseId)) continue;
        const list = impacts.get(caseId) ?? [];
        const key = softwareImpactIdentityKey(identity);
        if (!list.some((candidate) => softwareImpactIdentityKey(candidate) === key)) {
          list.push(identity);
          impacts.set(caseId, list);
        }
      }
      return {
        entitiesFor: (caseId) => entities.get(caseId) ?? [],
        impactsFor: (caseId) => impacts.get(caseId) ?? [],
      };
    },
  };
}

export class MemoryInvestigationCollectionGraph
implements InvestigationCollectionGraph, InvestigationCollectionGraphSnapshot {
  private readonly entities = new Map<string, InvestigationCollectionEntityLink[]>();
  private readonly impacts = new Map<string, SoftwareImpactIdentityV1[]>();

  linkEntity(caseId: string, entityId: string, label: string): void {
    const list = this.entities.get(caseId) ?? [];
    if (!list.some((row) => row.entityId === entityId)) {
      list.push({ entityId, label });
      this.entities.set(caseId, list);
    }
  }

  recordImpact(caseId: string, identity: SoftwareImpactIdentityV1): void {
    const list = this.impacts.get(caseId) ?? [];
    const key = softwareImpactIdentityKey(identity);
    if (!list.some((row) => softwareImpactIdentityKey(row) === key)) {
      list.push({ ...identity });
      this.impacts.set(caseId, list);
    }
  }

  entitiesFor(caseId: string): readonly InvestigationCollectionEntityLink[] {
    return this.entities.get(caseId) ?? [];
  }

  impactsFor(caseId: string): readonly SoftwareImpactIdentityV1[] {
    return this.impacts.get(caseId) ?? [];
  }

  async snapshot(caseIds: readonly string[]): Promise<InvestigationCollectionGraphSnapshot> {
    const allowed = new Set(caseIds);
    const entities = new Map(
      [...this.entities.entries()]
        .filter(([caseId]) => allowed.has(caseId))
        .map(([caseId, rows]) => [caseId, rows.map((row) => ({ ...row }))]),
    );
    const impacts = new Map(
      [...this.impacts.entries()]
        .filter(([caseId]) => allowed.has(caseId))
        .map(([caseId, rows]) => [caseId, rows.map((row) => ({ ...row }))]),
    );
    return {
      entitiesFor: (caseId) => entities.get(caseId) ?? [],
      impactsFor: (caseId) => impacts.get(caseId) ?? [],
    };
  }
}
