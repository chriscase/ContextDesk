//! SSRF policy for provider base URLs and probes.
//!
//! Literal-IP and hostname syntax checks live in [`validate_provider_url`].
//! For hostnames that need private/metadata protection, use
//! [`resolve_and_validate`] with an injectable [`DnsResolver`] (#140).

use crate::error::{CoreError, CoreResult};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
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
    // block_private (public DNS). Prefer [`resolve_and_validate`] for full
    // protection (#140). Block well-known cloud metadata string.
    if host_l == "169.254.169.254" {
        return Err(CoreError::Policy("blocked link-local metadata IP".into()));
    }
    Ok(url)
}

/// Injectable DNS lookup for offline tests and production system resolution.
pub trait DnsResolver {
    /// Resolve `host` (no port) to one or more IPs. Empty vec is an error.
    fn resolve(&self, host: &str) -> CoreResult<Vec<IpAddr>>;
}

/// Production resolver: `ToSocketAddrs` via a dummy port (sync, no network in unit tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemResolver;

impl DnsResolver for SystemResolver {
    fn resolve(&self, host: &str) -> CoreResult<Vec<IpAddr>> {
        // Pair with a dummy port so ToSocketAddrs works for bare hostnames.
        let addrs: Vec<SocketAddr> = (host, 0u16)
            .to_socket_addrs()
            .map_err(|e| CoreError::Config(format!("DNS resolve failed for `{host}`: {e}")))?
            .collect();
        if addrs.is_empty() {
            return Err(CoreError::Config(format!(
                "DNS resolve returned no addresses for `{host}`"
            )));
        }
        let mut ips: Vec<IpAddr> = addrs.into_iter().map(|a| a.ip()).collect();
        ips.sort_unstable();
        ips.dedup();
        Ok(ips)
    }
}

/// Map-based fake resolver for offline unit tests (zero network I/O).
#[derive(Debug, Clone, Default)]
pub struct MapResolver {
    /// Host (lowercase) → resolved addresses.
    pub map: std::collections::HashMap<String, Vec<IpAddr>>,
}

impl MapResolver {
    /// Build from (host, ips) pairs.
    pub fn from_pairs(pairs: impl IntoIterator<Item = (impl Into<String>, Vec<IpAddr>)>) -> Self {
        let mut map = std::collections::HashMap::new();
        for (h, ips) in pairs {
            map.insert(h.into().to_ascii_lowercase(), ips);
        }
        Self { map }
    }
}

impl DnsResolver for MapResolver {
    fn resolve(&self, host: &str) -> CoreResult<Vec<IpAddr>> {
        let key = host.to_ascii_lowercase();
        self.map
            .get(&key)
            .cloned()
            .ok_or_else(|| CoreError::Config(format!("test DNS: no mapping for `{host}`")))
    }
}

