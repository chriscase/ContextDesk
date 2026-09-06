import { expect, type Page, type Request } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS } from "./helpers.js";

export const COORDINATION_SCHEMA_ID =
  "cd-collab.investigation_coordination_action_request.v1";

export const QUEUE_QUERY_SCHEMA_ID =
  "cd-collab.investigation_operations_queue_query.v1";

export interface CoordinationRequestBody {
  readonly schemaId: string;
  readonly investigationId: string;
  readonly action: "claim_self" | "release_self";
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export async function createQualificationInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Operations Queue self-coordination qualification.",
      affectedParties: "Fixture operators",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id, "fixture case creation did not return an id").toBeTruthy();
  return body.id!;
}

export function captureCoordinationRequests(page: Page, caseId: string): {
  readonly bodies: CoordinationRequestBody[];
  readonly allRequests: Request[];
  readonly stop: () => void;
} {
  const bodies: CoordinationRequestBody[] = [];
  const allRequests: Request[] = [];
  const listener = (request: Request) => {
    allRequests.push(request);
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.pathname !== `/api/cases/${caseId}/coordination`) return;
    bodies.push(request.postDataJSON() as CoordinationRequestBody);
  };
  page.on("request", listener);
  return { bodies, allRequests, stop: () => page.off("request", listener) };
}

export function expectSelfBody(
  body: CoordinationRequestBody,
  caseId: string,
  action: "claim_self" | "release_self",
  expectedRevision: number,
): void {
  expect(body).toEqual({
    schemaId: COORDINATION_SCHEMA_ID,
    investigationId: caseId,
    action,
    expectedRevision,
    idempotencyKey: expect.stringMatching(/^[a-z0-9._:-]+$/iu),
  });
}

export function expectNoPerRowReads(requests: readonly Request[], caseId: string): void {
  for (const request of requests) {
    const url = new URL(request.url());
    expect(
      !(request.method() === "GET" && (
        url.pathname === `/api/cases/${caseId}`
        || url.pathname === `/api/cases/${caseId}/coordination`
      )),
      `unexpected per-row investigation GET: ${request.method()} ${url.pathname}`,
    ).toBe(true);
  }
}

export function expectOnlyPublicCoordinationWrites(
  requests: readonly Request[],
  caseId: string,
): void {
  for (const request of requests) {
    const url = new URL(request.url());
    if (request.method() !== "POST" || !url.pathname.includes("coordination")) continue;
    expect(url.pathname).toBe(`/api/cases/${caseId}/coordination`);
  }
}

export function expectQueueUrlUnchanged(page: Page, initialUrl: string): void {
  const expected = new URL(initialUrl);
  const actual = new URL(page.url());
  expect(actual.pathname).toBe(expected.pathname);
  expect(actual.searchParams.toString()).toBe(expected.searchParams.toString());
}
