import { describe, expect, it } from "vitest";
import { ldapClientOptions, ldapTlsOptions } from "./ldap-adapter.js";
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

  it("omits constructor tlsOptions so StartTLS can upgrade a plaintext socket", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
    });
    expect(ldapClientOptions(cfg).tlsOptions).toBeUndefined();
    expect(ldapTlsOptions(cfg).rejectUnauthorized).toBe(true);
  });

  it("uses insecure fixture TLS options that Node can negotiate with osixia", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://127.0.0.1:636",
      COLLAB_LDAP_TLS_INSECURE: "1",
      COLLAB_LDAP_DEV_MODE: "1",
    });
    const tls = ldapClientOptions(cfg).tlsOptions;
    expect(tls?.rejectUnauthorized).toBe(false);
    expect(tls?.ecdhCurve).toBe("auto");
    expect(tls && "ca" in tls).toBe(false);
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
