//! Atlassian Rovo MCP connector preset (#291).
//!
//! ContextDesk remains an MCP host, not a native Jira client. The preset turns
//! a small secret-free connector entry into a locked-down `mcp-remote` stdio
//! configuration. The API token is resolved from the OS keychain and injected
//! only into the child environment.

use base64::Engine as _;
use cd_core::connectors::{validate_mcp_command, ConnectorConfig};
use cd_core::keychain_store::{looks_like_raw_secret, SecretStore};
use cd_core::ssrf::{resolve_and_validate, validate_provider_url, DnsResolver, SsrfPolicy};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;

pub(crate) const ATLASSIAN_ROVO_PRESET: &str = "atlassian_rovo";
pub(crate) const ATLASSIAN_ROVO_ENDPOINT: &str = "https://mcp.atlassian.com/v1/mcp";
pub(crate) const ATLASSIAN_AUTH_ENV: &str = "CONTEXTDESK_ATLASSIAN_AUTH_HEADER";

const READ_TOOLS: &[&str] = &[
    "atlassianUserInfo",
    "getAccessibleAtlassianResources",
    "getJiraIssue",
    "getJiraIssueRemoteIssueLinks",
    "getJiraIssueTypeMetaWithFields",
    "getJiraProjectIssueTypesMetadata",
    "getIssueLinkTypes",
    "getTransitionsForJiraIssue",
    "getVisibleJiraProjects",
    "lookupJiraAccountId",
    "searchJiraIssuesUsingJql",
];

const HARD_WRITE_TOOLS: &[&str] = &[
    "addCommentToJiraIssue",
    "addWorklogToJiraIssue",
    "createJiraIssue",
    "editJiraIssue",
    "transitionJiraIssue",
];

pub(crate) type McpConnectorEnv = HashMap<String, HashMap<String, String>>;

pub(crate) struct PreparedConnectors {
    pub(crate) connectors: Vec<ConnectorConfig>,
    pub(crate) mcp_env: McpConnectorEnv,
}

fn remote_ssrf_policy() -> SsrfPolicy {
    SsrfPolicy {
        block_private: true,
        allow_loopback: false,
    }
}

fn string_setting<'a>(connector: &'a ConnectorConfig, name: &str) -> Result<&'a str, String> {
    connector
        .settings
        .get(name)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Atlassian Rovo connector '{}' requires settings.{name}",
                connector.id
            )
        })
}

fn auth_header(connector: &ConnectorConfig, token: &str) -> Result<String, String> {
    match connector
        .settings
        .get("auth_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("service_bearer")
    {
        "service_bearer" => Ok(format!("Bearer {}", token.trim())),
        "personal_basic" => {
            let email = string_setting(connector, "email")?;
            let credential = format!("{email}:{}", token.trim());
            Ok(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credential)
            ))
        }
        other => Err(format!(
            "Atlassian Rovo connector '{}' has unsupported auth_kind '{other}'",
            connector.id
        )),
    }
}

fn prepare_rovo_connector<S: SecretStore, R: DnsResolver>(
    connector: &ConnectorConfig,
    secrets: &S,
    resolver: &R,
) -> Result<(ConnectorConfig, HashMap<String, String>), String> {
    let endpoint = connector
        .settings
        .get("base_url")
        .and_then(|value| value.as_str())
        .unwrap_or(ATLASSIAN_ROVO_ENDPOINT)
        .trim();
    if endpoint != ATLASSIAN_ROVO_ENDPOINT {
        return Err(format!(
            "Atlassian Rovo connector '{}' must use the fixed official endpoint {ATLASSIAN_ROVO_ENDPOINT}",
            connector.id
        ));
    }
    let url = validate_provider_url(endpoint, &remote_ssrf_policy())
        .map_err(|error| format!("Atlassian Rovo endpoint: {error}"))?;
    resolve_and_validate(&url, &remote_ssrf_policy(), resolver)
        .map_err(|error| format!("Atlassian Rovo endpoint failed SSRF/DNS validation: {error}"))?;

    let command = PathBuf::from(string_setting(connector, "command")?);
    validate_mcp_command(&command)
        .map_err(|error| format!("Atlassian Rovo mcp-remote command: {error}"))?;

    let api_key_ref = string_setting(connector, "api_key_ref")?;
    if looks_like_raw_secret(api_key_ref) || !api_key_ref.contains('/') {
        return Err(format!(
            "Atlassian Rovo connector '{}' api_key_ref must be a keychain reference, never token material",
            connector.id
        ));
    }
    let token = secrets
        .get(api_key_ref)
        .map_err(|_| {
            format!(
                "failed to read Atlassian API token keychain ref '{}'",
                api_key_ref
            )
        })?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing Atlassian API token keychain ref '{}'", api_key_ref))?;
    let header = auth_header(connector, &token)?;

    let normalized = ConnectorConfig {
        id: connector.id.clone(),
        kind: "mcp".into(),
        enabled: connector.enabled,
        settings: json!({
            "name": connector.id,
            "command": command,
            "args": [
                ATLASSIAN_ROVO_ENDPOINT,
                "--header",
                format!("Authorization:${{{ATLASSIAN_AUTH_ENV}}}"),
                "--transport",
                "http-only",
                "--silent"
            ],
            "read_tools": READ_TOOLS,
            "hard_write_tools": HARD_WRITE_TOOLS
        }),
    };
    let env = HashMap::from([(ATLASSIAN_AUTH_ENV.to_string(), header)]);
    Ok((normalized, env))
}

