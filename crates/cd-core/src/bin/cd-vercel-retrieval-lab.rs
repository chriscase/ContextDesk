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
                        documents,
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
    documents: &'a [String],
    query: &'a str,
    top_n: usize,
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
    top_k: usize,
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
    non_relevant_share_at_k: f64,
    ranking: Vec<RankedId>,
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
        if query.relevant_ids.is_empty() {
            bail!("each benchmark query must declare at least one relevant id");
        }
        for id in query.relevant_ids.iter().chain(&query.must_include_ids) {
            if !document_ids.contains(id.as_str()) {
                bail!("query truth references an unknown document id");
            }
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
        for (shape, shaped_query_vectors) in shapes {
            let queries = rank_embedding_queries(&dataset, document_vectors, shaped_query_vectors)?;
            query_shapes.push(summarize_query_shape(shape, queries));
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
    })
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
    QueryBenchmark {
        id: query.id.clone(),
        top_k: query.top_k,
        relevant_recall_at_k: recall(&query.relevant_ids, &top_ids).unwrap_or(0.0),
        must_include_recall_at_k: recall(&query.must_include_ids, &top_ids),
        non_relevant_share_at_k: 1.0 - relevant_hits as f64 / query.top_k as f64,
        ranking: ranking.into_iter().take(OUTPUT_RANKED_IDS).collect(),
    }
}

fn rank_embedding_queries(
    dataset: &BenchmarkDataset,
    document_vectors: &[Vec<f32>],
    query_vectors: &[Vec<f32>],
) -> Result<Vec<QueryBenchmark>> {
    dataset
        .queries
        .iter()
        .zip(query_vectors)
        .map(|(query, query_vector)| {
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
            Ok(score_query(query, ranking))
        })
        .collect()
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
    QueryShapeBenchmark {
        query_shape,
        mean_relevant_recall_at_k: queries
            .iter()
            .map(|query| query.relevant_recall_at_k)
            .sum::<f64>()
            / count,
        mean_must_include_recall_at_k: (!must_include_values.is_empty())
            .then(|| must_include_values.iter().sum::<f64>() / must_include_values.len() as f64),
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
    fn cosine_and_recall_are_stable() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]).unwrap() - 1.0).abs() < 1e-9);
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0]).unwrap()).abs() < 1e-9);
        let actual = HashSet::from(["a", "c"]);
        assert_eq!(recall(&["a".into(), "b".into()], &actual), Some(0.5));
        assert_eq!(recall(&[], &actual), None);
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
