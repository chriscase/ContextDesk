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
      canContribute: true,
      canEditSituation: true,
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
      canContribute: true,
      canEditSituation: true,
      canManageLifecycle: false,
    });
    expect(projectInvestigationCapabilities(["run:strategies"], false)).toEqual({
      canRead: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
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
      canContribute: false,
      canEditSituation: false,
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
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
    });
  });

  it("grants no write affordance to a reader, and never lets lifecycle imply either write seam", () => {
    expect(projectInvestigationCapabilities(["investigation:read"], false)).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
    });
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "run:strategies",
    ], false)).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: true,
    });
  });

  it("keeps every projected affordance a plain boolean the caller cannot widen", () => {
    const projected = projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
    ], false);
    expect(Object.keys(projected).sort()).toEqual([
      "canContribute",
      "canCreate",
      "canEditSituation",
      "canManageLifecycle",
      "canRead",
      "canUpload",
    ]);
    expect(Object.values(projected).every((value) => typeof value === "boolean")).toBe(true);
  });
});
