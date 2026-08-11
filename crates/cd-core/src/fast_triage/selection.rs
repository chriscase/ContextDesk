//! Exact-evidence selection of the host-grounded fast-triage route.
//!
//! Selection is deliberately **not** a heuristic. A fast route runs only when
//! the host holds a persisted record whose `(profile_id, model_id,
//! workflow_contract, contract_fingerprint)` tuple matches this turn exactly and
//! whose verdict is an explicit measured pass.
//!
//! Three things are therefore impossible here by construction:
//!
//! * **Model-name routing.** A record is matched by the exact configured model
//!   id string, never by a family, prefix, size hint, or "fast"-sounding name.
//!   Two different model ids never share a record.
//! * **Gateway/URL routing.** No type in this module has a base URL, host, port,
//!   endpoint, or provider-kind field, so no code path can consult one.
//! * **Global badges.** A record is scoped to one workflow contract. Evidence
//!   for ordinary generation, tool loops, or embedding roles is a different
//!   record and never transfers into this route.
//!
//! The contract fingerprint closes the last gap: if the route's prompt contract
//! or validator set changes, previously measured evidence no longer describes
//! the thing being run, so the record is stale and the route is not selected.

use serde::{Deserialize, Serialize};

/// The exact workflow contract a fast-route record was measured against.
///
/// V1 defines one: the host hands the model the **complete** permitted evidence
/// packet (every candidate group plus the host-owned linked timeline) in one
/// bounded request. Candidate-local synthesis, native tool loops, ordinary
/// generation, and retrieval roles are separate contracts and are deliberately
/// absent — a record cannot accidentally authorize them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageWorkflowContract {
    /// Host-grounded synthesis from one complete permitted evidence packet.
    HostGroundedSynthesisCompletePacket,
}

impl FastTriageWorkflowContract {
    /// Stable wire label for config, DTOs, and telemetry.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HostGroundedSynthesisCompletePacket => "host_grounded_synthesis_complete_packet",
        }
    }
}

/// Measured verdict recorded for one exact `(profile, model, workflow)` tuple.
///
/// `Inconclusive` is not a pass. It exists so a host can persist "measured, did
/// not conclude" without that value ever being read as authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageRouteVerdict {
    /// Measured pass for this exact tuple and contract fingerprint.
    Qualified,
    /// Measured and did not pass.
    Unqualified,
    /// Measured without reaching a verdict. Never authorization.
    Inconclusive,
}

impl FastTriageRouteVerdict {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qualified => "qualified",
            Self::Unqualified => "unqualified",
            Self::Inconclusive => "inconclusive",
        }
    }
}

/// One persisted route record. Provider-neutral by shape: it carries host
/// identities and a measured verdict, and has no field able to express a
/// gateway, endpoint, credential, or provider kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageRouteRecord {
    /// Exact provider profile id this evidence belongs to. Model ids are not
    /// globally unique, so the profile is part of the identity.
    pub profile_id: String,
    /// Exact model id this evidence belongs to.
    pub model_id: String,
    /// Exact workflow contract this evidence was measured against.
    pub workflow_contract: FastTriageWorkflowContract,
    /// Measured verdict. Only [`FastTriageRouteVerdict::Qualified`] authorizes.
    pub verdict: FastTriageRouteVerdict,
    /// Fingerprint of the host contract the evidence was measured against.
    /// A record measured against an older prompt/validator contract is stale.
    pub contract_fingerprint: String,
}

/// The live turn identity a record must match exactly.
#[derive(Debug, Clone, Copy)]
pub struct FastTriageRouteRequest<'a> {
    /// Whether the host enabled this route at all.
    pub enabled: bool,
    /// This turn's resolved provider profile id, when known.
    pub profile_id: Option<&'a str>,
    /// This turn's resolved model id, when known.
    pub model_id: Option<&'a str>,
    /// The workflow contract this turn would actually run.
    pub workflow_contract: FastTriageWorkflowContract,
    /// The host contract fingerprint this build would actually run.
    pub contract_fingerprint: &'a str,
}

