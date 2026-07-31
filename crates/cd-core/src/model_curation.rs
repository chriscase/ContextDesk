//! Curated provider/model visibility (#678).
//!
//! Discovery can return a long or personally named inventory. This module lets
//! a user narrow what ordinary pickers offer — hide a whole provider profile,
//! hide individual models, pin the ones they actually use — **without deleting
//! anything**. Nothing here removes a provider profile, a credential
//! reference, a locally installed model, or any remote resource; it only
//! records display preferences.
//!
//! It is explicitly *not* a security or redaction boundary. A hidden model is
//! still configured, still reachable by an explicit selection that already
//! names it, and still listed by the management surface. Callers must never
//! present hiding as protection (see #653 for public-capture guidance).
//!
//! ## Scope identity
//!
//! Curation is keyed by **provider kind + endpoint identity + model id**, not
//! by the profile's display label:
//!
//! - Renaming a profile keeps its curation (the upstream is the same).
//! - Repointing a profile at a different `base_url` does *not* carry curation
//!   across, because that is a different inventory. The old entries stay in
//!   config, inert, so pointing back restores the user's choices.
//! - Two profiles of the same kind aimed at the same endpoint are the same
//!   upstream and therefore share one curation scope.
//! - Session-based kinds with no URL fall back to the profile id, so distinct
//!   profiles stay distinct.
//!
//! That is what keeps two providers that both expose `llama3` curated
//! independently.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::providers::{ProviderKind, ProviderProfile};

/// Schema version written by this build.
///
/// v1 joined key components with U+001F and assumed that byte could not occur
/// inside a provider kind, endpoint, or model id. Model ids come from a remote
/// API and are arbitrary strings, so that was an assumption about data this
/// process does not control. v2 length-prefixes every component instead.
pub const CURATION_VERSION: u32 = 2;

/// Identity of one curation scope: an exact upstream inventory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurationScope {
    kind: ProviderKind,
    endpoint: String,
}

impl CurationScope {
    /// Derive the scope for a profile.
    pub fn for_profile(profile: &ProviderProfile) -> Self {
        Self {
            kind: profile.kind,
            endpoint: normalize_endpoint(&profile.base_url, &profile.id),
        }
    }

    /// Stable key for the provider profile as a whole.
    pub fn provider_key(&self) -> String {
        format!(
            "p:v2:{}{}",
            encode_component(kind_slug(self.kind)),
            encode_component(&self.endpoint)
        )
    }

    /// Stable key for one model inside this scope.
    pub fn model_key(&self, model_id: &str) -> String {
        format!(
            "m:v2:{}{}{}",
            encode_component(kind_slug(self.kind)),
            encode_component(&self.endpoint),
            encode_component(model_id.trim())
        )
    }

    /// Prefix shared by every model key in this scope.
    ///
    /// Note this is *not* `model_key("")`: the length prefix of the model
    /// component differs per model, so an empty model does not prefix a
    /// non-empty one. Because the endpoint is itself length-prefixed, this
    /// prefix cannot bleed into a longer endpoint.
    pub fn model_key_prefix(&self) -> String {
        format!(
            "m:v2:{}{}",
            encode_component(kind_slug(self.kind)),
            encode_component(&self.endpoint)
        )
    }

    /// The v1 form of [`Self::model_key_prefix`].
    pub fn legacy_model_key_prefix(&self) -> String {
        format!(
            "m:v1:{}{LEGACY_SEP}{}{LEGACY_SEP}",
            kind_slug(self.kind),
            self.endpoint
        )
    }

    /// The v1 form of [`Self::provider_key`], for reading configs written
    /// before the encoding changed.
    pub fn legacy_provider_key(&self) -> String {
        format!("p:v1:{}{LEGACY_SEP}{}", kind_slug(self.kind), self.endpoint)
    }

    /// The v1 form of [`Self::model_key`].
    pub fn legacy_model_key(&self, model_id: &str) -> String {
        format!(
            "m:v1:{}{LEGACY_SEP}{}{LEGACY_SEP}{}",
            kind_slug(self.kind),
            self.endpoint,
            model_id.trim()
        )
    }
}

/// Length-prefix one component: `<byte length>:<bytes>`.
///
/// This is what makes a composite key unambiguous *without* assuming anything
/// about the component's contents. Parsing reads the decimal length, then takes
/// exactly that many bytes, so distinct tuples cannot produce the same string —
/// even when a component contains the delimiter, the old separator, or is
/// empty.
fn encode_component(value: &str) -> String {
    format!("{}:{}", value.len(), value)
}

