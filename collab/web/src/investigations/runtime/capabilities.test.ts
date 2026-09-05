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
      canReadPrivate: false,
      canCreate: true,
      canUpload: true,
      canContribute: true,
      canEditSituation: true,
      canManageLifecycle: true,
      canCoordinateSelf: true,
      canCoordinateParticipants: false,
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
      canReadPrivate: false,
      canCreate: true,
      canUpload: true,
      canContribute: true,
      canEditSituation: true,
      canManageLifecycle: false,
      canCoordinateSelf: true,
      canCoordinateParticipants: false,
    });
    expect(projectInvestigationCapabilities(["run:strategies"], false)).toEqual({
      canRead: false,
      canReadPrivate: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: true,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });

  it("keeps reading but suppresses every mutation in static read-only mode", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
      "run:strategies",
    ], true)).toEqual({
      canRead: true,
      canReadPrivate: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
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
      canReadPrivate: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });

  it("grants no write affordance to a reader, and never lets lifecycle imply either write seam", () => {
    expect(projectInvestigationCapabilities(["investigation:read"], false)).toEqual({
      canRead: true,
      canReadPrivate: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "run:strategies",
    ], false)).toEqual({
      canRead: true,
      canReadPrivate: false,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: true,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });

  it("keeps self and participant coordination as exact independent gates", () => {
    expect(projectInvestigationCapabilities(["investigation:write"], false)).toMatchObject({
      canCoordinateSelf: true,
      canCoordinateParticipants: false,
    });
    expect(projectInvestigationCapabilities(["investigation:coordinate"], false)).toMatchObject({
      canCoordinateSelf: false,
      canCoordinateParticipants: true,
    });
    expect(projectInvestigationCapabilities([
      "investigation:write",
      "investigation:coordinate",
    ], true)).toMatchObject({
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });

  it("keeps every projected affordance a plain boolean the caller cannot widen", () => {
    const projected = projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
    ], false);
    expect(Object.keys(projected).sort()).toEqual([
      "canContribute",
      "canCoordinateParticipants",
      "canCoordinateSelf",
      "canCreate",
      "canEditSituation",
      "canManageLifecycle",
      "canRead",
      "canReadPrivate",
      "canUpload",
    ]);
    expect(Object.values(projected).every((value) => typeof value === "boolean")).toBe(true);
  });

  it("projects exact evidence:private:read and never infers it from write, run, or roles", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
      "run:strategies",
      "decision:accept",
      "export:create",
      "portable:restore",
    ], false).canReadPrivate).toBe(false);
    expect(projectInvestigationCapabilities([
      "evidence:private:read",
    ], false)).toEqual({
      canRead: false,
      canReadPrivate: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });

  it("keeps private-read authority in static read-only mode when granted", () => {
    expect(projectInvestigationCapabilities([
      "investigation:read",
      "investigation:write",
      "run:strategies",
      "evidence:private:read",
    ], true)).toEqual({
      canRead: true,
      canReadPrivate: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
      canCoordinateSelf: false,
      canCoordinateParticipants: false,
    });
  });
});
