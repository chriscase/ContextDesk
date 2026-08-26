import {
  createModelPurposePolicy,
  defaultModelPurposeRules,
  MODEL_PURPOSE_POLICY_SCHEMA_ID,
} from "@cd-collab/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminModelPolicyPanel } from "./AdminModelPolicyPanel.js";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("AdminModelPolicyPanel", () => {
  it("loads safe model subjects and saves an administrator policy", async () => {
    const policy = createModelPurposePolicy(
      defaultModelPurposeRules(["profile:qwen"]),
      3,
      "admin",
      "2026-08-26T00:00:00.000Z",
    );
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/model-policy" && !init?.method) {
        return response({
          schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID,
          policy,
          availableSubjects: [{
            id: "profile:qwen",
            label: "Qwen review",
            provider: "company-gateway",
            modelId: "qwen-3.6-27b",
          }],
        });
      }
      if (String(input) === "/api/admin/model-policy" && init?.method === "PUT") {
        return response({ schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID, policy: { ...policy, revision: 4 } });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    render(<AdminModelPolicyPanel />);
    expect(await screen.findByRole("heading", { name: "Which models may do which work?" })).toBeTruthy();
    expect(screen.getAllByText(/Qwen review/).length).toBeGreaterThan(0);
    screen.getByRole("button", { name: "Review and save model-use policy" }).click();
    expect((await screen.findByRole("status")).textContent).toMatch(/revision 4/);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/model-policy",
      expect.objectContaining({ method: "PUT" }),
    ));
  });
});