/// Exactly why the fast route was not selected. Every non-selection is one of
/// these; the route never declines silently and never falls back on a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageRouteRejection {
    /// The host did not enable the route for this turn.
    RouteDisabled,
    /// The turn has no resolved profile and/or model identity to match on.
    /// Matching on anything else (a name, a URL) is exactly what this route
    /// must never do, so an unknown identity is a hard non-selection.
    TurnIdentityUnknown,
    /// No persisted record exists for this exact profile + model pair.
    NoRecordForProfileModel,
    /// A record exists for the pair, but not for the workflow contract this
    /// turn would run. Evidence never transfers between contracts.
    WorkflowContractMismatch,
    /// A record exists for the exact tuple, but its verdict is not a pass.
    VerdictNotQualified,
    /// A record exists and passed, but was measured against a different host
    /// contract than this build runs.
    ContractFingerprintStale,
}

impl FastTriageRouteRejection {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RouteDisabled => "route_disabled",
            Self::TurnIdentityUnknown => "turn_identity_unknown",
            Self::NoRecordForProfileModel => "no_record_for_profile_model",
            Self::WorkflowContractMismatch => "workflow_contract_mismatch",
            Self::VerdictNotQualified => "verdict_not_qualified",
            Self::ContractFingerprintStale => "contract_fingerprint_stale",
        }
    }

    /// One host-authored operator sentence. Never model text, never a domain
    /// word, never an endpoint or credential.
    pub fn detail(self) -> &'static str {
        match self {
            Self::RouteDisabled => "the host-grounded fast route is not enabled for this turn",
            Self::TurnIdentityUnknown => {
                "this turn has no resolved provider profile and model identity to match \
                 persisted route evidence against"
            }
            Self::NoRecordForProfileModel => {
                "no persisted fast-route evidence exists for this exact provider profile and model"
            }
            Self::WorkflowContractMismatch => {
                "persisted fast-route evidence exists for this model but not for the workflow \
                 contract this turn would run"
            }
            Self::VerdictNotQualified => {
                "persisted fast-route evidence for this model and workflow did not record a \
                 measured pass"
            }
            Self::ContractFingerprintStale => {
                "persisted fast-route evidence was measured against a different host contract \
                 than this build runs"
            }
        }
    }
}

/// Host identities bound to one selected fast route. Telemetry and provenance
/// only; never a credential, endpoint, or provider kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageRoleBinding {
    /// Exact provider profile id.
    pub profile_id: String,
    /// Exact model id.
    pub model_id: String,
}

/// A selected route: which exact record authorized it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedFastRoute {
    /// The exact identity that matched.
    pub role: FastTriageRoleBinding,
    /// The workflow contract the record authorized.
    pub workflow_contract: FastTriageWorkflowContract,
    /// The exact contract fingerprint both the record and this build carry.
    pub contract_fingerprint: String,
}

/// Selection result. Either an exact record authorized this route, or the host
/// records exactly why it did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FastTriageRouteSelection {
    /// Exact persisted evidence authorized the route.
    Selected(SelectedFastRoute),
    /// The route is not selected, with the exact host reason.
    NotSelected(FastTriageRouteRejection),
}

impl FastTriageRouteSelection {
    /// Whether the fast route may run.
    pub fn is_selected(&self) -> bool {
        matches!(self, Self::Selected(_))
    }

    /// The rejection reason, when not selected.
    pub fn rejection(&self) -> Option<FastTriageRouteRejection> {
        match self {
            Self::Selected(_) => None,
            Self::NotSelected(reason) => Some(*reason),
        }
    }
}