/// v1 separator, retained only to read and upgrade existing configs.
///
/// v1 assumed U+001F could not appear in a kind, endpoint, or model id. Model
/// ids are supplied by the provider, so nothing enforced that.
const LEGACY_SEP: char = '\u{1f}';

/// Rewrite a v1 key in the v2 encoding.
///
/// Returns `None` when the legacy key cannot be split unambiguously — that is
/// precisely the case v1 could not represent, so there is no correct v2 form
/// and the original is kept verbatim rather than guessed at or dropped.
fn upgrade_legacy_key(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("m:v1:") {
        let parts: Vec<&str> = rest.split(LEGACY_SEP).collect();
        if parts.len() == 3 {
            return Some(format!(
                "m:v2:{}{}{}",
                encode_component(parts[0]),
                encode_component(parts[1]),
                encode_component(parts[2])
            ));
        }
        return None;
    }
    if let Some(rest) = key.strip_prefix("p:v1:") {
        let parts: Vec<&str> = rest.split(LEGACY_SEP).collect();
        if parts.len() == 2 {
            return Some(format!(
                "p:v2:{}{}",
                encode_component(parts[0]),
                encode_component(parts[1])
            ));
        }
        return None;
    }
    None
}

fn kind_slug(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Ollama => "ollama",
        ProviderKind::OpenAiCompatible => "openai_compatible",
        ProviderKind::Anthropic => "anthropic",
        ProviderKind::XaiGrokBuild => "xai_grok_build",
    }
}

/// Endpoint identity: the base URL when there is one, else the profile id.
///
/// Trailing slashes and case in the scheme/host are not meaningful, so they are
/// normalized — otherwise `http://Host:11434/` and `http://host:11434` would
/// curate separately and the user's choices would appear to vanish.
fn normalize_endpoint(base_url: &str, profile_id: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return profile_id.trim().to_string();
    }
    match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = match rest.split_once('/') {
                Some((a, p)) => (a, Some(p)),
                None => (rest, None),
            };
            let mut out = format!(
                "{}://{}",
                scheme.to_ascii_lowercase(),
                authority.to_ascii_lowercase()
            );
            if let Some(p) = path {
                if !p.is_empty() {
                    out.push('/');
                    out.push_str(p);
                }
            }
            out
        }
        None => trimmed.to_ascii_lowercase(),
    }
}

/// Why a model is not offered by ordinary pickers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HiddenBy {
    /// The whole provider profile is hidden.
    Provider,
    /// This exact model is hidden.
    Model,
}

/// User-curated visibility and ordering. Purely presentational.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelCuration {
    /// Schema version of the persisted shape.
    #[serde(default)]
    pub version: u32,
    /// Provider scope keys the user has hidden.
    #[serde(default)]
    pub hidden_providers: BTreeSet<String>,
    /// Model scope keys the user has hidden.
    #[serde(default)]
    pub hidden_models: BTreeSet<String>,
    /// Model scope keys in explicit user order; index 0 sorts first.
    #[serde(default)]
    pub pinned_models: Vec<String>,
}

impl ModelCuration {
    /// Normalize a freshly loaded value.
    ///
    /// A config written by a *newer* build keeps its version and its entries:
    /// every field is an opaque key set, so round-tripping preserves data this
    /// build does not understand rather than silently dropping the user's
    /// choices. Only duplicates and blanks are cleaned.
    pub fn migrate(&mut self) {
        self.hidden_providers.retain(|k| !k.trim().is_empty());
        self.hidden_models.retain(|k| !k.trim().is_empty());
        let mut seen = BTreeSet::new();
        self.pinned_models
            .retain(|k| !k.trim().is_empty() && seen.insert(k.clone()));

        // Upgrade v1 keys in place. A key that cannot be split unambiguously is
        // kept exactly as written — losing a user's choice is worse than
        // carrying a key this build will only match through the legacy lookup.
        if self.version < 2 {
            self.hidden_providers = self
                .hidden_providers
                .iter()
                .map(|k| upgrade_legacy_key(k).unwrap_or_else(|| k.clone()))
                .collect();
            self.hidden_models = self
                .hidden_models
                .iter()
                .map(|k| upgrade_legacy_key(k).unwrap_or_else(|| k.clone()))
                .collect();
            for key in &mut self.pinned_models {
                if let Some(upgraded) = upgrade_legacy_key(key) {
                    *key = upgraded;
                }
            }
        }

        // Never downgrade: a config from a newer build keeps its version and
        // its entries.
        if self.version < CURATION_VERSION {
            self.version = CURATION_VERSION;
        }
    }

