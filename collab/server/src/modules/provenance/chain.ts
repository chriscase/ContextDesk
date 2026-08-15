export class LegalHoldError extends Error {
  constructor() {
    super("legal hold refuses content deletion");
    this.name = "LegalHoldError";
  }
}

export function assertCanTombstone(legalHold: boolean): void {
  if (legalHold) throw new LegalHoldError();
}

export function visibleBody(tombstoned: boolean, body: string): string | null {
  return tombstoned ? null : body;
}
