//! Bounded Vercel AI Gateway retrieval laboratory.
//!
//! This is an explicit development tool, not a product capability claim. It
//! reads one provider credential from ContextDesk's Keychain service, keeps it
//! in memory for the process, and emits only model metadata, vector dimensions,
//! scores, stable fixture ids, latency, and usage. It never prints provider
//! error bodies, request text, authorization headers, or embedding vectors.

use anyhow::{bail, Context, Result};
use cd_core::config::load_config;
use cd_core::keychain_store::{looks_like_raw_secret, KeychainSecretStore, SecretStore};
use cd_core::providers::{ProviderKind, ProviderProfile};
use cd_core::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALUES: usize = 512;
const MAX_DOCUMENTS: usize = 100;
const MAX_QUERIES: usize = 50;
const MAX_TEXT_CHARS: usize = 8_192;
const OUTPUT_RANKED_IDS: usize = 15;
const QUERY_PREFIX: &str = "Retrieve log templates that contain direct initiating evidence, explicit failure mechanisms, downstream impact, rollback, or recovery relevant to this incident question. Do not prefer repetition alone.\nQuestion: ";
const STRUCTURAL_QUERY_PREFIX: &str = "Retrieve records that directly establish, propagate, correct, or resolve the condition asked about. Prefer explicit structural support over repetition alone.\nQuestion: ";

const USAGE: &str = "\
Usage:
  cd-vercel-retrieval-lab --config <config.json> [--profile <id>] catalog
  cd-vercel-retrieval-lab --config <config.json> [--profile <id>] embed <model> <values.json>
  cd-vercel-retrieval-lab --config <config.json> [--profile <id>] rerank <model> <input.json>
  cd-vercel-retrieval-lab --config <config.json> [--profile <id>] benchmark <embedding-models> <reranking-models> <dataset.json>

Model lists are comma-separated. Input files must contain synthetic or already
approved/redacted text. The credential is resolved from the profile's Keychain
reference exactly once per process and is never accepted as an argument.
";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Catalog,
    Embed {
        model: String,
        values: PathBuf,
    },
    Rerank {
        model: String,
        input: PathBuf,
    },
    Benchmark {
        embedding_models: Vec<String>,
        reranking_models: Vec<String>,
        dataset: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    config: PathBuf,
    profile: Option<String>,
    command: Command,
}

struct GatewayClient {
    client: Client,
    base: Url,
    credential: String,
}

impl GatewayClient {
    fn request(&self, request: RequestBuilder) -> RequestBuilder {
        request
            .bearer_auth(&self.credential)
            .header("ai-gateway-protocol-version", "0.0.1")
            .header("ai-gateway-auth-method", "api-key")
            .header("user-agent", "contextdesk-vercel-retrieval-lab/0.1")
    }

