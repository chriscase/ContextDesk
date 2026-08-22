# War-room dream-stack qualification v1

**Status:** disposable integration branch. Draft-only. Do not merge.

**Purpose:** prove whether ContextDesk’s current manual intake, provenance,
model comparison, decision cockpit, privacy export, workflow shell,
authentication, retired-source enforcement, snapshot contract, and browser
compatibility work together when the pinned war-room draft PRs are applied as
**exact deltas** onto `merge/war-room-pilot`.

**Handbook impact:** none — this branch only assembles already-authored draft
deltas plus this report. No new architecture, trust-boundary, or evidence-flow
chapter is introduced here.

This is not a live-provider, employer-profile, or production-readiness claim.
No credentials, employer data, or generated qualification artifacts are
committed.

## Start gate

| Item | Value | Result |
| --- | --- | --- |
| Repo | `chriscase/ContextDesk` | used |
| Lander | `merge/war-room-pilot` @ `b93dc17ba2e13225d54f0193ecdf3872998082e6` | exact match (also current `main`) |
| Qualification branch | `cursor/war-room-dream-stack-qualification-v1` | created from the lander; was absent on `origin` |
| Source PRs | #942–#960 listed below | all `draft` + `open` at the pinned heads before work began |

Pinned source heads (verified via GitHub PR `head.sha` before assembly; none
were commented on, pushed, retargeted, rebased, or merged):

| PR | Head | Base | Role |
| --- | --- | --- | --- |
| #942 | `0c82327987dcd457abec9a6a7f23ecbe1d82d938` | lander | bench-run → strategy_package converter |
| #944 | `b9e0e2938ab5c53679c55db90514d95ddb6a0ddb` | lander | GUI honesty, lane picker, one-step freeze |
| #945 | `9b1d76d5f4e4f7b31aca8e7c56c32197bf9b665c` | lander | fail-closed import outcome |
| #946 | `80d7ec2acf7a2e9c2d9f2d0667c31820bd84174d` | lander | 3-lane proof attempt note |
| #947 | `9baea25c9c1fb6619aeb8c57d6b7bc595aef2e99` | lander | guided Capture→Analyze→Compare→Decide workspace |
| #948 | `bfb76e5a2aff09ec7720309b79ef64ea069c411e` | #947 | browser import helper for guided capture |
| #949 | `a31494c16e6a8f8da064ff4105a7f73939e9d244` | #947 | source & provenance library |
| #950 | `60d5e5b2586eb152feb4d516c9508008e9ddbf0a` | #949 | source-aware imported-run honesty |
| #951 | `aab0fce2309eba96b668f48dbdc9a266ec3bff22` | #944 | Experiment Lab scan strip |
| #952 | `6a56f47b81f33e4acbde2d2fdee99acb8edd7f16` | #951 | workbench mobile containment |
| #953 | `edc2265ef937e98455952c5df9edf3ac23806feb` | lander | server retired-source import rejection |
| #954 | `ef764714a546845b6d8f3f2734cac39ba7dd895a` | #950 | retired-source-safe intake chooser |
| #955 | `6b93f84a9a0f69afbe5ea71b7942fae5204e5282` | #954 | browser helper on retired-source intake stack |
| #956 | `fca0e256936827d057ed1352789cf2abe31f4222` | lander | export panel states / a11y |
| #957 | `b11ac12a5e754a6c60ef67c09ae6acce39b5e4fc` | lander | workflow stage navigator |
| #958 | `08d7ca1dfa5157083489c44246b6574f39aca882` | #957 | honest sign-in states |
| #959 | `84f95cd0fcc252f1abb9795e5f5bfe7f7d780c78` | lander | `cd-collab.snapshot.v1` contract |
| #960 | `21c5470587b56ae26119a147ea2f7467bec2ec1a` | #952 | decision-readiness cockpit |

## Assembly

Exact PR deltas (`git cherry-pick` of unique commits vs each PR’s declared
base), not stacked heads, in the requested dependency order:

1. Independent lander children: #942 (4 commits), #944, #945, #946, #947,
   #953, #956, #957, #959.
2. #944 stack: #951 → #952 → #960.
3. #947 provenance stack: #949 → #950 → #954.
4. Browser compatibility deltas: #948 then #955.
5. #957 child: #958.

Write allowlist = union of those deltas + this report. Assembly touched only
that union (107 product files before this report; 108 including it).

### Conflict resolutions

| When | File | Resolution |
| --- | --- | --- |
| #944 onto #942 | `collab/web/src/TriageRunPanel.tsx` | Keep both state groups: #942 bench-artifact import (`benchArtifactText` / busy / experiment id) **and** #944 `lanePickerError`. One conflict hunk; both UIs remain. `ExperimentLab.*` and CSS auto-merged. |
| #951 onto #942+#944 | `collab/web/src/ExperimentLab.test.tsx` | Keep #951’s scan-strip tests **and** #942’s bench-artifact import test. Implementation/CSS auto-merged. |
| #955 onto #948 | `collab/e2e/src/helpers.ts` | Empty cherry-pick. #948 and #955 produce **byte-identical** helper files (`16 insertions / 5 deletions` each). #948 was applied once after #954 so both guided-capture and retired-source intake locators are present. #955 was skipped rather than duplicating the same delta. |

No other cherry-picks conflicted.

### Superseded helper behavior

The lander’s `Prompt (optional)` / always-select-visibility helper is
superseded once. The combined helper:

- fills `External run output` and optional `External run prompt (optional)`
  through form-scoped accessible names;
- opens `Provenance details (visibility, snapshot)` only when visibility is
  supplied;
- leaves the closed disclosure and `unknown` default when visibility is
  omitted.

That single helper serves both #947 guided intake and #954 retired-source
intake (active-source options still render as `{name} ({kind})`).

### Stack dependencies (as assembled)

```text
lander b93dc17b
├── #942 converter
├── #944 GUI honesty
│     └── #951 scan strip
│           └── #952 mobile containment
│                 └── #960 decision-readiness cockpit
├── #945 import outcome
├── #946 3-lane attempt note
├── #947 guided workspace
│     ├── #948/#955 identical browser helper (applied once)
│     └── #949 provenance library
│           └── #950 source-aware honesty
│                 └── #954 retired-source intake UI
├── #953 retired-source server enforcement
├── #956 export panel
├── #957 workflow navigator
│     └── #958 login honesty
└── #959 snapshot contract
```

#942 and the #944→#960 stack both edit Experiment Lab / run panel / cases
CSS. Combined stack keeps converter paste-import **and** the cockpit.

## Qualification commands

Results in this file are filled from commands actually run on this branch.
A command not yet run is marked **not yet run**, never inferred.

### Product / whitespace

| Command | Result |
| --- | --- |
| `git diff --check b93dc17ba2e13225d54f0193ecdf3872998082e6 HEAD` | **pass** (assembly revision, before this report) |
| Source PR `head.sha` vs pinned table | **pass** before assembly |
| Allowlist extras vs lander | **none** |

### Rust / desktop / collab / browser / hosted

Filled after the first qualification pass on this branch.

## Unresolved blockers

None identified at assembly time. Combined-stack regressions, if any, will be
resolved only inside the allowlist or reported as blockers.

## Integration-ready?

**Not yet claimed.** Assembly is complete and pinned; command evidence is
required before calling the combined stack integration-ready.
