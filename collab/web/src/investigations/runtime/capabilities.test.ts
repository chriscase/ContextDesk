import { describe, expect, it } from "vitest";
import { projectInvestigationCapabilities } from "./capabilities.js";

describe("investigation runtime capability projection", () => {
  it("projects read, write, and lifecycle authority from their exact capabilities", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
      "run:strategies",
    ], false)).toEqual({
      canRead: true,
      canCreate: true,
      canUpload: true,
      canManageLifecycle: true,
    });
  });

  it("does not infer one authority from another or from unrelated lead capabilities", () => {
    expect(projectInvestigationCapabilities([
      "investigation:write",
      "decision:accept",
      "export:create",
      "portable:restore",
    ], false)).toEqual({
      canRead: false,
      canCreate: true,
      canUpload: true,
      canManageLifecycle: false,
    });
    expect(projectInvestigationCapabilities(["run:strategies"], false)).toEqual({
      canRead: false,
      canCreate: false,
      canUpload: false,
      canManageLifecycle: true,
    });
  });

  it("keeps reading but suppresses every mutation in static read-only mode", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
      "run:strategies",
    ], true)).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canManageLifecycle: false,
    });
  });

  it("ignores duplicates and unknown capability strings", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:read",
      "investigation:delete",
      "admin:users",
    ], false)).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canManageLifecycle: false,
    });
  });
});