    /// True when the profile itself is hidden.
    pub fn provider_hidden(&self, profile: &ProviderProfile) -> bool {
        let scope = CurationScope::for_profile(profile);
        self.hidden_providers.contains(&scope.provider_key())
            // A config whose v1 key could not be upgraded is still honoured.
            || self.hidden_providers.contains(&scope.legacy_provider_key())
    }

    /// Why this exact provider/model pair is hidden, if it is.
    ///
    /// Provider hiding wins: a model inside a hidden provider reports
    /// `Provider` even if it also carries its own entry, so restoring the
    /// provider does not silently un-hide models the user hid individually.
    pub fn hidden_by(&self, profile: &ProviderProfile, model_id: &str) -> Option<HiddenBy> {
        if self.provider_hidden(profile) {
            return Some(HiddenBy::Provider);
        }
        let scope = CurationScope::for_profile(profile);
        if self.hidden_models.contains(&scope.model_key(model_id))
            || self
                .hidden_models
                .contains(&scope.legacy_model_key(model_id))
        {
            return Some(HiddenBy::Model);
        }
        None
    }

    /// Explicit pin position, lowest first.
    pub fn pinned_rank(&self, profile: &ProviderProfile, model_id: &str) -> Option<u32> {
        let scope = CurationScope::for_profile(profile);
        let key = scope.model_key(model_id);
        let legacy = scope.legacy_model_key(model_id);
        self.pinned_models
            .iter()
            .position(|k| *k == key || *k == legacy)
            .map(|i| i as u32)
    }

    /// Hide or restore a whole profile. Returns true when state changed.
    pub fn set_provider_hidden(&mut self, profile: &ProviderProfile, hidden: bool) -> bool {
        let scope = CurationScope::for_profile(profile);
        let key = scope.provider_key();
        // Any surviving v1 entry is dropped either way, so a write always
        // republishes this scope in the canonical encoding.
        let had_legacy = self.hidden_providers.remove(&scope.legacy_provider_key());
        if hidden {
            self.hidden_providers.insert(key) || had_legacy
        } else {
            self.hidden_providers.remove(&key) || had_legacy
        }
    }

    /// Hide or restore one model. Returns true when state changed.
    pub fn set_model_hidden(
        &mut self,
        profile: &ProviderProfile,
        model_id: &str,
        hidden: bool,
    ) -> bool {
        let scope = CurationScope::for_profile(profile);
        let key = scope.model_key(model_id);
        let legacy = scope.legacy_model_key(model_id);
        let had_legacy = self.hidden_models.remove(&legacy);
        if hidden {
            // Hiding something pinned is contradictory; drop the pin so the
            // picker cannot show a hidden model in its pinned band.
            self.pinned_models.retain(|k| k != &key && k != &legacy);
            self.hidden_models.insert(key) || had_legacy
        } else {
            self.hidden_models.remove(&key) || had_legacy
        }
    }

    /// Pin or unpin one model. Pinning appends at the end of the explicit order.
    pub fn set_model_pinned(
        &mut self,
        profile: &ProviderProfile,
        model_id: &str,
        pinned: bool,
    ) -> bool {
        let scope = CurationScope::for_profile(profile);
        let key = scope.model_key(model_id);
        let legacy = scope.legacy_model_key(model_id);
        let already = self.pinned_models.iter().any(|k| *k == key || *k == legacy);
        if pinned == already {
            return false;
        }
        if pinned {
            // A pinned model must be offered, so pinning restores it.
            self.hidden_models.remove(&key);
            self.hidden_models.remove(&legacy);
            self.pinned_models.push(key);
        } else {
            self.pinned_models.retain(|k| *k != key && *k != legacy);
        }
        true
    }

