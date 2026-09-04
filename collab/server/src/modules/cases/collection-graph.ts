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

export interface InvestigationCollectionGraph {
  entitiesFor(caseId: string): readonly InvestigationCollectionEntityLink[];
  impactsFor(caseId: string): readonly SoftwareImpactIdentityV1[];
}

export class MemoryInvestigationCollectionGraph implements InvestigationCollectionGraph {
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
}
