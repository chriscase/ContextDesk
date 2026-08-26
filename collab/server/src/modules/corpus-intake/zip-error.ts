import type { CorpusRejectionReason } from "@cd-collab/contracts";

/**
 * A refusal that ends the whole archive rather than one member.
 *
 * The reason is the contract's rejection vocabulary, so what the operator reads
 * on the intake report is the same word the parser decided on.
 */
export class ZipError extends Error {
  constructor(
    readonly reason: CorpusRejectionReason,
    detail: string,
  ) {
    super(detail);
    this.name = "ZipError";
  }
}