    /// Drop curation for scopes no longer present in the configuration.
    ///
    /// Deliberately *not* called on profile deletion: a user who removes and
    /// re-adds the same endpoint should get their choices back. This exists for
    /// an explicit "forget hidden choices" action only.
    pub fn retain_scopes(&mut self, profiles: &[ProviderProfile]) {
        let provider_keys: BTreeSet<String> = profiles
            .iter()
            .flat_map(|p| {
                let s = CurationScope::for_profile(p);
                [s.provider_key(), s.legacy_provider_key()]
            })
            .collect();
        // `model_key("")` ends with the separator, so the prefix is terminated:
        // an endpoint of `http://h:1` cannot match keys belonging to
        // `http://h:11`, which a bare colon-joined prefix would have done.
        let model_prefixes: Vec<String> = profiles
            .iter()
            .flat_map(|p| {
                let s = CurationScope::for_profile(p);
                // Both encodings: a v1 key that could not be upgraded still
                // belongs to a live scope and must not be swept away.
                [s.model_key_prefix(), s.legacy_model_key_prefix()]
            })
            .collect();
        self.hidden_providers.retain(|k| provider_keys.contains(k));
        let in_scope = |k: &String| model_prefixes.iter().any(|p| k.starts_with(p.as_str()));
        self.hidden_models.retain(&in_scope);
        self.pinned_models.retain(|k| in_scope(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ProviderCapabilities, ProviderDeadlinePreference};

    fn profile(id: &str, kind: ProviderKind, base_url: &str) -> ProviderProfile {
        ProviderProfile {
            id: id.into(),
            label: format!("label for {id}"),
            kind,
            base_url: base_url.into(),
            api_key_ref: None,
            chat_model: "m".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities::default(),
            local_only: false,
            deadline_preference: ProviderDeadlinePreference::default(),
        }
    }

    #[test]
    fn same_model_name_behind_two_providers_curates_independently() {
        let a = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let b = profile("b", ProviderKind::Ollama, "http://10.0.0.9:11434");
        let mut c = ModelCuration::default();

        c.set_model_hidden(&a, "llama3", true);

        assert_eq!(c.hidden_by(&a, "llama3"), Some(HiddenBy::Model));
        assert_eq!(c.hidden_by(&b, "llama3"), None, "sibling must stay visible");
    }

    /// A provider can return any string as a model id. v1 assumed U+001F could
    /// not appear in one; nothing enforced that, so two distinct tuples could
    /// encode to the same key.
    #[test]
    fn a_model_id_containing_the_old_separator_cannot_collide_with_another_tuple() {
        let sep = '\u{1f}';
        let a = profile("a", ProviderKind::Ollama, "http://h");
        // Endpoint "http://h", model "x<SEP>y" versus endpoint "http://h<SEP>x",
        // model "y": identical once joined on the separator.
        let b = profile("b", ProviderKind::Ollama, &format!("http://h{sep}x"));

        let key_a = CurationScope::for_profile(&a).model_key(&format!("x{sep}y"));
        let key_b = CurationScope::for_profile(&b).model_key("y");
        assert_ne!(key_a, key_b, "length-prefixed keys must stay distinct");

        // The v1 encoding these replace really did collide.
        assert_eq!(
            CurationScope::for_profile(&a).legacy_model_key(&format!("x{sep}y")),
            CurationScope::for_profile(&b).legacy_model_key("y"),
            "this is the v1 defect the new encoding removes"
        );

        let mut c = ModelCuration::default();
        c.set_model_hidden(&a, &format!("x{sep}y"), true);
        assert_eq!(c.hidden_by(&a, &format!("x{sep}y")), Some(HiddenBy::Model));
        assert_eq!(
            c.hidden_by(&b, "y"),
            None,
            "hiding one model must not hide an unrelated model on another endpoint"
        );
    }

    #[test]
    fn a_provider_key_cannot_collide_with_a_model_key_component() {
        // An endpoint that itself looks like a length-prefixed pair.
        let a = profile("a", ProviderKind::Ollama, "http://h");
        let odd = profile("b", ProviderKind::Ollama, "5:hello");
        assert_ne!(
            CurationScope::for_profile(&a).model_key("5:hello"),
            CurationScope::for_profile(&odd).model_key(""),
        );
    }

    #[test]
    fn an_empty_model_component_is_encoded_unambiguously() {
        let p = profile("a", ProviderKind::Ollama, "http://h");
        let scope = CurationScope::for_profile(&p);

        // Whitespace-only is trimmed to empty, deliberately.
        assert_eq!(scope.model_key(""), scope.model_key("  "));
        // But an empty model is not the scope's provider key, and does not
        // prefix a non-empty model.
        assert_ne!(scope.model_key(""), scope.provider_key());
        assert!(!scope.model_key("m1").starts_with(&scope.model_key("")));
        // The scope prefix, however, does cover both.
        assert!(scope.model_key("m1").starts_with(&scope.model_key_prefix()));
        assert!(scope.model_key("").starts_with(&scope.model_key_prefix()));
    }

    #[test]
    fn a_v1_config_still_hides_what_the_user_hid() {
        let p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let scope = CurationScope::for_profile(&p);
        // Exactly what a pre-upgrade config on disk contains.
        let mut c = ModelCuration {
            version: 1,
            hidden_models: BTreeSet::from([scope.legacy_model_key("llama3")]),
            hidden_providers: BTreeSet::from([scope.legacy_provider_key()]),
            pinned_models: vec![scope.legacy_model_key("mistral")],
        };

        c.migrate();

        assert_eq!(c.version, CURATION_VERSION);
        assert_eq!(c.hidden_by(&p, "llama3"), Some(HiddenBy::Provider));
        assert_eq!(c.pinned_rank(&p, "mistral"), Some(0));

        // Canonical republishing: the upgraded entries are in the v2 encoding.
        assert!(c.hidden_models.contains(&scope.model_key("llama3")));
        assert!(c.hidden_providers.contains(&scope.provider_key()));
        assert_eq!(c.pinned_models, vec![scope.model_key("mistral")]);
    }

    #[test]
    fn an_unconvertible_v1_key_is_kept_and_still_honoured() {
        let sep = '\u{1f}';
        // A v1 key whose model id contained the separator cannot be split
        // unambiguously, so there is no correct v2 form for it.
        let p = profile("a", ProviderKind::Ollama, "http://h");
        let scope = CurationScope::for_profile(&p);
        let ambiguous = scope.legacy_model_key(&format!("x{sep}y"));
        let mut c = ModelCuration {
            version: 1,
            hidden_models: BTreeSet::from([ambiguous.clone()]),
            ..Default::default()
        };

        c.migrate();

        assert!(
            c.hidden_models.contains(&ambiguous),
            "an unconvertible choice must be kept verbatim, never dropped"
        );
        assert_eq!(
            c.hidden_by(&p, &format!("x{sep}y")),
            Some(HiddenBy::Model),
            "and must still be honoured through the legacy lookup"
        );
    }

    #[test]
    fn writing_over_a_legacy_entry_republishes_it_canonically() {
        let p = profile("a", ProviderKind::Ollama, "http://h");
        let scope = CurationScope::for_profile(&p);
        let mut c = ModelCuration {
            version: 1,
            hidden_models: BTreeSet::from([scope.legacy_model_key("llama3")]),
            ..Default::default()
        };
        // No migrate(): simulate a legacy entry reached by a write directly.

        c.set_model_hidden(&p, "llama3", true);

        assert!(c.hidden_models.contains(&scope.model_key("llama3")));
        assert!(
            !c.hidden_models.contains(&scope.legacy_model_key("llama3")),
            "the write must not leave both encodings behind"
        );
        assert_eq!(c.hidden_models.len(), 1);
    }

    #[test]
    fn restoring_a_legacy_entry_actually_restores_it() {
        let p = profile("a", ProviderKind::Ollama, "http://h");
        let scope = CurationScope::for_profile(&p);
        let mut c = ModelCuration {
            version: 1,
            hidden_models: BTreeSet::from([scope.legacy_model_key("llama3")]),
            ..Default::default()
        };

        assert!(c.set_model_hidden(&p, "llama3", false));

        assert_eq!(
            c.hidden_by(&p, "llama3"),
            None,
            "restoring must clear the legacy entry, not leave it hiding the model"
        );
        assert!(c.hidden_models.is_empty());
    }

    #[test]
    fn a_port_in_the_endpoint_cannot_be_confused_with_a_tag_in_the_model_id() {
        // Ollama ids carry tags (`mistral:latest`) and endpoints carry ports,
        // so a colon-joined key would make these two distinct pairs collide:
        //   endpoint http://host        + model "11434:mistral"
        //   endpoint http://host:11434  + model "mistral"
        let bare = profile("a", ProviderKind::Ollama, "http://host");
        let ported = profile("b", ProviderKind::Ollama, "http://host:11434");

        assert_ne!(
            CurationScope::for_profile(&bare).model_key("11434:mistral"),
            CurationScope::for_profile(&ported).model_key("mistral"),
            "scope keys must not be ambiguous across the separator"
        );

        let mut c = ModelCuration::default();
        c.set_model_hidden(&bare, "11434:mistral", true);
        assert_eq!(
            c.hidden_by(&ported, "mistral"),
            None,
            "hiding one model must not hide an unrelated model on another endpoint"
        );
    }

    #[test]
    fn ordinary_tagged_model_ids_still_curate_normally() {
        let p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "mistral:latest", true);

        assert_eq!(c.hidden_by(&p, "mistral:latest"), Some(HiddenBy::Model));
        assert_eq!(c.hidden_by(&p, "mistral"), None);
        assert_eq!(c.hidden_by(&p, "mistral:7b"), None);
    }

    #[test]
    fn same_endpoint_under_a_different_kind_is_a_different_scope() {
        let ollama = profile("a", ProviderKind::Ollama, "http://host:1234");
        let compat = profile("b", ProviderKind::OpenAiCompatible, "http://host:1234");
        let mut c = ModelCuration::default();

        c.set_model_hidden(&ollama, "shared", true);

        assert_eq!(c.hidden_by(&ollama, "shared"), Some(HiddenBy::Model));
        assert_eq!(c.hidden_by(&compat, "shared"), None);
    }

    #[test]
    fn renaming_a_profile_label_keeps_curation() {
        let mut p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "llama3", true);

        p.label = "Completely different name".into();

        assert_eq!(c.hidden_by(&p, "llama3"), Some(HiddenBy::Model));
    }

