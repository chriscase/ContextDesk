import { describe, expect, it } from "vitest";
import {
  buildErrorReport,
  buildFeedbackReport,
  buildGitHubNewIssueUrl,
  feedbackDraftChatSeed,
  redactDiagnosticText,
} from "./errorReport";

describe("redactDiagnosticText (#325)", () => {
  it("strips bearer and sk- tokens", () => {
    const out = redactDiagnosticText(
      "auth Bearer sk-live-abc123xyz999 and ghp_abcdefghijklmnopqrstuv",
    );
    expect(out).not.toMatch(/sk-live/);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/Bearer\s+sk/i);
    expect(out).toContain("[REDACTED_TOKEN]");
  });

  it("strips query strings from URLs", () => {
    const out = redactDiagnosticText(
      "confluence: error https://wiki.example.com/rest/api/content/search?cql=text%20~%20secret&limit=20",
    );
    expect(out).not.toContain("cql=");
    expect(out).toContain("?[REDACTED_QUERY]");
  });

  it("redacts corp-looking hosts and private IPs", () => {
    const out = redactDiagnosticText(
      "failed https://ies-ebs-conf.ies.mentorg.com/path, server.internal, 100.64.1.30, 127.0.0.1, ::1, fd12:3456::7, and fe80::1",
    );
    expect(out).toContain("[REDACTED-HOST]");
    expect(out).toContain("[REDACTED-IP]");
    expect(out).not.toContain("mentorg");
    expect(out).not.toContain("server.internal");
    expect(out).not.toContain("100.64.1.30");
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("::1");
    expect(out).not.toContain("fd12:3456::7");
    expect(out).not.toContain("fe80::1");
  });

  it("redacts generic absolute paths without treating URL paths as local files", () => {
    const out = redactDiagnosticText(
      "read /opt/company/logs/app.log and C:\\Company\\logs\\app.log; request https://example.com/public/path",
    );
    expect(out).toContain("[REDACTED_PATH]");
    expect(out).not.toContain("/opt/company");
    expect(out).not.toContain("C:\\Company");
    expect(out).toContain("https://example.com/public/path");
  });
});

describe("buildErrorReport (#325)", () => {
  it("builds redacted report and github URL without secrets", () => {
    const r = buildErrorReport({
      raw: "confluence: error sending request for url (https://ies-ebs-conf.ies.mentorg.com/rest/api/content/search?cql=secret)",
      appVersion: "0.1.0-test",
      channel: "dev",
      gitSha: "abc1234",
      osHint: "macOS",
    });
    expect(r.summary.length).toBeGreaterThan(0);
    expect(r.reportMarkdown).toContain("redacted");
    expect(r.reportMarkdown).not.toContain("mentorg");
    expect(r.reportMarkdown).not.toContain("cql=secret");
    expect(r.reportMarkdown).toContain("Channel: dev");
    expect(r.reportMarkdown).toContain("Git: abc1234");
    expect(r.githubNewIssueUrl).toContain(
      "github.com/chriscase/ContextDesk/issues/new",
    );
    expect(r.githubNewIssueUrl).toContain("title=");
    expect(decodeURIComponent(r.githubNewIssueUrl)).not.toContain("mentorg");
  });
});

describe("buildGitHubNewIssueUrl", () => {
  it("encodes title and body", () => {
    const u = buildGitHubNewIssueUrl({
      owner: "chriscase",
      repo: "ContextDesk",
      title: "bug: test",
      body: "hello world",
    });
    expect(u).toContain("issues/new?");
    const parsed = new URL(u);
    expect(parsed.searchParams.get("title")).toBe("bug: test");
    expect(parsed.searchParams.get("body")).toBe("hello world");
  });
});

describe("buildFeedbackReport", () => {
  it("builds feature request URL without requiring an error", () => {
    const r = buildFeedbackReport({
      kind: "feature",
      summary: "Richer log importer for Airbus dumps",
      detail: "Folder ingest produced zero lines.",
      debugLog: ["scan found 3 files", "file a.gz: skipped binary-like"],
      appVersion: "0.1.0",
      channel: "dev",
    });
    expect(r.githubNewIssueUrl).toContain("issues/new");
    expect(r.reportMarkdown).toContain("feature");
    expect(r.reportMarkdown).toContain("skipped binary");
    expect(r.reportMarkdown).toContain("Richer log importer");
    expect(feedbackDraftChatSeed("feature")).toMatch(/feature request/i);
  });

  it("redacts secrets and private destinations from every feedback surface", () => {
    const rawToken = ["ghp", "12345678901234567890"].join("_");
    const privateHost = "logs.internal.example";
    const report = buildFeedbackReport({
      kind: "bug",
      summary: `Failure using ${rawToken}`,
      detail: `Request to https://${privateHost}/ingest?token=${rawToken} failed`,
      debugLog: [`Authorization: Bearer ${rawToken}`],
    });
    const decodedUrl = decodeURIComponent(report.githubNewIssueUrl);
    for (const output of [
      report.summary,
      report.technical,
      report.reportMarkdown,
      decodedUrl,
    ]) {
      expect(output).not.toContain(rawToken);
      expect(output).not.toContain(privateHost);
    }
  });
});
