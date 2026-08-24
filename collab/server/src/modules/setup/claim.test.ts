import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETUP_CLAIM_REQUEST_SCHEMA_ID,
  SETUP_TRANSITION_REQUEST_SCHEMA_ID,
  type SetupPhase,
} from "@cd-collab/contracts/setup";
import { afterEach, describe, expect, it } from "vitest";
import {
  SetupClaimError,
  claimSetupOwner,
  initializeSetupState,
  transitionSetupState,
  type SetupClaimDependencies,
} from "./claim.js";
import { FileSetupStateStore } from "./state-store.js";

const OWNER_TOKEN = "A".repeat(43);
const WRONG_TOKEN = "B".repeat(43);
const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  file: string;
  store: FileSetupStateStore;
  deps: SetupClaimDependencies;
}> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contextdesk-setup-claim-"),
  );
  roots.push(root);
  const file = join(root, "setup", "state.json");
  let id = 0;
  let time = 10_000;
  return {
    root,
    file,
    store: new FileSetupStateStore(file),
    deps: {
      randomId: () => `opaque-${++id}`,
      nowUnixMs: () => ++time,
    },
  };
}

function claimRequest(expectedRevision = 0, ownerToken = OWNER_TOKEN) {
  return {
    schemaId: SETUP_CLAIM_REQUEST_SCHEMA_ID,
    expectedRevision,
    ownerToken,
    claimantLabel: "Local owner",
  } as const;
}

