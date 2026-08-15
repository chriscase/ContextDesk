import { describe, expect, it } from "vitest";
import { loadLdapConfig } from "./ldap-config.js";

describe("LDAP config", () => {
  it("refuses plaintext ldap:// without StartTLS", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      }),
    ).toThrow(/plaintext LDAP refused/);
  });

  it("accepts ldaps://", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
    });
    expect(cfg.url).toMatch(/^ldaps:/);
    expect(cfg.verifyTls).toBe(true);
  });

  it("accepts ldap:// only with StartTLS", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
    });
    expect(cfg.starttls).toBe(true);
  });

  it("refuses TLS verification disable without explicit dev mode", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_TLS_INSECURE: "1",
      }),
    ).toThrow(/COLLAB_LDAP_DEV_MODE/);
  });
});
