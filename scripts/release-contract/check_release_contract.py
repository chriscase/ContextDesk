#!/usr/bin/env python3
"""Offline structural + mutation checks for the unified release contract.

Fail-closed cases (synthetic fixtures, no network, no secrets):
  - two builder workflows cannot mutate GitHub release title/body/prerelease
  - incomplete desktop or CLI matrix
  - Cargo/Tauri/tag version mismatch
  - wrong git SHA / rc5 asset reuse
  - missing updater signatures on GA
  - duplicate assets
  - release-object clobber
  - promote validation failure leaves the draft unpublished

Run: python3 scripts/release-contract/check_release_contract.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import release_contract as rc  # noqa: E402

ORCH = ROOT / ".github" / "workflows" / "release.yml"
DESKTOP = ROOT / ".github" / "workflows" / "release-desktop.yml"
CLI = ROOT / ".github" / "workflows" / "cli-release.yml"
PROMOTE = ROOT / ".github" / "workflows" / "release-promote.yml"
DOCS = [
    ROOT / "docs" / "PACKAGING.md",
    ROOT / "docs" / "CLI_PACKAGING.md",
    ROOT / "docs" / "testing" / "RELEASE_CONTRACT_ACCEPTANCE_V1.md",
]

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        msg = f"  FAIL  {name}" + (f" — {detail}" if detail else "")
        print(msg)
        failures.append(msg)


def _identity(tag: str = "v0.1.0", sha: str = rc.GA_SHA) -> rc.ReleaseIdentity:
    return rc.fixture_identity(tag=tag, git_sha=sha, kind_describe=tag)


def _assemble_ok(directory: Path, identity: rc.ReleaseIdentity, *, signed: bool) -> dict:
    return rc.assemble(
        directory,
        identity=identity,
        require_signed_updater=signed or identity.kind == "ga",
        allow_test_sig=True,
    )


def test_workflow_structure() -> None:
    print("== structural: workflows ==")
    orch = ORCH.read_text(encoding="utf-8") if ORCH.is_file() else ""
    desktop = DESKTOP.read_text(encoding="utf-8") if DESKTOP.is_file() else ""
    cli = CLI.read_text(encoding="utf-8") if CLI.is_file() else ""
    promote = PROMOTE.read_text(encoding="utf-8") if PROMOTE.is_file() else ""

    check("orchestrator workflow exists", ORCH.is_file())
    check("desktop builder workflow exists", DESKTOP.is_file())
    check("CLI builder workflow exists", CLI.is_file())
    check("promote workflow exists", PROMOTE.is_file())

    check("orchestrator has v* tag trigger", '"v*"' in orch or "'v*'" in orch)
    check("orchestrator concurrency group", "contextdesk-release-" in orch)
    check(
        "orchestrator calls desktop reusable",
        "./.github/workflows/release-desktop.yml" in orch,
    )
    check(
        "orchestrator calls CLI reusable",
        "./.github/workflows/cli-release.yml" in orch,
    )
    check("orchestrator embeds CD_CHANNEL=installed", "installed" in orch)
    check("orchestrator embeds CD_GIT_SHA", "CD_GIT_SHA" in orch or "git_sha" in orch)
    check(
        "orchestrator runs release_contract assemble",
        "release-contract/release_contract.py" in orch
        or "release-contract/run.py" in orch,
    )
    check(
        "orchestrator never auto-publishes",
        "draft: false" not in orch and "gh release edit" not in orch,
    )

    check("desktop builder has no tag trigger", "tags:" not in desktop)
    check(
        "desktop builder does not mutate GitHub releases",
        not rc.workflow_mentions_release_mutation(desktop),
    )
    check("desktop builder embeds CD_CHANNEL", "CD_CHANNEL" in desktop)
    check("desktop builder embeds CD_GIT_SHA", "CD_GIT_SHA" in desktop)
    check("desktop builder embeds CD_GIT_DESCRIBE", "CD_GIT_DESCRIBE" in desktop)
    check("desktop builder is reusable", "workflow_call" in desktop)
    for os_name in ("macos-latest", "ubuntu-24.04", "windows-latest"):
        check(f"desktop matrix includes {os_name}", os_name in desktop)

    check("CLI builder has no tag trigger", "tags:" not in cli)
    check(
        "CLI builder does not mutate GitHub releases",
        not rc.workflow_mentions_release_mutation(cli),
    )
    check("CLI builder is reusable", "workflow_call" in cli)
    for plat in rc.REQUIRED_CLI:
        check(f"CLI matrix includes {plat}", plat in cli)
    check("CLI still builds locked", "--locked" in cli)
    check("CLI still requires smoke", "CLI_SMOKE_REQUIRED" in cli)

    check("promote is workflow_dispatch only", "workflow_dispatch" in promote)
    check("promote has no tag trigger", "tags:" not in promote)
    check("promote requires expected_git_sha", "expected_git_sha" in promote)
    check("promote requires confirm_publish", "confirm_publish" in promote)
    check(
        "promote runs contract validator first",
        "release-contract" in promote and "promote" in promote,
    )


def test_docs_honesty() -> None:
    print("== structural: packaging docs ==")
    for path in DOCS:
        check(f"{path.relative_to(ROOT)} exists", path.is_file(), str(path))
    packaging = (
        (ROOT / "docs" / "PACKAGING.md").read_text(encoding="utf-8")
        if (ROOT / "docs" / "PACKAGING.md").is_file()
        else ""
    )
    cli_docs = (
        (ROOT / "docs" / "CLI_PACKAGING.md").read_text(encoding="utf-8")
        if (ROOT / "docs" / "CLI_PACKAGING.md").is_file()
        else ""
    )
    accept = (
        (ROOT / "docs" / "testing" / "RELEASE_CONTRACT_ACCEPTANCE_V1.md").read_text(
            encoding="utf-8"
        )
        if (ROOT / "docs" / "testing" / "RELEASE_CONTRACT_ACCEPTANCE_V1.md").is_file()
        else ""
    )
    joined = "\n".join([packaging, cli_docs, accept])
    check(
        "docs name the single orchestrator",
        ".github/workflows/release.yml" in joined and "authoritative" in joined.lower(),
    )
    check(
        "docs say War Room is source-run/separate",
        "source-run" in joined.lower() and "war room" in joined.lower(),
    )
    check(
        "docs do not claim Apple notarization is configured",
        "not_configured" in joined or "not configured" in joined.lower(),
    )
    check(
        "docs keep Authenticode honest",
        "authenticode" in joined.lower()
        and (
            "not_configured" in joined
            or "not configured" in joined.lower()
            or "not shipped" in joined.lower()
        ),
    )
    check(
        "docs list updater signing secret names only",
        "TAURI_SIGNING_PRIVATE_KEY" in joined,
    )
    check("docs mention SHA256SUMS", "SHA256SUMS" in joined)
    check("docs mention latest.json", "latest.json" in joined)
    check("docs mention promote", "release-promote" in joined)
    check(
        "docs forbid rc5 reuse",
        "rc5" in joined.lower() and "never reuse" in joined.lower(),
    )


def test_identity() -> None:
    print("== mutation: identity ==")
    versions = rc.read_package_versions(ROOT)
    check("repo package versions agree", len(versions.unique()) == 1, str(versions))
    sha = "0123456789abcdef0123456789abcdef01234567"
    ident = rc.check_identity(
        repo_root=ROOT,
        tag="v0.1.0",
        git_sha=sha,
        git_describe="v0.1.0",
        channel="installed",
    )
    check("v0.1.0 identity is GA", ident.kind == "ga" and ident.version == "0.1.0")

    try:
        rc.check_identity(
            repo_root=ROOT,
            tag="v0.2.0",
            git_sha=sha,
            git_describe="v0.2.0",
            channel="installed",
        )
        check("version mismatch vs Cargo is rejected", False)
    except SystemExit:
        check("version mismatch vs Cargo is rejected", True)

    try:
        rc.check_identity(
            repo_root=ROOT,
            tag="v0.1.0",
            git_sha="deadbeef",
            git_describe="v0.1.0",
            channel="installed",
        )
        check("short SHA is rejected", False)
    except SystemExit:
        check("short SHA is rejected", True)

    try:
        rc.check_identity(
            repo_root=ROOT,
            tag="v0.1.0",
            git_sha=sha,
            git_describe="v0.1.0",
            channel="dev",
        )
        check("non-installed channel is rejected", False)
    except SystemExit:
        check("non-installed channel is rejected", True)

    rc_ident = rc.check_identity(
        repo_root=ROOT,
        tag="v0.1.0-rc6",
        git_sha=sha,
        git_describe="v0.1.0-rc6",
        channel="installed",
    )
    check(
        "rc tag keeps package core 0.1.0",
        rc_ident.kind == "prerelease"
        and rc_ident.package_version == "0.1.0"
        and rc_ident.version == "0.1.0-rc6",
    )

    try:
        rc.preflight_signing(kind="ga", has_tauri_key=False)
        check("GA without signing key fails closed", False)
    except SystemExit:
        check("GA without signing key fails closed", True)
    try:
        rc.preflight_signing(kind="ga", has_tauri_key=True)
        check("GA with key presence passes preflight", True)
    except SystemExit:
        check("GA with key presence passes preflight", False)
    try:
        rc.preflight_signing(kind="prerelease", has_tauri_key=False)
        check("RC without key is allowed to draft", True)
    except SystemExit:
        check("RC without key is allowed to draft", False)


def test_complete_ga() -> None:
    print("== happy: complete GA fixture ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        manifest = _assemble_ok(tdp, identity, signed=True)
        check("complete GA assemble succeeds", manifest.get("promotable") is True)
        check("SHA256SUMS exists", (tdp / "SHA256SUMS").is_file())
        check("inventory exists", (tdp / "inventory.txt").is_file())
        check("SBOM exists", (tdp / "sbom.cdx.json").is_file())
        check("manifest exists", (tdp / "release-manifest.json").is_file())
        check("latest.json exists", (tdp / "latest.json").is_file())
        sums = (tdp / "SHA256SUMS").read_text(encoding="utf-8")
        check("SHA256SUMS includes desktop dmg", "dmg" in sums.lower())
        check("SHA256SUMS includes CLI archive", "contextdesk-0.1.0-linux-x64" in sums)
        check("SHA256SUMS includes latest.json", "latest.json" in sums)
        latest = json.loads((tdp / "latest.json").read_text(encoding="utf-8"))
        check("latest.json has three updater platforms", len(latest.get("platforms") or {}) == 3)
        inventory = (tdp / "inventory.txt").read_text(encoding="utf-8")
        check("inventory lists desktop and CLI", "desktop/" in inventory and "cli/" in inventory)
        check(
            "manifest signing honesty",
            manifest["signing"]["macos_notarization"] == "not_configured"
            and manifest["signing"]["windows_authenticode"] == "not_configured",
        )
        check("manifest war_room source-run", manifest.get("war_room") == "source_run_separate")
        check("manifest published false", manifest.get("published") is False)


def test_partial_matrix() -> None:
    print("== mutation: partial matrix ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        (tdp / f"ContextDesk_{identity.package_version}_x64_en-US.msi").unlink()
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("missing Windows installer fails", False)
        except SystemExit:
            check("missing Windows installer fails", True)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        (tdp / f"contextdesk-{identity.version}-macos-x64.tar.gz").unlink()
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("missing CLI platform fails", False)
        except SystemExit:
            check("missing CLI platform fails", True)


def test_wrong_sha() -> None:
    print("== mutation: wrong SHA ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        bad = json.loads((tdp / "build-info-linux-x64.json").read_text(encoding="utf-8"))
        bad["git_sha"] = rc.FOREIGN_SHA
        (tdp / "build-info-linux-x64.json").write_text(json.dumps(bad), encoding="utf-8")
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("foreign build-info SHA fails", False)
        except SystemExit:
            check("foreign build-info SHA fails", True)


def test_missing_signatures() -> None:
    print("== mutation: missing signatures ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=False)
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("GA without updater signatures fails", False)
        except SystemExit:
            check("GA without updater signatures fails", True)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        list(tdp.glob("*.sig"))[0].write_text("placeholder", encoding="utf-8")
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("placeholder signature fails", False)
        except SystemExit:
            check("placeholder signature fails", True)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        archive = tdp / "ContextDesk.app.tar.gz"
        (tdp / "ContextDesk.app.tar.gz.sig").write_text(
            rc.test_signature(b"different-bytes"), encoding="utf-8"
        )
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("signature bound to the wrong bytes fails", False)
        except SystemExit:
            check("signature bound to the wrong bytes fails", True)
        _ = archive  # keep name for readability


def test_duplicate_assets() -> None:
    print("== mutation: duplicate assets ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        nested = tdp / "dup"
        nested.mkdir()
        shutil.copy2(
            tdp / f"contextdesk-{identity.version}-linux-x64.tar.gz",
            nested / f"contextdesk-{identity.version}-linux-x64.tar.gz",
        )
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("duplicate basename fails", False)
        except SystemExit:
            check("duplicate basename fails", True)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        extra = tdp / f"contextdesk-{identity.version}-linux-x64-extra.tar.gz"
        # same platform inferred from -linux-x64.
        extra.write_bytes(b"second-linux")
        # rename pattern: contextdesk-0.1.0-linux-x64-extra.tar.gz may not infer
        # platform. Write a second exact platform name via different suffix path.
        other = tdp / "other"
        other.mkdir()
        # Use a second recognized CLI name for the same platform by tweaking
        # after collect? Safer: copy under a recognized alias.
        alias = tdp / f"contextdesk-{identity.version}-linux-x64.zip"
        alias.write_bytes(b"second-linux-zip")
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("two CLI archives for one platform fail", False)
        except SystemExit:
            check("two CLI archives for one platform fail", True)


def test_rc5_reuse() -> None:
    print("== mutation: rc5 / foreign tag reuse ==")
    identity = _identity("v0.1.0")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        (tdp / "contextdesk-0.1.0-rc5-linux-x64.tar.gz").write_bytes(b"old-rc5")
        try:
            _assemble_ok(tdp, identity, signed=True)
            check("rc5 archive on GA tag fails", False)
        except SystemExit:
            check("rc5 archive on GA tag fails", True)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        latest = {
            "version": "0.1.0",
            "platforms": {
                "darwin-aarch64": {
                    "signature": rc.test_signature(b"macos-updater"),
                    "url": (
                        "https://github.com/chriscase/ContextDesk/releases/"
                        "download/v0.1.0-rc5/ContextDesk.app.tar.gz"
                    ),
                }
            },
        }
        (tdp / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
        # assemble rebuilds latest.json for GA from artifacts, so inject after
        # and verify the URL binder rejects rc5.
        _assemble_ok(tdp, identity, signed=True)
        try:
            rc.verify_latest_json(
                latest,
                assets=rc.collect_assets(tdp, skip_generated=True)
                + [
                    rc.Asset(
                        name="latest.json",
                        path=tdp / "latest.json",
                        sha256="00",
                        kind="metadata",
                    )
                ],
                identity=identity,
                allow_test_sig=True,
                download_repo="chriscase/ContextDesk",
            )
            check("latest.json URL pointing at rc5 fails", False)
        except SystemExit:
            check("latest.json URL pointing at rc5 fails", True)


def test_release_clobber_and_rollback() -> None:
    print("== mutation: release-object clobber + safe rollback ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        _assemble_ok(tdp, identity, signed=True)
        store = rc.MemoryReleaseStore()
        first = rc.create_or_verify_draft(store, identity)
        rc.attach_assembled_assets(store, identity, tdp)
        check("draft created unpublished", first.draft is True and first.published is False)
        try:
            rc.create_or_verify_draft(
                store,
                identity,
            )
            # same metadata is idempotent
            check("identical draft recreate is idempotent", True)
        except rc.ContractError:
            check("identical draft recreate is idempotent", False)
        clobber = rc.ReleaseObject(
            tag=identity.tag,
            name="CLI 0.1.0",
            body="different body from the other workflow",
            draft=True,
            prerelease=True,
            git_sha=identity.git_sha,
        )
        try:
            store.create_draft(clobber)
            check("title/body/prerelease clobber is rejected", False)
        except rc.ContractError:
            check("title/body/prerelease clobber is rejected", True)
        after = store.get(identity.tag)
        check(
            "original title survived clobber attempt",
            after is not None and after.name == rc.locked_release_name(identity),
        )
        check(
            "original body survived clobber attempt",
            after is not None and after.body == rc.locked_release_body(identity),
        )
        check(
            "original prerelease survived clobber attempt",
            after is not None and after.prerelease is False,
        )

        # duplicate asset with different digest
        try:
            store.attach(identity.tag, "SHA256SUMS", "ff" * 32, 12)
            check("asset clobber with different digest fails", False)
        except rc.ContractError:
            check("asset clobber with different digest fails", True)

        # promote without confirm
        dry = rc.promote(
            store,
            identity=identity,
            directory=tdp,
            confirm="",
            allow_test_sig=True,
        )
        check("promote without confirm stays unpublished", dry.published is False)
        check("promote without confirm leaves draft", dry.draft_unchanged is True)
        check("store still draft after dry promote", store.get(identity.tag).draft is True)

        # promote with wrong SHA
        wrong = _identity(sha=rc.FOREIGN_SHA)
        wrong_result = rc.promote(
            store,
            identity=wrong,
            directory=tdp,
            confirm="publish",
            allow_test_sig=True,
        )
        check(
            "promote with another SHA stays unpublished",
            wrong_result.published is False and store.get(identity.tag).draft is True,
        )

        # break signatures then promote
        (tdp / "latest.json").unlink()
        failed = rc.promote(
            store,
            identity=identity,
            directory=tdp,
            confirm="publish",
            allow_test_sig=True,
        )
        check(
            "promote after ripping latest.json stays unpublished",
            failed.published is False and failed.draft_unchanged is True,
        )
        check("draft remains draft after failed promote", store.get(identity.tag).draft is True)

    # successful promote on a fresh complete dir
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        _assemble_ok(tdp, identity, signed=True)
        store = rc.MemoryReleaseStore()
        rc.create_or_verify_draft(store, identity)
        rc.attach_assembled_assets(store, identity, tdp)
        ok = rc.promote(
            store,
            identity=identity,
            directory=tdp,
            confirm="publish",
            allow_test_sig=True,
        )
        check("valid exact-SHA promote publishes", ok.published is True)
        check("published release is no longer draft", store.get(identity.tag).draft is False)

        # refuse to retarget a published release onto another SHA
        other = _identity(sha=rc.FOREIGN_SHA)
        again = rc.promote(
            store,
            identity=other,
            directory=tdp,
            confirm="publish",
            allow_test_sig=True,
        )
        check(
            "published release is not mutated onto another SHA",
            again.published is True
            and again.draft_unchanged is True
            and store.get(identity.tag).git_sha == identity.git_sha,
        )


def test_production_rejects_test_sig() -> None:
    print("== mutation: production forbids fixture signatures ==")
    identity = _identity()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        rc.populate_complete_matrix(tdp, identity=identity, signed=True)
        try:
            rc.assemble(
                tdp,
                identity=identity,
                require_signed_updater=True,
                allow_test_sig=False,
            )
            check("production assemble rejects test signatures", False)
        except SystemExit:
            check("production assemble rejects test signatures", True)


def main() -> int:
    test_workflow_structure()
    test_docs_honesty()
    test_identity()
    test_complete_ga()
    test_partial_matrix()
    test_wrong_sha()
    test_missing_signatures()
    test_duplicate_assets()
    test_rc5_reuse()
    test_release_clobber_and_rollback()
    test_production_rejects_test_sig()
    print()
    if failures:
        print(f"FAILED {len(failures)} check(s)")
        for item in failures:
            print(item)
        return 1
    print("ALL RELEASE CONTRACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