function transitionRequest(
  expectedRevision: number,
  targetPhase: SetupPhase,
  failureCode: string | null = null,
) {
  return {
    schemaId: SETUP_TRANSITION_REQUEST_SCHEMA_ID,
    expectedRevision,
    targetPhase,
    failureCode,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("owner claim state machine", () => {
  it("initializes with only a digest on disk and returns a redacted status", async () => {
    const { file, store, deps } = await fixture();
    const status = await initializeSetupState(store, OWNER_TOKEN, deps);
    expect(status).toMatchObject({
      revision: 0,
      phase: "awaiting_owner",
      claimed: false,
    });
    const serialized = await readFile(file, "utf8");
    expect(serialized).not.toContain(OWNER_TOKEN);
    expect(serialized).toContain(
      createHash("sha256").update(OWNER_TOKEN).digest("hex"),
    );
    const publicStatus = JSON.stringify(status);
    expect(publicStatus).not.toContain(OWNER_TOKEN);
    expect(publicStatus).not.toContain("ownerTokenDigest");
    expect(publicStatus).not.toContain(file);
  });

  it("rejects a wrong token without persisting it or disclosing it", async () => {
    const { file, store, deps } = await fixture();
    await initializeSetupState(store, OWNER_TOKEN, deps);
    let error: unknown;
    try {
      await claimSetupOwner(store, claimRequest(0, WRONG_TOKEN), deps);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupClaimError);
    expect(error).toMatchObject({ code: "invalid_owner_token" });
    expect(String(error)).not.toContain(WRONG_TOKEN);
    expect(await readFile(file, "utf8")).not.toContain(WRONG_TOKEN);
    expect((await store.load()).history).toHaveLength(1);
  });

  it("allows one concurrent owner claim and rejects replay or takeover", async () => {
    const { file, store, deps } = await fixture();
    await initializeSetupState(store, OWNER_TOKEN, deps);
    const contenders = [
      claimSetupOwner(new FileSetupStateStore(file), claimRequest(), deps),
      claimSetupOwner(new FileSetupStateStore(file), claimRequest(), deps),
    ];
    const results = await Promise.allSettled(contenders);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    await expect(
      claimSetupOwner(store, claimRequest(1), deps),
    ).rejects.toMatchObject({ code: "claim_unavailable" });
    await expect(
      claimSetupOwner(store, claimRequest(0), deps),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const state = await store.load();
    expect(state.history).toHaveLength(2);
    expect(state.history[1]).toMatchObject({
      phase: "claimed",
      claimantLabel: "Local owner",
    });
  });

  it("executes the success path with exact revisions and rejects invalid jumps", async () => {
    const { store, deps } = await fixture();
    await initializeSetupState(store, OWNER_TOKEN, deps);
    await claimSetupOwner(store, claimRequest(), deps);

    await expect(
      transitionSetupState(
        store,
        OWNER_TOKEN,
        transitionRequest(1, "verifying"),
        deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const phases: SetupPhase[] = [
      "draft",
      "draft",
      "verifying",
      "ready_to_commit",
      "restart_required",
      "configured",
    ];
    let revision = 1;
    for (const phase of phases) {
      const status = await transitionSetupState(
        store,
        OWNER_TOKEN,
        transitionRequest(revision, phase),
        deps,
      );
      revision += 1;
      expect(status).toMatchObject({ phase, revision, claimed: true });
    }

    await expect(
      transitionSetupState(
        store,
        OWNER_TOKEN,
        transitionRequest(revision, "draft"),
        deps,
      ),
    ).rejects.toMatchObject({ code: "setup_complete" });
    await expect(
      claimSetupOwner(store, claimRequest(revision), deps),
    ).rejects.toMatchObject({ code: "setup_complete" });
  });

  it("supports a failed verification retry and terminal explicit recovery", async () => {
    const first = await fixture();
    await initializeSetupState(first.store, OWNER_TOKEN, first.deps);
    await claimSetupOwner(first.store, claimRequest(), first.deps);
    await transitionSetupState(
      first.store,
      OWNER_TOKEN,
      transitionRequest(1, "draft"),
      first.deps,
    );
    await transitionSetupState(
      first.store,
      OWNER_TOKEN,
      transitionRequest(2, "verifying"),
      first.deps,
    );
    const failed = await transitionSetupState(
      first.store,
      OWNER_TOKEN,
      transitionRequest(3, "failed", "database_unreachable"),
      first.deps,
    );
    expect(failed.failureCode).toBe("database_unreachable");
    await expect(
      transitionSetupState(
        first.store,
        OWNER_TOKEN,
        transitionRequest(4, "draft"),
        first.deps,
      ),
    ).resolves.toMatchObject({ phase: "draft", failureCode: null });

    const second = await fixture();
    await initializeSetupState(second.store, OWNER_TOKEN, second.deps);
    await claimSetupOwner(second.store, claimRequest(), second.deps);
    await transitionSetupState(
      second.store,
      OWNER_TOKEN,
      transitionRequest(1, "draft"),
      second.deps,
    );
    await transitionSetupState(
      second.store,
      OWNER_TOKEN,
      transitionRequest(2, "verifying"),
      second.deps,
    );
    await expect(
      transitionSetupState(
        second.store,
        OWNER_TOKEN,
        transitionRequest(3, "recovery_required", "atomic_commit_interrupted"),
        second.deps,
      ),
    ).resolves.toMatchObject({
      phase: "recovery_required",
      failureCode: "atomic_commit_interrupted",
    });
    await expect(
      transitionSetupState(
        second.store,
        OWNER_TOKEN,
        transitionRequest(4, "draft"),
        second.deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("fails closed on stale revisions and wrong transition credentials", async () => {
    const { store, deps } = await fixture();
    await initializeSetupState(store, OWNER_TOKEN, deps);
    await claimSetupOwner(store, claimRequest(), deps);
    await expect(
      transitionSetupState(
        store,
        OWNER_TOKEN,
        transitionRequest(0, "draft"),
        deps,
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });

    let error: unknown;
    try {
      await transitionSetupState(
        store,
        WRONG_TOKEN,
        transitionRequest(1, "draft"),
        deps,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_owner_token" });
    expect(String(error)).not.toContain(WRONG_TOKEN);
    expect((await store.load()).history).toHaveLength(2);
  });
});
