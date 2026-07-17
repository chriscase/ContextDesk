# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories for this repository, or by contacting the maintainer through GitHub.

Do **not** open a public issue for vulnerabilities that could enable credential theft, remote code execution, or unauthorized data access.

## Design expectations

ContextDesk may hold API keys, session tokens discovered from local auth files (with user opt-in), database credentials, and tool access to local files and remote systems.

Contributors must:

- Never commit secrets, tokens, private URLs with embedded credentials, or real employer-specific configuration.
- Keep credentials in the OS keychain or env vars; never in the webview/renderer.
- Treat tool results as untrusted data (prompt-injection resistant design).
- Default to deny for writes; require explicit user confirmation for HardWrite.
- Prefer read-only database roles and allowlisted filesystem roots.
- Not introduce unrestricted shell or free-form HTTP tools without a strong security review.

## Supported versions

Security fixes target the default branch (`main`) until versioned releases are published.
