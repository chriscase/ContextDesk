import { describe, expect, it } from "vitest";
import { parseLoginName, normalizeGroupDns } from "./ldap-resolution.js";

describe("LDAP login-name parsing", () => {
  it("classifies plain, UPN, and DOMAIN\\user forms without guessing a domain", () => {
    expect(parseLoginName("alice")).toEqual({ ok: true, form: "plain", username: "alice" });
    expect(parseLoginName("alice@example.test")).toEqual({
      ok: true,
      form: "upn",
      username: "alice",
      suffix: "example.test",
    });
    expect(parseLoginName("EXAMPLE\\alice")).toEqual({
      ok: true,
      form: "domain",
      netbios: "EXAMPLE",
      username: "alice",
    });
  });

  it("refuses mixed and empty forms", () => {
    expect(parseLoginName("EXAMPLE\\alice@example.test").ok).toBe(false);
    expect(parseLoginName("").ok).toBe(false);
    expect(parseLoginName("EXAMPLE\\").ok).toBe(false);
  });

  it("deduplicates group DNs case-insensitively and honors the bound", () => {
    expect(
      normalizeGroupDns(
        [
          "cn=contributors,ou=groups,dc=example,dc=test",
          "CN=contributors,OU=groups,DC=example,DC=test",
          " cn=admins,ou=groups,dc=example,dc=test ",
        ],
        2,
      ),
    ).toEqual([
      "cn=contributors,ou=groups,dc=example,dc=test",
      "cn=admins,ou=groups,dc=example,dc=test",
    ]);
  });
});