pub(crate) fn prepare_connectors<S: SecretStore, R: DnsResolver>(
    connectors: &[ConnectorConfig],
    secrets: &S,
    resolver: &R,
) -> Result<PreparedConnectors, String> {
    let mut prepared = Vec::with_capacity(connectors.len());
    let mut mcp_env = HashMap::new();
    for connector in connectors {
        let preset = connector
            .settings
            .get("preset")
            .and_then(|value| value.as_str());
        if connector.enabled && connector.kind == "mcp" && preset == Some(ATLASSIAN_ROVO_PRESET) {
            let (connector, env) = prepare_rovo_connector(connector, secrets, resolver)?;
            mcp_env.insert(connector.id.clone(), env);
            prepared.push(connector);
        } else {
            prepared.push(connector.clone());
        }
    }
    Ok(PreparedConnectors {
        connectors: prepared,
        mcp_env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::keychain_store::MemorySecretStore;
    use cd_core::ssrf::MapResolver;
    use std::net::{IpAddr, Ipv4Addr};

    fn resolver(ip: Ipv4Addr) -> MapResolver {
        MapResolver::from_pairs([("mcp.atlassian.com", vec![IpAddr::V4(ip)])])
    }

    fn connector(command: &str) -> ConnectorConfig {
        ConnectorConfig {
            id: "jira".into(),
            kind: "mcp".into(),
            enabled: true,
            settings: json!({
                "preset": ATLASSIAN_ROVO_PRESET,
                "command": command,
                "api_key_ref": "connector/jira/api_key",
                "auth_kind": "service_bearer"
            }),
        }
    }

    #[test]
    fn preset_resolves_keychain_secret_without_serializing_it() {
        let secrets = MemorySecretStore::new();
        secrets
            .set("connector/jira/api_key", "fixture-token-never-on-disk")
            .unwrap();
        let command = std::env::current_exe().unwrap();
        let prepared = prepare_connectors(
            &[connector(command.to_str().unwrap())],
            &secrets,
            &resolver(Ipv4Addr::new(93, 184, 216, 34)),
        )
        .unwrap();
        let normalized = &prepared.connectors[0];
        assert_eq!(normalized.settings["name"], "jira");
        assert!(normalized.settings["read_tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "getJiraIssue"));
        assert!(normalized.settings["hard_write_tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "createJiraIssue"));
        let serialized = serde_json::to_string(normalized).unwrap();
        assert!(!serialized.contains("fixture-token-never-on-disk"));
        assert!(!serialized.contains("connector/jira/api_key"));
        assert_eq!(
            prepared.mcp_env["jira"][ATLASSIAN_AUTH_ENV],
            "Bearer fixture-token-never-on-disk"
        );
    }

    #[test]
    fn personal_token_uses_basic_header_only_in_child_environment() {
        let secrets = MemorySecretStore::new();
        secrets
            .set("connector/jira/api_key", "personal-token")
            .unwrap();
        let command = std::env::current_exe().unwrap();
        let mut config = connector(command.to_str().unwrap());
        config.settings["auth_kind"] = json!("personal_basic");
        config.settings["email"] = json!("person@example.com");
        let prepared = prepare_connectors(
            &[config],
            &secrets,
            &resolver(Ipv4Addr::new(93, 184, 216, 34)),
        )
        .unwrap();
        let expected =
            base64::engine::general_purpose::STANDARD.encode("person@example.com:personal-token");
        assert_eq!(
            prepared.mcp_env["jira"][ATLASSIAN_AUTH_ENV],
            format!("Basic {expected}")
        );
    }

    #[test]
    fn preset_rejects_custom_or_private_endpoint_and_raw_token_ref() {
        let secrets = MemorySecretStore::new();
        secrets
            .set("connector/jira/api_key", "keychain-token")
            .unwrap();
        let command = std::env::current_exe().unwrap();
        let mut custom = connector(command.to_str().unwrap());
        custom.settings["base_url"] = json!("https://example.com/mcp");
        assert!(prepare_connectors(
            &[custom],
            &secrets,
            &resolver(Ipv4Addr::new(93, 184, 216, 34))
        )
        .err()
        .unwrap()
        .contains("fixed official endpoint"));

        assert!(prepare_connectors(
            &[connector(command.to_str().unwrap())],
            &secrets,
            &resolver(Ipv4Addr::new(127, 0, 0, 1))
        )
        .err()
        .unwrap()
        .contains("SSRF"));

        let mut raw = connector(command.to_str().unwrap());
        raw.settings["api_key_ref"] = json!("ATATT3xFfGF0raw-token-material");
        assert!(
            prepare_connectors(&[raw], &secrets, &resolver(Ipv4Addr::new(93, 184, 216, 34)))
                .err()
                .unwrap()
                .contains("keychain reference")
        );
    }

    #[test]
    fn disabled_preset_does_not_resolve_dns_or_keychain() {
        let secrets = MemorySecretStore::new();
        let command = std::env::current_exe().unwrap();
        let mut disabled = connector(command.to_str().unwrap());
        disabled.enabled = false;
        let original = disabled.clone();

        let prepared = prepare_connectors(
            &[disabled],
            &secrets,
            &resolver(Ipv4Addr::new(127, 0, 0, 1)),
        )
        .unwrap();

        assert_eq!(prepared.connectors, vec![original]);
        assert!(prepared.mcp_env.is_empty());
    }
}