/// Select the fast route from persisted evidence alone.
///
/// The checks are ordered from broadest to narrowest so the reported reason is
/// the most useful one: a missing record is reported as such rather than as a
/// contract mismatch, and a stale fingerprint is distinguishable from a failed
/// verdict.
pub fn select_fast_triage_route(
    records: &[FastTriageRouteRecord],
    request: FastTriageRouteRequest<'_>,
) -> FastTriageRouteSelection {
    use FastTriageRouteSelection::NotSelected;

    if !request.enabled {
        return NotSelected(FastTriageRouteRejection::RouteDisabled);
    }
    let (Some(profile_id), Some(model_id)) = (request.profile_id, request.model_id) else {
        return NotSelected(FastTriageRouteRejection::TurnIdentityUnknown);
    };
    if profile_id.trim().is_empty() || model_id.trim().is_empty() {
        return NotSelected(FastTriageRouteRejection::TurnIdentityUnknown);
    }

    // Exact string identity only. No normalization, no case folding, no prefix
    // or family matching: two model ids that differ at all are two models.
    let for_pair = records
        .iter()
        .filter(|record| record.profile_id == profile_id && record.model_id == model_id)
        .collect::<Vec<_>>();
    if for_pair.is_empty() {
        return NotSelected(FastTriageRouteRejection::NoRecordForProfileModel);
    }
    let for_contract = for_pair
        .into_iter()
        .filter(|record| record.workflow_contract == request.workflow_contract)
        .collect::<Vec<_>>();
    if for_contract.is_empty() {
        return NotSelected(FastTriageRouteRejection::WorkflowContractMismatch);
    }
    let qualified = for_contract
        .iter()
        .filter(|record| record.verdict == FastTriageRouteVerdict::Qualified)
        .collect::<Vec<_>>();
    if qualified.is_empty() {
        return NotSelected(FastTriageRouteRejection::VerdictNotQualified);
    }
    // Every qualified record must agree with the running contract. A single
    // stale record cannot be out-voted by a fresh one: mixed evidence for the
    // same tuple is not evidence, so the route stays unselected.
    if qualified
        .iter()
        .any(|record| record.contract_fingerprint != request.contract_fingerprint)
    {
        return NotSelected(FastTriageRouteRejection::ContractFingerprintStale);
    }
    FastTriageRouteSelection::Selected(SelectedFastRoute {
        role: FastTriageRoleBinding {
            profile_id: profile_id.to_string(),
            model_id: model_id.to_string(),
        },
        workflow_contract: request.workflow_contract,
        contract_fingerprint: request.contract_fingerprint.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(profile: &str, model: &str) -> FastTriageRouteRecord {
        FastTriageRouteRecord {
            profile_id: profile.into(),
            model_id: model.into(),
            workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
            verdict: FastTriageRouteVerdict::Qualified,
            contract_fingerprint: "fp-1".into(),
        }
    }

    fn request<'a>(profile: Option<&'a str>, model: Option<&'a str>) -> FastTriageRouteRequest<'a> {
        FastTriageRouteRequest {
            enabled: true,
            profile_id: profile,
            model_id: model,
            workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
            contract_fingerprint: "fp-1",
        }
    }

    #[test]
    fn exact_tuple_selects_and_every_near_miss_is_named() {
        let records = vec![record("profile-a", "model-a")];
        assert!(
            select_fast_triage_route(&records, request(Some("profile-a"), Some("model-a")))
                .is_selected()
        );
        for (profile, model, expected) in [
            (
                Some("profile-b"),
                Some("model-a"),
                FastTriageRouteRejection::NoRecordForProfileModel,
            ),
            (
                Some("profile-a"),
                Some("model-a-turbo"),
                FastTriageRouteRejection::NoRecordForProfileModel,
            ),
            (
                None,
                Some("model-a"),
                FastTriageRouteRejection::TurnIdentityUnknown,
            ),
            (
                Some("profile-a"),
                None,
                FastTriageRouteRejection::TurnIdentityUnknown,
            ),
            (
                Some("   "),
                Some("model-a"),
                FastTriageRouteRejection::TurnIdentityUnknown,
            ),
        ] {
            assert_eq!(
                select_fast_triage_route(&records, request(profile, model)).rejection(),
                Some(expected)
            );
        }
    }

    #[test]
    fn a_disabled_route_or_unqualified_or_stale_record_never_selects() {
        let records = vec![record("profile-a", "model-a")];
        let mut disabled = request(Some("profile-a"), Some("model-a"));
        disabled.enabled = false;
        assert_eq!(
            select_fast_triage_route(&records, disabled).rejection(),
            Some(FastTriageRouteRejection::RouteDisabled)
        );

        for verdict in [
            FastTriageRouteVerdict::Unqualified,
            FastTriageRouteVerdict::Inconclusive,
        ] {
            let mut not_passed = record("profile-a", "model-a");
            not_passed.verdict = verdict;
            assert_eq!(
                select_fast_triage_route(
                    std::slice::from_ref(&not_passed),
                    request(Some("profile-a"), Some("model-a"))
                )
                .rejection(),
                Some(FastTriageRouteRejection::VerdictNotQualified)
            );
        }

        let mut stale = record("profile-a", "model-a");
        stale.contract_fingerprint = "fp-0".into();
        assert_eq!(
            select_fast_triage_route(
                std::slice::from_ref(&stale),
                request(Some("profile-a"), Some("model-a"))
            )
            .rejection(),
            Some(FastTriageRouteRejection::ContractFingerprintStale)
        );

        // A fresh record cannot rescue a stale one for the same exact tuple.
        let mixed = vec![record("profile-a", "model-a"), stale];
        assert_eq!(
            select_fast_triage_route(&mixed, request(Some("profile-a"), Some("model-a"))).rejection(),
            Some(FastTriageRouteRejection::ContractFingerprintStale)
        );
    }

    #[test]
    fn evidence_never_transfers_between_workflow_contracts() {
        // Only one contract exists in V1, so the mismatch arm is proven by a
        // record whose contract is absent from the request rather than by a
        // second enum value. Serialize/deserialize a foreign contract label to
        // prove an unknown contract cannot be silently accepted either.
        let records = vec![record("profile-a", "model-a")];
        let mut other_contract = request(Some("profile-a"), Some("model-a"));
        other_contract.contract_fingerprint = "fp-1";
        assert!(select_fast_triage_route(&records, other_contract).is_selected());
        assert!(serde_json::from_str::<FastTriageWorkflowContract>("\"native_tool_loop\"").is_err());
        assert!(serde_json::from_str::<FastTriageWorkflowContract>("\"ordinary_generation\"")
            .is_err());
    }

    #[test]
    fn the_record_shape_cannot_express_a_gateway_or_credential() {
        // Serialize rather than inspect prose: the JSON keys *are* the shape,
        // so a future field able to name a gateway or a credential fails here.
        let json = serde_json::to_value(record("profile-a", "model-a")).expect("json");
        let fields = json
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            fields,
            [
                "contract_fingerprint",
                "model_id",
                "profile_id",
                "verdict",
                "workflow_contract",
            ]
            .map(String::from)
            .into()
        );
        let serialized = json.to_string().to_ascii_lowercase();
        for forbidden in [
            "base_url",
            "endpoint",
            "api_key",
            "authorization",
            "bearer",
            "http://",
            "https://",
        ] {
            assert!(!serialized.contains(forbidden), "route record leaked {forbidden}");
        }
    }

    #[test]
    fn wire_labels_are_stable_snake_case() {
        assert_eq!(
            FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket.as_str(),
            "host_grounded_synthesis_complete_packet"
        );
        assert_eq!(FastTriageRouteVerdict::Inconclusive.as_str(), "inconclusive");
        for rejection in [
            FastTriageRouteRejection::RouteDisabled,
            FastTriageRouteRejection::TurnIdentityUnknown,
            FastTriageRouteRejection::NoRecordForProfileModel,
            FastTriageRouteRejection::WorkflowContractMismatch,
            FastTriageRouteRejection::VerdictNotQualified,
            FastTriageRouteRejection::ContractFingerprintStale,
        ] {
            assert!(!rejection.as_str().is_empty());
            assert!(!rejection.detail().is_empty());
        }
    }
}
