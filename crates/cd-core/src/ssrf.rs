//! SSRF policy for provider base URLs and probes.

use crate::error::{CoreError, CoreResult};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::Url;

/// Policy for outbound provider HTTP.
#[derive(Debug, Clone)]
pub struct SsrfPolicy {
    /// When true, block RFC1918 / link-local / metadata (default for remote profiles).
    pub block_private: bool,
    /// Allow loopback even when block_private is true (Ollama).
    pub allow_loopback: bool,
}

impl Default for SsrfPolicy {
    fn default() -> Self {
        Self {
            block_private: true,
            allow_loopback: true,
        }
    }
}

impl SsrfPolicy {
    /// Local-only profile: only loopback.
    pub fn local_only() -> Self {
        Self {
            block_private: true,
            allow_loopback: true,
        }
    }

    /// Private corporate gateways: allow RFC1918 with explicit opt-in.
    pub fn allow_private_networks() -> Self {
        Self {
            block_private: false,
            allow_loopback: true,
        }
    }
}

/// Validate a base URL string before any HTTP request.
pub fn validate_provider_url(raw: &str, policy: &SsrfPolicy) -> CoreResult<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CoreError::Config("empty base URL".into()));
    }
    let url = Url::parse(raw).map_err(|e| CoreError::Config(format!("invalid URL: {e}")))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CoreError::Config(format!(
                "unsupported URL scheme `{other}` (use http/https)"
            )));
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::Config("URL missing host".into()))?;
    let host_l = host.to_ascii_lowercase();
    if host_l == "localhost" || host_l.ends_with(".localhost") {
        if policy.allow_loopback {
            return Ok(url);
        }
        return Err(CoreError::Policy("loopback host not allowed".into()));
    }
    // Literal IP (v4 or v6 — url host_str omits brackets for v6).
    if let Ok(ip) = host.parse::<IpAddr>() {
        return check_ip(ip, policy).map(|_| url);
    }
    // Also use typed host from url crate when available.
    if let Some(url::Host::Ipv4(v4)) = url.host() {
        return check_v4(v4, policy).map(|_| url);
    }
    if let Some(url::Host::Ipv6(v6)) = url.host() {
        return check_v6(v6, policy).map(|_| url);
    }
    // Block obvious metadata hostnames
    if host_l == "metadata.google.internal" || host_l.ends_with(".internal") && policy.block_private
    {
        return Err(CoreError::Policy(format!(
            "blocked host `{host}` (internal/metadata)"
        )));
    }
    // Hostname without resolving: cannot know private IP; allow DNS names when
    // block_private (public DNS). Callers that need full protection may resolve
    // separately. Block well-known cloud metadata.
    if host_l == "169.254.169.254" {
        return Err(CoreError::Policy("blocked link-local metadata IP".into()));
    }
    Ok(url)
}

fn check_ip(ip: IpAddr, policy: &SsrfPolicy) -> CoreResult<()> {
    match ip {
        IpAddr::V4(v4) => check_v4(v4, policy),
        IpAddr::V6(v6) => check_v6(v6, policy),
    }
}

fn check_v4(ip: Ipv4Addr, policy: &SsrfPolicy) -> CoreResult<()> {
    if ip.is_loopback() {
        return if policy.allow_loopback {
            Ok(())
        } else {
            Err(CoreError::Policy("loopback not allowed".into()))
        };
    }
    if ip.is_unspecified() || ip.is_broadcast() {
        return Err(CoreError::Policy("invalid destination IP".into()));
    }
    // AWS/GCP metadata
    if ip.octets() == [169, 254, 169, 254] {
        return Err(CoreError::Policy("blocked metadata IP".into()));
    }
    if ip.is_link_local() {
        return Err(CoreError::Policy("blocked link-local IP".into()));
    }
    if policy.block_private && (ip.is_private() || is_cgnat(ip)) {
        return Err(CoreError::Policy(format!(
            "blocked private IP {ip}; enable private-network override for corp gateways"
        )));
    }
    Ok(())
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0b1100_0000) == 0b0100_0000 // 100.64/10
}

fn check_v6(ip: Ipv6Addr, policy: &SsrfPolicy) -> CoreResult<()> {
    // Unmap IPv4-mapped addresses (::ffff:a.b.c.d) before checks.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return check_v4(v4, policy);
    }
    // Also handle obsolete IPv4-compatible (deprecated but still seen).
    if let Some(v4) = ip.to_ipv4() {
        if !ip.is_loopback() {
            return check_v4(v4, policy);
        }
    }
    if ip.is_loopback() {
        return if policy.allow_loopback {
            Ok(())
        } else {
            Err(CoreError::Policy("loopback not allowed".into()))
        };
    }
    if ip.is_unspecified() {
        return Err(CoreError::Policy("invalid destination IP".into()));
    }
    if policy.block_private && (ip.is_unique_local() || is_v6_link_local(ip)) {
        return Err(CoreError::Policy(format!("blocked private IPv6 {ip}")));
    }
    Ok(())
}

fn is_v6_link_local(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    (s[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_https() {
        let u =
            validate_provider_url("https://api.example.com/v1", &SsrfPolicy::default()).unwrap();
        assert_eq!(u.host_str(), Some("api.example.com"));
    }

    #[test]
    fn allows_loopback_for_ollama() {
        validate_provider_url("http://127.0.0.1:11434", &SsrfPolicy::default()).unwrap();
        validate_provider_url("http://localhost:11434", &SsrfPolicy::default()).unwrap();
    }

    #[test]
    fn blocks_metadata_and_private() {
        assert!(validate_provider_url("http://169.254.169.254/", &SsrfPolicy::default()).is_err());
        assert!(validate_provider_url("http://10.0.0.5/v1", &SsrfPolicy::default()).is_err());
        assert!(validate_provider_url("http://192.168.1.1/v1", &SsrfPolicy::default()).is_err());
    }

    #[test]
    fn private_override_allows_rfc1918() {
        let p = SsrfPolicy::allow_private_networks();
        validate_provider_url("http://10.0.0.5/v1", &p).unwrap();
    }

    #[test]
    fn rejects_file_scheme() {
        assert!(validate_provider_url("file:///etc/passwd", &SsrfPolicy::default()).is_err());
    }

    #[test]
    fn blocks_ipv4_mapped_metadata() {
        assert!(
            validate_provider_url("http://[::ffff:169.254.169.254]/", &SsrfPolicy::default())
                .is_err()
        );
        assert!(
            validate_provider_url("http://[::ffff:10.0.0.1]/", &SsrfPolicy::default()).is_err()
        );
    }
}