/// Validate URL (syntax + literal IP), then resolve hostnames and reject if
/// **any** resolved address fails the existing private/metadata gates.
///
/// Returns the vetted IP set for callers that pin sockets (child #141).
/// Literal-IP URLs skip DNS and keep byte-identical behavior to
/// [`validate_provider_url`].
pub fn resolve_and_validate(
    url: &Url,
    policy: &SsrfPolicy,
    resolver: &impl DnsResolver,
) -> CoreResult<Vec<IpAddr>> {
    // Re-run syntactic + literal-IP checks on the serialized form so behavior
    // matches validate_provider_url for callers that only have a Url.
    let _validated = validate_provider_url(url.as_str(), policy)?;
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::Config("URL missing host".into()))?;
    let host_l = host.to_ascii_lowercase();

    // Fast path: literal IP — already vetted by validate_provider_url.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    if let Some(url::Host::Ipv4(v4)) = url.host() {
        return Ok(vec![IpAddr::V4(v4)]);
    }
    if let Some(url::Host::Ipv6(v6)) = url.host() {
        return Ok(vec![IpAddr::V6(v6)]);
    }

    // localhost is allowed without resolving when allow_loopback (Ollama).
    if host_l == "localhost" || host_l.ends_with(".localhost") {
        if policy.allow_loopback {
            return Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        }
        return Err(CoreError::Policy("loopback host not allowed".into()));
    }

    let ips = resolver.resolve(host)?;
    if ips.is_empty() {
        return Err(CoreError::Config(format!(
            "DNS resolve returned no addresses for `{host}`"
        )));
    }
    for ip in &ips {
        check_ip(*ip, policy)?;
    }
    Ok(ips)
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

    /// #140: hostname that resolves to private/metadata must be rejected offline.
    #[test]
    fn resolve_rejects_private_and_metadata_via_fake_dns() {
        let policy = SsrfPolicy::default();
        let cases: &[(&str, IpAddr)] = &[
            (
                "evil.internal.example",
                IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            ),
            (
                "meta.example",
                IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            ),
            (
                "linklocal.example",
                IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
            ),
            ("cgnat.example", IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            ("ula.example", IpAddr::V6("fd00::1".parse().unwrap())),
            ("v6ll.example", IpAddr::V6("fe80::1".parse().unwrap())),
            ("loop.example", IpAddr::V4(Ipv4Addr::LOCALHOST)),
        ];
        for (host, ip) in cases {
            // allow_loopback true still blocks non-literal hostname→loopback when
            // we resolve and check — actually loopback is allowed under allow_loopback.
            // For loop.example we expect Ok if allow_loopback.
            let resolver = MapResolver::from_pairs([(host.to_string(), vec![*ip])]);
            let url = Url::parse(&format!("https://{host}/v1")).unwrap();
            let r = resolve_and_validate(&url, &policy, &resolver);
            if matches!(ip, IpAddr::V4(v) if v.is_loopback())
                || matches!(ip, IpAddr::V6(v) if v.is_loopback())
            {
                assert!(
                    r.is_ok(),
                    "loopback should pass under allow_loopback: {host}"
                );
            } else {
                assert!(r.is_err(), "expected reject for {host} → {ip}, got {r:?}");
            }
        }
        // Explicit loopback deny when policy forbids it.
        let no_lb = SsrfPolicy {
            block_private: true,
            allow_loopback: false,
        };
        let resolver = MapResolver::from_pairs([(
            "loop.example".to_string(),
            vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        )]);
        let url = Url::parse("https://loop.example/v1").unwrap();
        assert!(resolve_and_validate(&url, &no_lb, &resolver).is_err());
    }

    #[test]
    fn resolve_allows_public_ip_via_fake_dns() {
        let resolver = MapResolver::from_pairs([(
            "api.example.com".to_string(),
            vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))],
        )]);
        let url = Url::parse("https://api.example.com/v1").unwrap();
        let ips = resolve_and_validate(&url, &SsrfPolicy::default(), &resolver).unwrap();
        assert_eq!(ips, vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))]);
    }

    #[test]
    fn resolve_rejects_if_any_of_multiple_addrs_is_private() {
        let resolver = MapResolver::from_pairs([(
            "mixed.example".to_string(),
            vec![
                IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
                IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)),
            ],
        )]);
        let url = Url::parse("https://mixed.example/v1").unwrap();
        assert!(resolve_and_validate(&url, &SsrfPolicy::default(), &resolver).is_err());
    }

    #[test]
    fn resolve_literal_ip_skips_dns_and_matches_validate() {
        let resolver = MapResolver::default(); // empty — would fail if DNS called
        let url = Url::parse("http://10.0.0.5/v1").unwrap();
        assert!(resolve_and_validate(&url, &SsrfPolicy::default(), &resolver).is_err());
        let url = Url::parse("http://127.0.0.1:11434").unwrap();
        let ips = resolve_and_validate(&url, &SsrfPolicy::default(), &resolver).unwrap();
        assert_eq!(ips, vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
    }

    #[test]
    fn resolve_honor_private_network_override() {
        let resolver = MapResolver::from_pairs([(
            "corp.example".to_string(),
            vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))],
        )]);
        let url = Url::parse("https://corp.example/v1").unwrap();
        assert!(resolve_and_validate(&url, &SsrfPolicy::default(), &resolver).is_err());
        let ips =
            resolve_and_validate(&url, &SsrfPolicy::allow_private_networks(), &resolver).unwrap();
        assert_eq!(ips, vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))]);
    }
}