    #[test]
    fn repointing_at_a_new_endpoint_does_not_carry_curation_across() {
        let mut p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "llama3", true);

        p.base_url = "http://192.168.1.50:11434".into();
        assert_eq!(
            c.hidden_by(&p, "llama3"),
            None,
            "a different server is a different inventory"
        );

        // Pointing back restores the user's choice — nothing was deleted.
        p.base_url = "http://127.0.0.1:11434".into();
        assert_eq!(c.hidden_by(&p, "llama3"), Some(HiddenBy::Model));
    }

    #[test]
    fn endpoint_identity_ignores_trailing_slash_and_host_case() {
        let a = profile("a", ProviderKind::Ollama, "http://Localhost:11434/");
        let b = profile("b", ProviderKind::Ollama, "http://localhost:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&a, "llama3", true);
        assert_eq!(c.hidden_by(&b, "llama3"), Some(HiddenBy::Model));
    }

    #[test]
    fn session_kinds_without_a_url_stay_distinct_per_profile() {
        let a = profile("grok-one", ProviderKind::XaiGrokBuild, "");
        let b = profile("grok-two", ProviderKind::XaiGrokBuild, "");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&a, "grok-3", true);
        assert_eq!(c.hidden_by(&a, "grok-3"), Some(HiddenBy::Model));
        assert_eq!(c.hidden_by(&b, "grok-3"), None);
    }

    #[test]
    fn provider_hiding_wins_and_restoring_it_keeps_individual_model_choices() {
        let p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "noisy", true);
        c.set_provider_hidden(&p, true);

        assert_eq!(c.hidden_by(&p, "noisy"), Some(HiddenBy::Provider));
        assert_eq!(c.hidden_by(&p, "wanted"), Some(HiddenBy::Provider));

        c.set_provider_hidden(&p, false);
        assert_eq!(
            c.hidden_by(&p, "noisy"),
            Some(HiddenBy::Model),
            "the individually hidden model must not be un-hidden"
        );
        assert_eq!(c.hidden_by(&p, "wanted"), None);
    }

    #[test]
    fn hiding_a_pinned_model_drops_the_pin() {
        let p = profile("a", ProviderKind::Ollama, "http://x:1");
        let mut c = ModelCuration::default();
        c.set_model_pinned(&p, "m1", true);
        assert_eq!(c.pinned_rank(&p, "m1"), Some(0));

        c.set_model_hidden(&p, "m1", true);
        assert_eq!(c.pinned_rank(&p, "m1"), None);
        assert_eq!(c.hidden_by(&p, "m1"), Some(HiddenBy::Model));
    }

    #[test]
    fn pinning_a_hidden_model_restores_it() {
        let p = profile("a", ProviderKind::Ollama, "http://x:1");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "m1", true);

        c.set_model_pinned(&p, "m1", true);
        assert_eq!(c.hidden_by(&p, "m1"), None);
    }

    #[test]
    fn pin_order_is_explicit_and_reversible() {
        let p = profile("a", ProviderKind::Ollama, "http://x:1");
        let mut c = ModelCuration::default();
        c.set_model_pinned(&p, "second", true);
        c.set_model_pinned(&p, "first", true);

        assert_eq!(c.pinned_rank(&p, "second"), Some(0));
        assert_eq!(c.pinned_rank(&p, "first"), Some(1));

        assert!(c.set_model_pinned(&p, "second", false));
        assert_eq!(c.pinned_rank(&p, "second"), None);
        assert_eq!(c.pinned_rank(&p, "first"), Some(0), "ranks close up");

        // Re-pinning is idempotent and does not duplicate.
        assert!(c.set_model_pinned(&p, "second", true));
        assert!(!c.set_model_pinned(&p, "second", true));
        assert_eq!(c.pinned_models.len(), 2);
    }

    #[test]
    fn migrate_stamps_version_and_removes_duplicates_without_losing_choices() {
        let mut c = ModelCuration {
            version: 0,
            hidden_models: BTreeSet::from(["m:v1:ollama:e:a".to_string(), String::new()]),
            pinned_models: vec!["k".into(), "k".into(), "  ".into(), "j".into()],
            ..Default::default()
        };
        c.migrate();

        assert_eq!(c.version, CURATION_VERSION);
        assert_eq!(c.hidden_models.len(), 1);
        assert_eq!(c.pinned_models, vec!["k".to_string(), "j".to_string()]);
    }

    #[test]
    fn a_newer_config_keeps_its_version_and_entries() {
        let mut c = ModelCuration {
            version: CURATION_VERSION + 7,
            hidden_models: BTreeSet::from(["m:v9:future:endpoint:model".to_string()]),
            ..Default::default()
        };
        let before = c.clone();
        c.migrate();

        assert_eq!(c.version, before.version, "must not downgrade");
        assert_eq!(
            c.hidden_models, before.hidden_models,
            "entries this build does not understand must survive"
        );
    }

    #[test]
    fn curation_round_trips_through_json_without_secrets() {
        let p = profile("a", ProviderKind::Ollama, "http://127.0.0.1:11434");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&p, "llama3", true);
        c.set_model_pinned(&p, "mistral", true);
        c.set_provider_hidden(&p, true);

        let json = serde_json::to_string(&c).expect("serialize");
        assert!(
            !json.contains("api_key"),
            "curation must never carry secrets"
        );
        assert!(!json.contains("label for a"), "no display labels either");

        let back: ModelCuration = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, c);
        assert_eq!(back.hidden_by(&p, "llama3"), Some(HiddenBy::Provider));
    }

    #[test]
    fn absent_field_deserializes_to_an_empty_curation() {
        let mut c: ModelCuration = serde_json::from_str("{}").expect("deserialize");
        c.migrate();
        assert_eq!(c.version, CURATION_VERSION);
        assert!(c.hidden_models.is_empty());
        assert!(c.pinned_models.is_empty());
    }

    #[test]
    fn retain_scopes_does_not_confuse_one_endpoint_for_a_longer_one() {
        // `http://h:1` must not be treated as a prefix of `http://h:11`.
        let short = profile("a", ProviderKind::Ollama, "http://h:1");
        let long = profile("b", ProviderKind::Ollama, "http://h:11");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&long, "m", true);

        c.retain_scopes(std::slice::from_ref(&short));

        assert!(
            c.hidden_models.is_empty(),
            "the longer endpoint's entry must not survive as a prefix match"
        );
    }

    #[test]
    fn retain_scopes_only_drops_entries_with_no_matching_profile() {
        let keep = profile("a", ProviderKind::Ollama, "http://keep:1");
        let gone = profile("b", ProviderKind::Ollama, "http://gone:2");
        let mut c = ModelCuration::default();
        c.set_model_hidden(&keep, "m1", true);
        c.set_model_hidden(&gone, "m2", true);
        c.set_provider_hidden(&gone, true);

        c.retain_scopes(std::slice::from_ref(&keep));

        assert_eq!(c.hidden_by(&keep, "m1"), Some(HiddenBy::Model));
        assert!(c.hidden_models.len() == 1);
        assert!(c.hidden_providers.is_empty());
    }
}