    async fn catalog(&self) -> Result<CatalogOutput> {
        let endpoint = self.base.join("config").context("catalog endpoint")?;
        let started = Instant::now();
        let response = self.request(self.client.get(endpoint)).send().await?;
        let parsed: CatalogResponse = bounded_json(response, "catalog").await?;
        let mut models: Vec<CatalogModelOutput> = parsed
            .models
            .into_iter()
            .filter(|model| matches!(model.model_type.as_deref(), Some("embedding" | "reranking")))
            .map(|model| CatalogModelOutput {
                id: model.id,
                name: model.name,
                model_type: model.model_type,
                pricing: model.pricing,
                provider: model.specification.map(|spec| spec.provider),
            })
            .collect();
        models.sort_by(|left, right| {
            left.model_type
                .cmp(&right.model_type)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(CatalogOutput {
            action: "catalog",
            latency_ms: elapsed_ms(started),
            model_count: models.len(),
            models,
        })
    }

    async fn embed(&self, model: &str, values: &[String]) -> Result<EmbeddingObservation> {
        validate_texts(values, MAX_VALUES, "embedding values")?;
        let endpoint = self
            .base
            .join("embedding-model")
            .context("embedding endpoint")?;
        let started = Instant::now();
        let response = self
            .request(
                self.client
                    .post(endpoint)
                    .header("ai-embedding-model-specification-version", "4")
                    .header("ai-model-id", model)
                    .json(&EmbeddingRequest { values }),
            )
            .send()
            .await?;
        let parsed: EmbeddingResponse = bounded_json(response, "embedding").await?;
        validate_embeddings(values.len(), &parsed.embeddings)?;
        let dimensions = parsed.embeddings.first().map_or(0, Vec::len);
        let vector_norms = parsed.embeddings.iter().map(|v| vector_norm(v)).collect();
        Ok(EmbeddingObservation {
            model: model.to_string(),
            latency_ms: elapsed_ms(started),
            value_count: values.len(),
            dimensions,
            usage_tokens: parsed.usage.and_then(|usage| usage.tokens),
            warning_count: parsed.warnings.len(),
            vector_norms,
            embeddings: parsed.embeddings,
        })
    }

    async fn rerank(
        &self,
        model: &str,
        query: &str,
        documents: &[String],
        top_n: usize,
    ) -> Result<RerankObservation> {
        validate_text(query, "reranking query")?;
        validate_texts(documents, MAX_DOCUMENTS, "reranking documents")?;
        if top_n == 0 || top_n > documents.len() {
            bail!("reranking topN must be between 1 and the document count");
        }
        let endpoint = self
            .base
            .join("reranking-model")
            .context("reranking endpoint")?;
        let started = Instant::now();
        let response = self
            .request(
                self.client
                    .post(endpoint)
                    .header("ai-reranking-model-specification-version", "4")
                    .header("ai-model-id", model)
                    .json(&RerankRequest {
                        documents: RerankDocuments {
                            document_type: "text",
                            values: documents,
                        },
                        query,
                        top_n,
                    }),
            )
            .send()
            .await?;
        let parsed: RerankResponse = bounded_json(response, "reranking").await?;
        validate_ranking(documents.len(), top_n, &parsed.ranking)?;
        Ok(RerankObservation {
            model: model.to_string(),
            latency_ms: elapsed_ms(started),
            document_count: documents.len(),
            warning_count: parsed.warnings.len(),
            ranking: parsed.ranking,
        })
    }
}

#[derive(Debug, Deserialize)]
struct CatalogResponse {
    models: Vec<CatalogModel>,
}

#[derive(Debug, Deserialize)]
struct CatalogModel {
    id: String,
    name: String,
    #[serde(rename = "modelType")]
    model_type: Option<String>,
    pricing: Option<serde_json::Value>,
    specification: Option<CatalogSpecification>,
}

#[derive(Debug, Deserialize)]
struct CatalogSpecification {
    provider: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogOutput {
    action: &'static str,
    latency_ms: u128,
    model_count: usize,
    models: Vec<CatalogModelOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogModelOutput {
    id: String,
    name: String,
    model_type: Option<String>,
    pricing: Option<serde_json::Value>,
    provider: Option<String>,
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'a> {
    values: &'a [String],
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    embeddings: Vec<Vec<f32>>,
    #[serde(default)]
    usage: Option<EmbeddingUsage>,
    #[serde(default)]
    warnings: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingUsage {
    tokens: Option<u64>,
}

#[derive(Debug)]
struct EmbeddingObservation {
    model: String,
    latency_ms: u128,
    value_count: usize,
    dimensions: usize,
    usage_tokens: Option<u64>,
    warning_count: usize,
    vector_norms: Vec<f64>,
    embeddings: Vec<Vec<f32>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbedOutput {
    action: &'static str,
    model: String,
    latency_ms: u128,
    value_count: usize,
    dimensions: usize,
    usage_tokens: Option<u64>,
    warning_count: usize,
    vector_norms: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RerankRequest<'a> {
    documents: RerankDocuments<'a>,
    query: &'a str,
    top_n: usize,
}

#[derive(Debug, Serialize)]
struct RerankDocuments<'a> {
    #[serde(rename = "type")]
    document_type: &'static str,
    values: &'a [String],
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RankingRow {
    index: usize,
    relevance_score: f64,
}

#[derive(Debug, Deserialize)]
struct RerankResponse {
    ranking: Vec<RankingRow>,
    #[serde(default)]
    warnings: Vec<serde_json::Value>,
}

#[derive(Debug)]
struct RerankObservation {
    model: String,
    latency_ms: u128,
    document_count: usize,
    warning_count: usize,
    ranking: Vec<RankingRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RerankInput {
    query: String,
    documents: Vec<LabDocument>,
    top_n: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
struct LabDocument {
    id: String,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RerankOutput {
    action: &'static str,
    model: String,
    latency_ms: u128,
    document_count: usize,
    warning_count: usize,
    ranking: Vec<RankedId>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RankedId {
    id: String,
    score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkDataset {
    name: String,
    documents: Vec<LabDocument>,
    queries: Vec<BenchmarkQuery>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkQuery {
    id: String,
    query: String,
    relevant_ids: Vec<String>,
    #[serde(default)]
    must_include_ids: Vec<String>,
    #[serde(default)]
    must_exclude_ids: Vec<String>,
    top_k: usize,
    shortlist_k: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkOutput {
    action: &'static str,
    dataset: String,
    document_count: usize,
    query_count: usize,
    embedding_runs: Vec<ModelBenchmark>,
    reranking_runs: Vec<ModelBenchmark>,
    combined_runs: Vec<CombinedBenchmark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelBenchmark {
    model: String,
    role: &'static str,
    total_latency_ms: u128,
    dimensions: Option<usize>,
    usage_tokens: Option<u64>,
    warning_count: usize,
    query_shapes: Vec<QueryShapeBenchmark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryShapeBenchmark {
    query_shape: &'static str,
    mean_relevant_recall_at_k: f64,
    mean_must_include_recall_at_k: Option<f64>,
    mean_must_exclude_share_at_k: Option<f64>,
    mean_non_relevant_share_at_k: f64,
    queries: Vec<QueryBenchmark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryBenchmark {
    id: String,
    top_k: usize,
    relevant_recall_at_k: f64,
    must_include_recall_at_k: Option<f64>,
    must_exclude_hits_at_k: usize,
    must_exclude_share_at_k: Option<f64>,
    must_exclude_passed: Option<bool>,
    non_relevant_share_at_k: f64,
    ranking: Vec<RankedId>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CombinedBenchmark {
    embedding_model: String,
    reranking_model: String,
    role: &'static str,
    embedding_latency_ms: u128,
    reranking_latency_ms: u128,
    dimensions: usize,
    usage_tokens: Option<u64>,
    warning_count: usize,
    query_shapes: Vec<CombinedQueryShapeBenchmark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CombinedQueryShapeBenchmark {
    query_shape: &'static str,
    mean_upstream_relevant_recall_at_shortlist: f64,
    mean_upstream_must_include_recall_at_shortlist: Option<f64>,
    mean_final_relevant_recall_at_k: f64,
    mean_final_must_include_recall_at_k: Option<f64>,
    mean_final_must_exclude_share_at_k: Option<f64>,
    queries: Vec<CombinedQueryBenchmark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CombinedQueryBenchmark {
    id: String,
    top_k: usize,
    shortlist_k: usize,
    upstream_relevant_recall_at_shortlist: f64,
    upstream_must_include_recall_at_shortlist: Option<f64>,
    upstream_must_exclude_hits_at_shortlist: usize,
    final_result: QueryBenchmark,
    shortlist_ranking: Vec<RankedId>,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(value) => match serde_json::to_string_pretty(&value) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("error: output serialization failed: {error}");
                ExitCode::from(1)
            }
        },
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::from(1)
        }
    }
}

async fn run() -> Result<serde_json::Value> {
    let args = parse_args(env::args().skip(1).collect())?;
    let config = load_config(&args.config).context("load ContextDesk config")?;
    let profile = select_profile(&config.providers.profiles, args.profile.as_deref(), &config)?;
    let gateway = build_gateway(profile)?;

    match args.command {
        Command::Catalog => Ok(serde_json::to_value(gateway.catalog().await?)?),
        Command::Embed { model, values } => {
            let values: Vec<String> = read_json_file(&values)?;
            let observed = gateway.embed(&model, &values).await?;
            Ok(serde_json::to_value(EmbedOutput {
                action: "embed",
                model: observed.model,
                latency_ms: observed.latency_ms,
                value_count: observed.value_count,
                dimensions: observed.dimensions,
                usage_tokens: observed.usage_tokens,
                warning_count: observed.warning_count,
                vector_norms: observed.vector_norms,
            })?)
        }
        Command::Rerank { model, input } => {
            let input: RerankInput = read_json_file(&input)?;
            validate_documents(&input.documents)?;
            let texts: Vec<String> = input.documents.iter().map(|doc| doc.text.clone()).collect();
            let observed = gateway
                .rerank(
                    &model,
                    &input.query,
                    &texts,
                    input.top_n.unwrap_or(texts.len()),
                )
                .await?;
            Ok(serde_json::to_value(RerankOutput {
                action: "rerank",
                model: observed.model,
                latency_ms: observed.latency_ms,
                document_count: observed.document_count,
                warning_count: observed.warning_count,
                ranking: map_ranking(&input.documents, &observed.ranking)?,
            })?)
        }
        Command::Benchmark {
            embedding_models,
            reranking_models,
            dataset,
        } => {
            let dataset: BenchmarkDataset = read_json_file(&dataset)?;
            validate_dataset(&dataset)?;
            Ok(serde_json::to_value(
                run_benchmark(&gateway, dataset, &embedding_models, &reranking_models).await?,
            )?)
        }
    }
}

fn parse_args(args: Vec<String>) -> Result<Args> {
    if args.is_empty() || args.iter().any(|arg| arg == "-h" || arg == "--help") {
        bail!("{USAGE}");
    }
    let mut config = None;
    let mut profile = None;
    let mut cursor = 0;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--config" => {
                cursor += 1;
                config = args.get(cursor).map(PathBuf::from);
                if config.is_none() {
                    bail!("--config requires a path");
                }
            }
            "--profile" => {
                cursor += 1;
                profile = args.get(cursor).cloned();
                if profile.is_none() {
                    bail!("--profile requires an id");
                }
            }
            value if value.starts_with('-') => bail!("unexpected option {value}"),
            _ => break,
        }
        cursor += 1;
    }
    let config = config.context("--config is required")?;
    let command = args.get(cursor).context("command is required")?;
    let rest = &args[cursor + 1..];
    let command = match (command.as_str(), rest) {
        ("catalog", []) => Command::Catalog,
        ("embed", [model, values]) => Command::Embed {
            model: model.clone(),
            values: PathBuf::from(values),
        },
        ("rerank", [model, input]) => Command::Rerank {
            model: model.clone(),
            input: PathBuf::from(input),
        },
        ("benchmark", [embedding_models, reranking_models, dataset]) => Command::Benchmark {
            embedding_models: parse_model_list(embedding_models)?,
            reranking_models: parse_model_list(reranking_models)?,
            dataset: PathBuf::from(dataset),
        },
        _ => bail!("invalid command arguments\n\n{USAGE}"),
    };
    Ok(Args {
        config,
        profile,
        command,
    })
}

fn parse_model_list(value: &str) -> Result<Vec<String>> {
    let models: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if models.is_empty() || models.len() > 8 {
        bail!("model list must contain between 1 and 8 ids");
    }
    Ok(models)
}

fn select_profile<'a>(
    profiles: &'a [ProviderProfile],
    requested: Option<&str>,
    config: &'a cd_core::config::AppConfig,
) -> Result<&'a ProviderProfile> {
    let profile = if let Some(id) = requested {
        profiles
            .iter()
            .find(|profile| profile.id == id)
            .with_context(|| format!("provider profile {id} was not found"))?
    } else {
        config
            .providers
            .active()
            .context("config has no active provider profile")?
    };
    if profile.kind != ProviderKind::OpenAiCompatible {
        bail!("the lab requires an OpenAI-compatible Vercel profile");
    }
    Ok(profile)
}

fn build_gateway(profile: &ProviderProfile) -> Result<GatewayClient> {
    let profile_url = Url::parse(&profile.base_url).context("parse provider base URL")?;
    if profile_url.scheme() != "https"
        || profile_url.host_str() != Some("ai-gateway.vercel.sh")
        || profile_url.port_or_known_default() != Some(443)
        || !profile_url.username().is_empty()
        || profile_url.password().is_some()
        || profile_url.query().is_some()
        || profile_url.fragment().is_some()
    {
        bail!("the lab only accepts the public HTTPS Vercel AI Gateway profile");
    }

    let key_ref = profile
        .api_key_ref
        .as_deref()
        .context("provider profile has no Keychain reference")?;
    if looks_like_raw_secret(key_ref) || !key_ref.contains('/') {
        bail!("provider credential reference is not a safe Keychain reference");
    }
    let credential = KeychainSecretStore::new()
        .get(key_ref)
        .context("read provider credential from Keychain")?
        .filter(|value| !value.is_empty())
        .context("provider credential is missing from Keychain")?;

    let base = Url::parse("https://ai-gateway.vercel.sh/v4/ai/")?;
    let (_, client) = build_pinned_client_for_url(
        base.as_str(),
        &SsrfPolicy::default(),
        &SystemResolver,
        DEFAULT_TIMEOUT,
    )?;
    Ok(GatewayClient {
        client,
        base,
        credential,
    })
}

async fn bounded_json<T: DeserializeOwned>(response: Response, role: &str) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        bail!("{role} endpoint returned HTTP {status}");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        bail!("{role} response exceeded the bounded size");
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read bounded provider response")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            bail!("{role} response exceeded the bounded size");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).with_context(|| format!("{role} response contract"))
}

fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = fs::metadata(path).context("inspect lab input")?;
    if metadata.len() > MAX_RESPONSE_BYTES as u64 {
        bail!("lab input exceeds the bounded size");
    }
    let bytes = fs::read(path).context("read lab input")?;
    serde_json::from_slice(&bytes).context("parse lab input")
}

fn validate_text(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() {
        bail!("{label} contains empty text");
    }
    if value.chars().count() > MAX_TEXT_CHARS {
        bail!("{label} exceeds the {MAX_TEXT_CHARS}-character bound");
    }
    Ok(())
}

fn validate_texts(values: &[String], bound: usize, label: &str) -> Result<()> {
    if values.is_empty() || values.len() > bound {
        bail!("{label} must contain between 1 and {bound} items");
    }
    for value in values {
        validate_text(value, label)?;
    }
    Ok(())
}

fn validate_documents(documents: &[LabDocument]) -> Result<()> {
    if documents.is_empty() || documents.len() > MAX_DOCUMENTS {
        bail!("documents must contain between 1 and {MAX_DOCUMENTS} items");
    }
    let mut ids = HashSet::new();
    for document in documents {
        validate_text(&document.id, "document id")?;
        validate_text(&document.text, "document text")?;
        if !ids.insert(document.id.as_str()) {
            bail!("document ids must be unique");
        }
    }
    Ok(())
}

fn validate_dataset(dataset: &BenchmarkDataset) -> Result<()> {
    validate_text(&dataset.name, "dataset name")?;
    validate_documents(&dataset.documents)?;
    if dataset.queries.is_empty() || dataset.queries.len() > MAX_QUERIES {
        bail!("queries must contain between 1 and {MAX_QUERIES} items");
    }
    let document_ids: HashSet<&str> = dataset
        .documents
        .iter()
        .map(|document| document.id.as_str())
        .collect();
    let mut query_ids = HashSet::new();
    for query in &dataset.queries {
        validate_text(&query.id, "query id")?;
        validate_text(&query.query, "query text")?;
        if !query_ids.insert(query.id.as_str()) {
            bail!("query ids must be unique");
        }
        if query.top_k == 0 || query.top_k > dataset.documents.len() {
            bail!("query topK must be between 1 and the document count");
        }
        if query.shortlist_k < query.top_k || query.shortlist_k >= dataset.documents.len() {
            bail!("query shortlistK must be at least topK and smaller than the document count");
        }
        if query.relevant_ids.is_empty() {
            bail!("each benchmark query must declare at least one relevant id");
        }
        for id in query
            .relevant_ids
            .iter()
            .chain(&query.must_include_ids)
            .chain(&query.must_exclude_ids)
        {
            if !document_ids.contains(id.as_str()) {
                bail!("query truth references an unknown document id");
            }
        }
        let relevant_ids = query
            .relevant_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if query
            .must_include_ids
            .iter()
            .any(|id| !relevant_ids.contains(id.as_str()))
        {
            bail!("query mustIncludeIds must be a subset of relevantIds");
        }
        if query
            .must_exclude_ids
            .iter()
            .any(|id| relevant_ids.contains(id.as_str()))
        {
            bail!("query mustExcludeIds must be disjoint from relevantIds");
        }
    }
    Ok(())
}

fn validate_embeddings(expected: usize, vectors: &[Vec<f32>]) -> Result<()> {
    if vectors.len() != expected {
        bail!("embedding response count did not match the request");
    }
    let dimensions = vectors.first().map_or(0, Vec::len);
    if dimensions == 0 || dimensions > 65_536 {
        bail!("embedding response has an invalid dimension count");
    }
    for vector in vectors {
        if vector.len() != dimensions || vector.iter().any(|value| !value.is_finite()) {
            bail!("embedding response has inconsistent or non-finite vectors");
        }
    }
    Ok(())
}

fn validate_ranking(document_count: usize, top_n: usize, ranking: &[RankingRow]) -> Result<()> {
    if ranking.len() != top_n {
        bail!("reranking response count did not match topN");
    }
    let mut indices = HashSet::new();
    for row in ranking {
        if row.index >= document_count
            || !row.relevance_score.is_finite()
            || !indices.insert(row.index)
        {
            bail!("reranking response contains an invalid row");
        }
    }
    Ok(())
}

fn vector_norm(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn cosine(left: &[f32], right: &[f32]) -> Result<f64> {
    if left.len() != right.len() || left.is_empty() {
        bail!("cannot compare vectors with different dimensions");
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum::<f64>();
    let denominator = vector_norm(left) * vector_norm(right);
    if denominator == 0.0 || !denominator.is_finite() {
        bail!("cannot compare a zero or non-finite vector");
    }
    Ok(dot / denominator)
}

fn map_ranking(documents: &[LabDocument], ranking: &[RankingRow]) -> Result<Vec<RankedId>> {
    ranking
        .iter()
        .map(|row| {
            let document = documents
                .get(row.index)
                .context("ranking index was outside the document list")?;
            Ok(RankedId {
                id: document.id.clone(),
                score: row.relevance_score,
            })
        })
        .collect()
}

async fn run_benchmark(
    gateway: &GatewayClient,
    dataset: BenchmarkDataset,
    embedding_models: &[String],
    reranking_models: &[String],
) -> Result<BenchmarkOutput> {
    let document_texts: Vec<String> = dataset
        .documents
        .iter()
        .map(|document| document.text.clone())
        .collect();
    let plain_query_texts: Vec<String> = dataset
        .queries
        .iter()
        .map(|query| query.query.clone())
        .collect();
    let evidence_query_texts: Vec<String> = dataset
        .queries
        .iter()
        .map(|query| format!("{QUERY_PREFIX}{}", query.query))
        .collect();
    let structural_query_texts: Vec<String> = dataset
        .queries
        .iter()
        .map(|query| format!("{STRUCTURAL_QUERY_PREFIX}{}", query.query))
        .collect();
    let mut all_values = document_texts.clone();
    all_values.extend(plain_query_texts);
    all_values.extend(evidence_query_texts);
    all_values.extend(structural_query_texts);

    let mut embedding_runs = Vec::new();
    let mut combined_runs = Vec::new();
    for model in embedding_models {
        let observed = gateway.embed(model, &all_values).await?;
        let document_vectors = &observed.embeddings[..dataset.documents.len()];
        let query_count = dataset.queries.len();
        let query_vectors = &observed.embeddings[dataset.documents.len()..];
        let shapes = [
            ("plain", &query_vectors[..query_count]),
            (
                "evidence_terms_v1",
                &query_vectors[query_count..query_count * 2],
            ),
            (
                "structural_v1",
                &query_vectors[query_count * 2..query_count * 3],
            ),
        ];
        let mut query_shapes = Vec::new();
        let mut shaped_rankings = Vec::new();
        for (shape, shaped_query_vectors) in shapes {
            let rankings =
                rank_embedding_candidates(&dataset, document_vectors, shaped_query_vectors)?;
            let queries = dataset
                .queries
                .iter()
                .zip(&rankings)
                .map(|(query, ranking)| score_query(query, ranking.clone()))
                .collect();
            query_shapes.push(summarize_query_shape(shape, queries));
            shaped_rankings.push((shape, rankings));
        }
        for reranking_model in reranking_models {
            let mut reranking_latency_ms = 0;
            let mut combined_warning_count = observed.warning_count;
            let mut combined_shapes = Vec::new();
            for (shape, rankings) in &shaped_rankings {
                let (summary, latency_ms, warning_count) =
                    run_combined_query_shape(gateway, &dataset, reranking_model, shape, rankings)
                        .await?;
                reranking_latency_ms += latency_ms;
                combined_warning_count += warning_count;
                combined_shapes.push(summary);
            }
            combined_runs.push(CombinedBenchmark {
                embedding_model: model.clone(),
                reranking_model: reranking_model.clone(),
                role: "embedding_reranking",
                embedding_latency_ms: observed.latency_ms,
                reranking_latency_ms,
                dimensions: observed.dimensions,
                usage_tokens: observed.usage_tokens,
                warning_count: combined_warning_count,
                query_shapes: combined_shapes,
            });
        }
        embedding_runs.push(ModelBenchmark {
            model: model.clone(),
            role: "embedding",
            total_latency_ms: observed.latency_ms,
            dimensions: Some(observed.dimensions),
            usage_tokens: observed.usage_tokens,
            warning_count: observed.warning_count,
            query_shapes,
        });
    }

    let mut reranking_runs = Vec::new();
    for model in reranking_models {
        let mut total_latency_ms = 0;
        let mut warning_count = 0;
        let mut queries = Vec::new();
        for query in &dataset.queries {
            let observed = gateway
                .rerank(model, &query.query, &document_texts, document_texts.len())
                .await?;
            total_latency_ms += observed.latency_ms;
            warning_count += observed.warning_count;
            queries.push(score_query(
                query,
                map_ranking(&dataset.documents, &observed.ranking)?,
            ));
        }
        reranking_runs.push(ModelBenchmark {
            model: model.clone(),
            role: "reranking",
            total_latency_ms,
            dimensions: None,
            usage_tokens: None,
            warning_count,
            query_shapes: vec![summarize_query_shape("plain", queries)],
        });
    }

    Ok(BenchmarkOutput {
        action: "benchmark",
        dataset: dataset.name,
        document_count: dataset.documents.len(),
        query_count: dataset.queries.len(),
        embedding_runs,
        reranking_runs,
        combined_runs,
    })
}

async fn run_combined_query_shape(
    gateway: &GatewayClient,
    dataset: &BenchmarkDataset,
    reranking_model: &str,
    query_shape: &'static str,
    embedding_rankings: &[Vec<RankedId>],
) -> Result<(CombinedQueryShapeBenchmark, u128, usize)> {
    let documents_by_id = dataset
        .documents
        .iter()
        .map(|document| (document.id.as_str(), document))
        .collect::<std::collections::HashMap<_, _>>();
    let mut latency_ms = 0;
    let mut warning_count = 0;
    let mut queries = Vec::new();
    for (query, embedding_ranking) in dataset.queries.iter().zip(embedding_rankings) {
        let shortlist_ranking = embedding_ranking
            .iter()
            .take(query.shortlist_k)
            .cloned()
            .collect::<Vec<_>>();
        let shortlist_documents = shortlist_ranking
            .iter()
            .map(|row| {
                documents_by_id
                    .get(row.id.as_str())
                    .copied()
                    .cloned()
                    .context("embedding ranking referenced an unknown host document id")
            })
            .collect::<Result<Vec<_>>>()?;
        let shortlist_texts = shortlist_documents
            .iter()
            .map(|document| document.text.clone())
            .collect::<Vec<_>>();
        let observed = gateway
            .rerank(
                reranking_model,
                &query.query,
                &shortlist_texts,
                shortlist_texts.len(),
            )
            .await?;
        latency_ms += observed.latency_ms;
        warning_count += observed.warning_count;

        let shortlist_ids = shortlist_ranking
            .iter()
            .map(|row| row.id.as_str())
            .collect::<HashSet<_>>();
        let upstream_must_exclude_hits = query
            .must_exclude_ids
            .iter()
            .filter(|id| shortlist_ids.contains(id.as_str()))
            .count();
        let final_ranking = map_ranking(&shortlist_documents, &observed.ranking)?;
        queries.push(CombinedQueryBenchmark {
            id: query.id.clone(),
            top_k: query.top_k,
            shortlist_k: query.shortlist_k,
            upstream_relevant_recall_at_shortlist: recall(&query.relevant_ids, &shortlist_ids)
                .unwrap_or(0.0),
            upstream_must_include_recall_at_shortlist: recall(
                &query.must_include_ids,
                &shortlist_ids,
            ),
            upstream_must_exclude_hits_at_shortlist: upstream_must_exclude_hits,
            final_result: score_query(query, final_ranking),
            shortlist_ranking,
        });
    }
    let summary = summarize_combined_query_shape(query_shape, queries);
    Ok((summary, latency_ms, warning_count))
}

fn score_query(query: &BenchmarkQuery, ranking: Vec<RankedId>) -> QueryBenchmark {
    let top_ids: HashSet<&str> = ranking
        .iter()
        .take(query.top_k)
        .map(|row| row.id.as_str())
        .collect();
    let relevant_hits = query
        .relevant_ids
        .iter()
        .filter(|id| top_ids.contains(id.as_str()))
        .count();
    let must_exclude_hits = query
        .must_exclude_ids
        .iter()
        .filter(|id| top_ids.contains(id.as_str()))
        .count();
    let must_exclude_share = (!query.must_exclude_ids.is_empty())
        .then_some(must_exclude_hits as f64 / query.top_k as f64);
    QueryBenchmark {
        id: query.id.clone(),
        top_k: query.top_k,
        relevant_recall_at_k: recall(&query.relevant_ids, &top_ids).unwrap_or(0.0),
        must_include_recall_at_k: recall(&query.must_include_ids, &top_ids),
        must_exclude_hits_at_k: must_exclude_hits,
        must_exclude_share_at_k: must_exclude_share,
        must_exclude_passed: (!query.must_exclude_ids.is_empty()).then_some(must_exclude_hits == 0),
        non_relevant_share_at_k: 1.0 - relevant_hits as f64 / query.top_k as f64,
        ranking: ranking.into_iter().take(OUTPUT_RANKED_IDS).collect(),
    }
}

fn rank_embedding_candidates(
    dataset: &BenchmarkDataset,
    document_vectors: &[Vec<f32>],
    query_vectors: &[Vec<f32>],
) -> Result<Vec<Vec<RankedId>>> {
    query_vectors
        .iter()
        .map(|query_vector| {
            let mut ranking = dataset
                .documents
                .iter()
                .zip(document_vectors)
                .map(|(document, vector)| {
                    Ok(RankedId {
                        id: document.id.clone(),
                        score: cosine(query_vector, vector)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            ranking.sort_by(|left, right| {
                right
                    .score
                    .total_cmp(&left.score)
                    .then_with(|| left.id.cmp(&right.id))
            });
            Ok(ranking)
        })
        .collect()
}

fn summarize_combined_query_shape(
    query_shape: &'static str,
    queries: Vec<CombinedQueryBenchmark>,
) -> CombinedQueryShapeBenchmark {
    let count = queries.len() as f64;
    let upstream_must_include = queries
        .iter()
        .filter_map(|query| query.upstream_must_include_recall_at_shortlist)
        .collect::<Vec<_>>();
    let final_must_include = queries
        .iter()
        .filter_map(|query| query.final_result.must_include_recall_at_k)
        .collect::<Vec<_>>();
    let final_must_exclude = queries
        .iter()
        .filter_map(|query| query.final_result.must_exclude_share_at_k)
        .collect::<Vec<_>>();
    CombinedQueryShapeBenchmark {
        query_shape,
        mean_upstream_relevant_recall_at_shortlist: queries
            .iter()
            .map(|query| query.upstream_relevant_recall_at_shortlist)
            .sum::<f64>()
            / count,
        mean_upstream_must_include_recall_at_shortlist: (!upstream_must_include.is_empty()).then(
            || upstream_must_include.iter().sum::<f64>() / upstream_must_include.len() as f64,
        ),
        mean_final_relevant_recall_at_k: queries
            .iter()
            .map(|query| query.final_result.relevant_recall_at_k)
            .sum::<f64>()
            / count,
        mean_final_must_include_recall_at_k: (!final_must_include.is_empty())
            .then(|| final_must_include.iter().sum::<f64>() / final_must_include.len() as f64),
        mean_final_must_exclude_share_at_k: (!final_must_exclude.is_empty())
            .then(|| final_must_exclude.iter().sum::<f64>() / final_must_exclude.len() as f64),
        queries,
    }
}

fn summarize_query_shape(
    query_shape: &'static str,
    queries: Vec<QueryBenchmark>,
) -> QueryShapeBenchmark {
    let count = queries.len() as f64;
    let must_include_values: Vec<f64> = queries
        .iter()
        .filter_map(|query| query.must_include_recall_at_k)
        .collect();
    let must_exclude_values: Vec<f64> = queries
        .iter()
        .filter_map(|query| query.must_exclude_share_at_k)
        .collect();
    QueryShapeBenchmark {
        query_shape,
        mean_relevant_recall_at_k: queries
            .iter()
            .map(|query| query.relevant_recall_at_k)
            .sum::<f64>()
            / count,
        mean_must_include_recall_at_k: (!must_include_values.is_empty())
            .then(|| must_include_values.iter().sum::<f64>() / must_include_values.len() as f64),
        mean_must_exclude_share_at_k: (!must_exclude_values.is_empty())
            .then(|| must_exclude_values.iter().sum::<f64>() / must_exclude_values.len() as f64),
        mean_non_relevant_share_at_k: queries
            .iter()
            .map(|query| query.non_relevant_share_at_k)
            .sum::<f64>()
            / count,
        queries,
    }
}

fn recall(expected: &[String], actual: &HashSet<&str>) -> Option<f64> {
    if expected.is_empty() {
        return None;
    }
    let hits = expected
        .iter()
        .filter(|id| actual.contains(id.as_str()))
        .count();
    Some(hits as f64 / expected.len() as f64)
}

fn elapsed_ms(started: Instant) -> u128 {
    started.elapsed().as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_never_accept_a_credential() {
        let args = parse_args(vec![
            "--config".into(),
            "/tmp/config.json".into(),
            "catalog".into(),
        ])
        .unwrap();
        assert_eq!(args.command, Command::Catalog);
        assert!(parse_args(vec![
            "--config".into(),
            "/tmp/config.json".into(),
            "--api-key".into(),
            "secret".into(),
            "catalog".into(),
        ])
        .is_err());
    }

    #[test]
    fn ranking_validation_rejects_duplicate_or_partial_results() {
        assert!(validate_ranking(
            2,
            2,
            &[
                RankingRow {
                    index: 0,
                    relevance_score: 0.9,
                },
                RankingRow {
                    index: 0,
                    relevance_score: 0.8,
                },
            ],
        )
        .is_err());
        assert!(validate_ranking(
            2,
            2,
            &[RankingRow {
                index: 0,
                relevance_score: 0.9,
            }],
        )
        .is_err());
    }

    #[test]
    fn reranking_request_matches_gateway_v4_document_envelope() {
        let values = vec!["cause".to_string(), "noise".to_string()];
        let request = RerankRequest {
            documents: RerankDocuments {
                document_type: "text",
                values: &values,
            },
            query: "Which record explains the failure?",
            top_n: 2,
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "documents": {
                    "type": "text",
                    "values": ["cause", "noise"]
                },
                "query": "Which record explains the failure?",
                "topN": 2
            })
        );
    }

    #[test]
    fn embedding_response_matches_observed_gateway_v4_contract() {
        let response: EmbeddingResponse = serde_json::from_value(serde_json::json!({
            "embeddings": [[0.6, 0.8], [0.0, 1.0]],
            "usage": { "tokens": 17 },
            "warnings": [{ "type": "other", "message": "synthetic warning" }]
        }))
        .unwrap();

        validate_embeddings(2, &response.embeddings).unwrap();
        assert_eq!(response.usage.and_then(|usage| usage.tokens), Some(17));
        assert_eq!(response.warnings.len(), 1);
        assert!((vector_norm(&response.embeddings[0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn reranking_response_maps_gateway_indices_to_host_ids() {
        let response: RerankResponse = serde_json::from_value(serde_json::json!({
            "ranking": [
                { "index": 1, "relevanceScore": 0.91 },
                { "index": 0, "relevanceScore": 0.22 }
            ],
            "warnings": []
        }))
        .unwrap();
        validate_ranking(2, 2, &response.ranking).unwrap();

        let documents = vec![
            LabDocument {
                id: "host-cause-id".into(),
                text: "cause text".into(),
            },
            LabDocument {
                id: "host-noise-id".into(),
                text: "noise text".into(),
            },
        ];
        let mapped = map_ranking(&documents, &response.ranking).unwrap();
        assert_eq!(mapped[0].id, "host-noise-id");
        assert_eq!(mapped[1].id, "host-cause-id");
        assert!(response.warnings.is_empty());
    }

    #[test]
    fn catalog_response_keeps_retrieval_type_and_provider_separate() {
        let response: CatalogResponse = serde_json::from_value(serde_json::json!({
            "models": [
                {
                    "id": "creator/embed-small",
                    "name": "Embed Small",
                    "modelType": "embedding",
                    "pricing": { "input": "0.00000001" },
                    "specification": { "provider": "provider-a" }
                },
                {
                    "id": "creator/rerank-lite",
                    "name": "Rerank Lite",
                    "modelType": "reranking",
                    "pricing": null,
                    "specification": { "provider": "provider-b" }
                }
            ]
        }))
        .unwrap();

        assert_eq!(response.models[0].model_type.as_deref(), Some("embedding"));
        assert_eq!(
            response.models[0]
                .specification
                .as_ref()
                .map(|specification| specification.provider.as_str()),
            Some("provider-a")
        );
        assert_eq!(response.models[1].model_type.as_deref(), Some("reranking"));
        assert_eq!(response.models[1].id, "creator/rerank-lite");
    }

    #[test]
    fn cosine_and_recall_are_stable() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]).unwrap() - 1.0).abs() < 1e-9);
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0]).unwrap()).abs() < 1e-9);
        let actual = HashSet::from(["a", "c"]);
        assert_eq!(recall(&["a".into(), "b".into()], &actual), Some(0.5));
        assert_eq!(recall(&[], &actual), None);
    }

    #[test]
    fn score_query_exposes_shortlist_loss_and_explicit_foreign_ids() {
        let query = BenchmarkQuery {
            id: "q".into(),
            query: "cause and recovery".into(),
            relevant_ids: vec!["cause".into(), "recovery".into()],
            must_include_ids: vec!["recovery".into()],
            must_exclude_ids: vec!["foreign".into()],
            top_k: 2,
            shortlist_k: 2,
        };
        let full_corpus = score_query(
            &query,
            vec![
                RankedId {
                    id: "recovery".into(),
                    score: 0.99,
                },
                RankedId {
                    id: "cause".into(),
                    score: 0.98,
                },
                RankedId {
                    id: "foreign".into(),
                    score: 0.10,
                },
            ],
        );
        let bounded_shortlist = score_query(
            &query,
            vec![
                RankedId {
                    id: "cause".into(),
                    score: 0.95,
                },
                RankedId {
                    id: "foreign".into(),
                    score: 0.90,
                },
            ],
        );

        assert_eq!(full_corpus.relevant_recall_at_k, 1.0);
        assert_eq!(full_corpus.must_include_recall_at_k, Some(1.0));
        assert_eq!(full_corpus.must_exclude_passed, Some(true));
        assert_eq!(bounded_shortlist.relevant_recall_at_k, 0.5);
        assert_eq!(bounded_shortlist.must_include_recall_at_k, Some(0.0));
        assert_eq!(bounded_shortlist.must_exclude_hits_at_k, 1);
        assert_eq!(bounded_shortlist.must_exclude_passed, Some(false));
    }

    #[tokio::test]
    async fn combined_path_sends_only_the_declared_embedding_shortlist() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/reranking-model"))
            .and(wiremock::matchers::header("ai-model-id", "rerank-test"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "documents": {
                    "type": "text",
                    "values": ["first candidate", "decisive recovery"]
                },
                "query": "what proves recovery",
                "topN": 2
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ranking": [
                        {"index": 1, "relevanceScore": 0.9},
                        {"index": 0, "relevanceScore": 0.2}
                    ],
                    "warnings": []
                })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let gateway = GatewayClient {
            client: reqwest::Client::new(),
            base: Url::parse(&format!("{}/", server.uri())).unwrap(),
            credential: "synthetic-test-credential".into(),
        };
        let mut dataset = BenchmarkDataset {
            name: "combined-shortlist-test".into(),
            documents: vec![
                LabDocument {
                    id: "d1".into(),
                    text: "first candidate".into(),
                },
                LabDocument {
                    id: "d2".into(),
                    text: "decisive recovery".into(),
                },
                LabDocument {
                    id: "foreign".into(),
                    text: "foreign incident".into(),
                },
            ],
            queries: vec![BenchmarkQuery {
                id: "q1".into(),
                query: "what proves recovery".into(),
                relevant_ids: vec!["d2".into()],
                must_include_ids: vec!["d2".into()],
                must_exclude_ids: vec!["foreign".into()],
                top_k: 1,
                shortlist_k: 2,
            }],
        };
        validate_dataset(&dataset).unwrap();
        dataset.queries[0].shortlist_k = dataset.documents.len();
        assert!(
            validate_dataset(&dataset).is_err(),
            "a combined shortlist may not alias the full-corpus control"
        );
        dataset.queries[0].shortlist_k = 2;
        let embedding_rankings = vec![vec![
            RankedId {
                id: "d1".into(),
                score: 0.8,
            },
            RankedId {
                id: "d2".into(),
                score: 0.7,
            },
            RankedId {
                id: "foreign".into(),
                score: 0.6,
            },
        ]];

        let (summary, _, _) = run_combined_query_shape(
            &gateway,
            &dataset,
            "rerank-test",
            "plain",
            &embedding_rankings,
        )
        .await
        .unwrap();
        assert_eq!(
            summary.queries[0]
                .shortlist_ranking
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["d1", "d2"]
        );
        assert_eq!(
            summary.queries[0].final_result.ranking[0].id, "d2",
            "reranker indices map back through the shortlist, not the corpus"
        );
        assert_eq!(
            summary.queries[0].final_result.must_exclude_passed,
            Some(true)
        );
    }

    #[test]
    fn committed_direct_dataset_is_valid() {
        let dataset: BenchmarkDataset = serde_json::from_str(include_str!(
            "../../../../fixtures/log-lab/scenarios/vercel-retrieval-direct/v1.json"
        ))
        .unwrap();
        validate_dataset(&dataset).unwrap();
        assert_eq!(dataset.queries.len(), 7);
        assert!(dataset.documents.len() >= 40);
        assert!(dataset.queries.iter().all(|query| {
            !query.must_exclude_ids.is_empty()
                && query.shortlist_k >= query.top_k
                && query.shortlist_k < dataset.documents.len()
        }));
        let allowed_kinds = HashSet::from([
            "application_error",
            "cause_record",
            "config_error",
            "config_event",
            "deployment_event",
            "exception_header",
            "process_error",
            "resource_error",
            "state_event",
            "status_event",
            "tls_error",
        ]);
        for document in &dataset.documents {
            let kind = document
                .text
                .strip_prefix("kind=")
                .and_then(|text| text.split_once(' '))
                .map(|(kind, _)| kind)
                .expect("fixture documents start with a structural kind");
            assert!(
                allowed_kinds.contains(kind),
                "fixture kind must be structural, never evaluator truth: {kind}"
            );
        }
    }
}
