# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue** for vulnerabilities that could enable credential theft, remote code execution, unauthorized data access, or write-gate bypass.

### Preferred private channel

1. **GitHub Private Vulnerability Reporting** (Security Advisories) for this repository.  
   **Operator action (required for this path to work):** repo Settings → Security → *Private vulnerability reporting* → Enable.  
   Until that toggle is on, reporters cannot use Advisories for this repo.

2. **Fallback while the toggle is off:** contact the maintainer via a **private GitHub message** to the repository owner (`@chriscase`) — do not paste exploit details in public issues, discussions, or pull requests.

We aim to acknowledge reports within **7 days** and to share a remediation plan or status update within **30 days** for in-scope, reproducible issues.

### In-scope surface (high priority)

- Keychain / secret handling (IPC must stay DTO/bool-only; no secret strings in the webview)
- SSRF on provider probes, chat, and web tools (including DNS rebinding / private & metadata IPs)
- Filesystem path traversal outside allowlisted workspace roots
- Write-gate / HardWrite bypass (permission grants must not evaporate or auto-allow silently)
- Untrusted tool/content injection into the model context

### Out of scope (examples)

- Denial of service from local resource exhaustion alone
- Issues that require physical access to an unlocked machine already holding keychain items
- Social engineering of the user into pasting secrets into chat

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

Security fixes target the default branch (`main`). When tagged releases exist (see release engineering / #172), critical fixes will be called out against the latest published tag; until then, **`main` is the only supported line**.

## Coordination with community templates

When issue/PR templates land (#175), their security contact link must name the same channels as this file (Private Vulnerability Reporting when enabled, otherwise private maintainer contact).
