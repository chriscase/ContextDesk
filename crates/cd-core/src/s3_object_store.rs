//! Feature-gated S3-compatible transport for [`crate::object_store::ObjectStore`].
//!
//! The backend deliberately uses explicit runtime credentials and an
//! SSRF-vetted, DNS-pinned HTTP client. It never calls the SDK's environment
//! loader, never follows redirects, and never returns SDK error bodies.

use crate::keychain_store::looks_like_raw_secret;
use crate::object_store::{
    ListObjectsPage, ListObjectsRequest, ObjectCredentials, ObjectKey, ObjectMetadata,
    ObjectOperation, ObjectPrefix, ObjectStore, ObjectStoreError, PutObjectOptions,
};
use crate::ssrf::{
    resolve_and_validate, validate_provider_url, DnsResolver, SsrfPolicy, SystemResolver,
};
use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Limited};
use object_store_sdk::aws::{AmazonS3, AmazonS3Builder};
use object_store_sdk::client::{
    ClientOptions, HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest, HttpResponse,
    HttpResponseBody, HttpService,
};
use object_store_sdk::list::{PaginatedListOptions, PaginatedListStore};
use object_store_sdk::path::Path as SdkPath;
use object_store_sdk::{
    Attribute, AttributeValue, Attributes, GetOptions, MultipartUpload,
    ObjectMeta as SdkObjectMeta, ObjectStore as SdkObjectStore, PutMultipartOptions, PutOptions,
    PutPayload, RetryConfig,
};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use url::Url;

/// Fixed multipart block. S3-compatible services generally require at least
/// 5 MiB for every non-final part; 8 MiB stays compatible while bounding RAM.
pub const S3_MULTIPART_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Maximum buffered XML/control response. Object downloads bypass this cap and
/// remain streaming; non-success bodies are discarded without being polled.
pub const S3_CONTROL_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

const CONTENT_HASH_METADATA: &str = "contextdesk-sha256";
const SCRUBBED_ERROR_BODY: &str = "[upstream error body omitted]";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Validated reference to one keychain item. The referenced secret is not
/// present in this value and cannot be constructed from a raw-looking token.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct S3KeychainRef(String);

impl S3KeychainRef {
    /// Parse a keychain reference identifier.
    pub fn parse(value: impl Into<String>) -> Result<Self, ObjectStoreError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty()
            || trimmed.len() > 256
            || trimmed.chars().any(char::is_control)
            || !trimmed.contains('/')
            || looks_like_raw_secret(trimmed)
        {
            return Err(ObjectStoreError::InvalidInput {
                reason: "invalid S3 keychain reference",
            });
        }
        Ok(Self(trimmed.to_string()))
    }

    /// Non-secret identifier used by the trusted host to query the keychain.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for S3KeychainRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("S3KeychainRef([KEYCHAIN REF])")
    }
}

impl<'de> Deserialize<'de> for S3KeychainRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Persistable S3-compatible destination configuration.
///
/// Only non-secret destination fields and keychain reference identifiers are
/// serializable. Access keys, secret keys, and session tokens enter the backend
/// separately as [`ObjectCredentials`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct S3ObjectStoreConfig {
    /// Whether the destination is enabled for product use.
    pub enabled: bool,
    /// Base HTTP(S) endpoint. Userinfo, query, fragment, and endpoint paths are rejected.
    pub endpoint: String,
    /// Signing region.
    pub region: String,
    /// Bucket name, never interpreted as a URL.
    pub bucket: String,
    /// Optional stable namespace within the bucket.
    pub prefix: String,
    /// Use `/bucket/key` requests (required by most MinIO-style endpoints).
    pub path_style: bool,
    /// Explicit opt-in for private-network endpoints. Link-local remains forbidden.
    pub allow_private_network: bool,
    /// Keychain reference for the access key id.
    pub access_key_ref: S3KeychainRef,
    /// Keychain reference for the secret access key.
    pub secret_key_ref: S3KeychainRef,
    /// Optional keychain reference for a session token.
    pub session_token_ref: Option<S3KeychainRef>,
}

impl fmt::Debug for S3ObjectStoreConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3ObjectStoreConfig")
            .field("enabled", &self.enabled)
            .field("endpoint", &safe_endpoint_identity(&self.endpoint))
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .field("path_style", &self.path_style)
            .field("allow_private_network", &self.allow_private_network)
            .field("access_key_ref", &"[KEYCHAIN REF]")
            .field("secret_key_ref", &"[KEYCHAIN REF]")
            .field(
                "session_token_ref",
                &self.session_token_ref.as_ref().map(|_| "[KEYCHAIN REF]"),
            )
            .finish()
    }
}

impl S3ObjectStoreConfig {
    /// Endpoint hostname for trusted confirmation and redacted destination UI.
    pub fn endpoint_host(&self) -> Result<String, ObjectStoreError> {
        let url = Url::parse(&self.endpoint).map_err(|_| ObjectStoreError::EndpointPolicy)?;
        url.host_str()
            .filter(|host| !host.is_empty())
            .map(str::to_string)
            .ok_or(ObjectStoreError::EndpointPolicy)
    }

    /// Validate configuration with production DNS. Call this immediately before
    /// saving non-secret configuration.
    pub fn validate_for_save(&self) -> Result<(), ObjectStoreError> {
        self.validate_with_resolver(&SystemResolver).map(|_| ())
    }

    /// Offline-testable validation with an injected resolver.
    pub fn validate_with_resolver(
        &self,
        resolver: &(impl DnsResolver + ?Sized),
    ) -> Result<ValidatedS3Config, ObjectStoreError> {
        validate_region(&self.region)?;
        validate_bucket(&self.bucket)?;
        let prefix = ObjectPrefix::parse(self.prefix.clone())?;
        let endpoint =
            validate_endpoint(&self.endpoint, self.allow_private_network, resolver, false)?;
        let request_endpoint = request_endpoint(&endpoint, &self.bucket, self.path_style)?;
        validate_endpoint(
            request_endpoint.as_str(),
            self.allow_private_network,
            resolver,
            true,
        )?;

        Ok(ValidatedS3Config {
            endpoint,
            request_endpoint,
            prefix: normalize_prefix(prefix),
        })
    }
}

/// Result of endpoint and namespace validation. Contains no credential material.
#[derive(Clone, Debug)]
pub struct ValidatedS3Config {
    endpoint: Url,
    request_endpoint: Url,
    prefix: Option<String>,
}

impl ValidatedS3Config {
    /// User-configured endpoint after validation.
    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    /// Effective endpoint after safe virtual-host bucket composition.
    pub fn request_endpoint(&self) -> &Url {
        &self.request_endpoint
    }
}

#[derive(Clone)]
struct PinnedReqwestConnector {
    client: reqwest13::Client,
}

impl fmt::Debug for PinnedReqwestConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PinnedReqwestConnector")
    }
}

impl HttpConnector for PinnedReqwestConnector {
    fn connect(&self, _options: &ClientOptions) -> object_store_sdk::Result<HttpClient> {
        Ok(HttpClient::new(BoundedResponseService {
            inner: HttpClient::new(self.client.clone()),
            control_body_limit: S3_CONTROL_RESPONSE_BYTES,
        }))
    }
}

#[derive(Clone, Debug)]
struct BoundedResponseService {
    inner: HttpClient,
    control_body_limit: usize,
}

#[async_trait]
impl HttpService for BoundedResponseService {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        // Plain GETs are object downloads and must remain streaming. S3 list
        // requests have a query string and are bounded control-plane XML.
        let streaming_object_get =
            request.method().as_str() == "GET" && request.uri().query().is_none();
        let response = self.inner.execute(request).await?;

        if !response.status().is_success() {
            // Do not poll an untrusted error body at all. The SDK still sees
            // the status and headers needed for typed error classification.
            let (parts, _untrusted_body) = response.into_parts();
            return Ok(HttpResponse::from_parts(
                parts,
                HttpResponseBody::from(SCRUBBED_ERROR_BODY.to_string()),
            ));
        }

        if streaming_object_get {
            return Ok(response);
        }

        let (parts, body) = response.into_parts();
        let limited = Limited::new(body, self.control_body_limit)
            .map_err(|error| HttpError::new_boxed(HttpErrorKind::Decode, error));
        Ok(HttpResponse::from_parts(
            parts,
            HttpResponseBody::new(limited),
        ))
    }
}

/// S3-compatible implementation of ContextDesk's bounded [`ObjectStore`].
pub struct S3ObjectStore {
    config: S3ObjectStoreConfig,
    validated: ValidatedS3Config,
    store: AmazonS3,
    request_timeout: Duration,
}

impl fmt::Debug for S3ObjectStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3ObjectStore")
            .field(
                "endpoint",
                &safe_endpoint_identity(self.validated.endpoint.as_str()),
            )
            .field("region", &self.config.region)
            .field("bucket", &self.config.bucket)
            .field("prefix", &self.config.prefix)
            .field("path_style", &self.config.path_style)
            .field("allow_private_network", &self.config.allow_private_network)
            .field("credentials", &"[RUNTIME ONLY]")
            .finish()
    }
}

impl S3ObjectStore {
    /// Build with production DNS and the default request timeout.
    pub fn new(
        config: S3ObjectStoreConfig,
        credentials: ObjectCredentials,
    ) -> Result<Self, ObjectStoreError> {
        Self::new_with_resolver(
            config,
            credentials,
            Arc::new(SystemResolver),
            DEFAULT_REQUEST_TIMEOUT,
        )
    }

    /// Build with an injected resolver and explicit timeout for hermetic tests.
    pub fn new_with_resolver(
        config: S3ObjectStoreConfig,
        credentials: ObjectCredentials,
        resolver: Arc<dyn DnsResolver>,
        request_timeout: Duration,
    ) -> Result<Self, ObjectStoreError> {
        if request_timeout.is_zero() || request_timeout > MAX_REQUEST_TIMEOUT {
            return Err(ObjectStoreError::InvalidInput {
                reason: "S3 request timeout must be between 1ms and 10 minutes",
            });
        }
        let validated = config.validate_with_resolver(resolver.as_ref())?;
        let client = build_pinned_reqwest_client(
            &validated.request_endpoint,
            &config,
            resolver.as_ref(),
            request_timeout,
        )?;
        let connector = PinnedReqwestConnector { client };

        let retry = RetryConfig {
            max_retries: 0,
            retry_timeout: request_timeout,
            ..RetryConfig::default()
        };

        // `new`, unlike `from_env`, never reads AWS_* variables. Supplying both
        // explicit values selects the SDK's static credential provider and
        // prevents instance/container metadata discovery.
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&config.bucket)
            .with_region(&config.region)
            .with_endpoint(validated.request_endpoint.as_str())
            .with_virtual_hosted_style_request(!config.path_style)
            .with_allow_http(validated.request_endpoint.scheme() == "http")
            .with_access_key_id(credentials.access_key())
            .with_secret_access_key(credentials.secret_key())
            .with_http_connector(connector)
            .with_retry(retry)
            .with_client_options(
                ClientOptions::new()
                    .with_timeout(request_timeout)
                    .with_connect_timeout(request_timeout.min(Duration::from_secs(5)))
                    .with_allow_http(validated.request_endpoint.scheme() == "http"),
            );
        if let Some(token) = credentials.session_token() {
            builder = builder.with_token(token);
        }
        let store = builder
            .build()
            .map_err(|_| ObjectStoreError::EndpointPolicy)?;

        Ok(Self {
            config,
            validated,
            store,
            request_timeout,
        })
    }

    fn validate_before_request(&self, operation: &ObjectOperation) -> Result<(), ObjectStoreError> {
        operation.check()?;
        validate_region(&self.config.region)?;
        validate_bucket(&self.config.bucket)?;
        let _ = ObjectPrefix::parse(self.config.prefix.clone())?;
        let endpoint = validate_endpoint_shape(
            &self.config.endpoint,
            self.config.allow_private_network,
            false,
        )?;
        let request_endpoint =
            request_endpoint(&endpoint, &self.config.bucket, self.config.path_style)?;
        let request_endpoint = validate_endpoint_shape(
            request_endpoint.as_str(),
            self.config.allow_private_network,
            true,
        )?;
        if endpoint != self.validated.endpoint
            || request_endpoint != self.validated.request_endpoint
        {
            return Err(ObjectStoreError::EndpointPolicy);
        }
        Ok(())
    }

    fn remote_key(&self, key: &ObjectKey) -> Result<SdkPath, ObjectStoreError> {
        let value = match &self.validated.prefix {
            Some(prefix) => format!("{prefix}/{}", key.as_str()),
            None => key.as_str().to_string(),
        };
        SdkPath::parse(value).map_err(|_| ObjectStoreError::InvalidInput {
            reason: "invalid normalized S3 object key",
        })
    }

    fn remote_prefix(&self, prefix: &ObjectPrefix) -> String {
        match (&self.validated.prefix, prefix.as_str()) {
            (Some(base), "") => format!("{base}/"),
            (Some(base), child) => format!("{base}/{child}"),
            (None, child) => child.to_string(),
        }
    }

    fn local_key(&self, remote: &SdkPath) -> Result<ObjectKey, ObjectStoreError> {
        let remote = remote.as_ref();
        let local = match &self.validated.prefix {
            Some(prefix) => remote
                .strip_prefix(prefix)
                .and_then(|value| value.strip_prefix('/'))
                .ok_or(ObjectStoreError::EndpointPolicy)?,
            None => remote,
        };
        ObjectKey::parse(local.to_string())
    }

    async fn await_sdk<T>(
        &self,
        operation: &ObjectOperation,
        future: impl Future<Output = object_store_sdk::Result<T>>,
    ) -> Result<T, ObjectStoreError> {
        operation.check()?;
        if let Some(deadline) = operation.deadline() {
            tokio::select! {
                _ = operation.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    Err(ObjectStoreError::Timeout)
                }
                result = future => result.map_err(map_sdk_error),
            }
        } else {
            tokio::select! {
                _ = operation.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                result = future => result.map_err(map_sdk_error),
            }
        }
    }

    async fn abort_bounded(&self, upload: &mut dyn MultipartUpload) {
        let _ = tokio::time::timeout(self.request_timeout, upload.abort()).await;
    }

    async fn put_small(
        &self,
        path: &SdkPath,
        body: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        options: &PutObjectOptions,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        let expected = options.content_length.unwrap_or_default() as usize;
        let mut bytes = Vec::with_capacity(expected);
        let mut buffer = vec![0_u8; crate::object_store::OBJECT_IO_CHUNK_BYTES];
        loop {
            let read = operation.read(body, &mut buffer).await?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            if bytes.len() > S3_MULTIPART_CHUNK_BYTES {
                return Err(ObjectStoreError::InvalidInput {
                    reason: "small S3 upload exceeded bounded buffer",
                });
            }
        }
        let digest = hash_hex(&bytes);
        validate_body(options, bytes.len() as u64, &digest)?;
        let put_options = sdk_put_options(options, &digest);
        let result = self
            .await_sdk(
                operation,
                self.store
                    .put_opts(path, PutPayload::from(Bytes::from(bytes)), put_options),
            )
            .await?;
        Ok(ObjectMetadata {
            key: self.local_key(path)?,
            content_length: expected as u64,
            etag: result.e_tag,
            content_sha256: Some(digest),
        })
    }

    async fn put_multipart(
        &self,
        path: &SdkPath,
        body: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        options: &PutObjectOptions,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        let mut hasher = Sha256::new();
        let mut uploaded = 0_u64;
        let attributes = sdk_attributes(options, options.content_sha256.as_deref());
        let mut upload = self
            .await_sdk(
                operation,
                self.store.put_multipart_opts(
                    path,
                    PutMultipartOptions {
                        attributes,
                        ..PutMultipartOptions::default()
                    },
                ),
            )
            .await?;

        loop {
            let mut part = Vec::with_capacity(S3_MULTIPART_CHUNK_BYTES);
            while part.len() < S3_MULTIPART_CHUNK_BYTES {
                let remaining = S3_MULTIPART_CHUNK_BYTES - part.len();
                let mut chunk =
                    vec![0_u8; remaining.min(crate::object_store::OBJECT_IO_CHUNK_BYTES)];
                let read = match operation.read(body, &mut chunk).await {
                    Ok(read) => read,
                    Err(error) => {
                        self.abort_bounded(upload.as_mut()).await;
                        return Err(error);
                    }
                };
                if read == 0 {
                    break;
                }
                part.extend_from_slice(&chunk[..read]);
            }
            if part.is_empty() {
                break;
            }

            hasher.update(&part);
            uploaded = uploaded.saturating_add(part.len() as u64);
            let part_future = upload.put_part(PutPayload::from(Bytes::from(part)));
            if let Err(error) = self.await_sdk(operation, part_future).await {
                self.abort_bounded(upload.as_mut()).await;
                return Err(error);
            }
        }

        let digest = digest_hex(hasher.finalize());
        if let Err(error) = validate_body(options, uploaded, &digest) {
            self.abort_bounded(upload.as_mut()).await;
            return Err(error);
        }
        let result = match self.await_sdk(operation, upload.complete()).await {
            Ok(result) => result,
            Err(error) => {
                self.abort_bounded(upload.as_mut()).await;
                return Err(error);
            }
        };
        Ok(ObjectMetadata {
            key: self.local_key(path)?,
            content_length: uploaded,
            etag: result.e_tag,
            content_sha256: Some(digest),
        })
    }
}

#[async_trait]
impl ObjectStore for S3ObjectStore {
    async fn put(
        &self,
        key: &ObjectKey,
        body: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        options: &PutObjectOptions,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        self.validate_before_request(operation)?;
        let path = self.remote_key(key)?;
        match options.content_length {
            Some(length) if length <= S3_MULTIPART_CHUNK_BYTES as u64 => {
                self.put_small(&path, body, options, operation).await
            }
            _ => self.put_multipart(&path, body, options, operation).await,
        }
    }

    async fn get(
        &self,
        key: &ObjectKey,
        sink: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        self.validate_before_request(operation)?;
        let path = self.remote_key(key)?;
        let result = self
            .await_sdk(operation, self.store.get_opts(&path, GetOptions::default()))
            .await?;
        let metadata = metadata_from_get(self, result.meta.clone(), &result.attributes)?;
        let mut stream = result.into_stream();
        loop {
            let next = if let Some(deadline) = operation.deadline() {
                tokio::select! {
                    _ = operation.cancellation.cancelled() => return Err(ObjectStoreError::Cancelled),
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                        return Err(ObjectStoreError::Timeout);
                    }
                    next = stream.next() => next,
                }
            } else {
                tokio::select! {
                    _ = operation.cancellation.cancelled() => return Err(ObjectStoreError::Cancelled),
                    next = stream.next() => next,
                }
            };
            match next {
                Some(Ok(bytes)) => operation.write_all(sink, &bytes).await?,
                Some(Err(error)) => return Err(map_sdk_error(error)),
                None => break,
            }
        }
        operation.flush(sink).await?;
        Ok(metadata)
    }

    async fn head(
        &self,
        key: &ObjectKey,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        self.validate_before_request(operation)?;
        let path = self.remote_key(key)?;
        let result = self
            .await_sdk(
                operation,
                self.store.get_opts(
                    &path,
                    GetOptions {
                        head: true,
                        ..GetOptions::default()
                    },
                ),
            )
            .await?;
        metadata_from_get(self, result.meta, &result.attributes)
    }

    async fn list(
        &self,
        request: &ListObjectsRequest,
        operation: &ObjectOperation,
    ) -> Result<ListObjectsPage, ObjectStoreError> {
        self.validate_before_request(operation)?;
        let prefix = self.remote_prefix(&request.prefix);
        let result = self
            .await_sdk(
                operation,
                self.store.list_paginated(
                    (!prefix.is_empty()).then_some(prefix.as_str()),
                    PaginatedListOptions {
                        max_keys: Some(request.max_keys),
                        page_token: request.continuation.clone(),
                        ..PaginatedListOptions::default()
                    },
                ),
            )
            .await?;
        let objects = result
            .result
            .objects
            .into_iter()
            .map(|meta| metadata_from_list(self, meta))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListObjectsPage {
            objects,
            next_continuation: result.page_token,
        })
    }
}

fn validate_endpoint(
    raw: &str,
    allow_private_network: bool,
    resolver: &(impl DnsResolver + ?Sized),
    derived: bool,
) -> Result<Url, ObjectStoreError> {
    let url = validate_endpoint_shape(raw, allow_private_network, derived)?;
    let policy = if allow_private_network {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy {
            block_private: true,
            allow_loopback: false,
        }
    };
    let ips = resolve_and_validate(&url, &policy, resolver)
        .map_err(|_| ObjectStoreError::EndpointPolicy)?;
    if url.scheme() == "http"
        && (!allow_private_network
            || ips.is_empty()
            || !ips.iter().all(|ip| is_private_fixture_destination(*ip)))
    {
        return Err(ObjectStoreError::EndpointPolicy);
    }
    Ok(url)
}

fn validate_endpoint_shape(
    raw: &str,
    allow_private_network: bool,
    derived: bool,
) -> Result<Url, ObjectStoreError> {
    let policy = if allow_private_network {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy {
            block_private: true,
            allow_loopback: false,
        }
    };
    let url = validate_provider_url(raw, &policy).map_err(|_| ObjectStoreError::EndpointPolicy)?;
    if (!derived
        && (!url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"))
        || (url.scheme() == "http" && !allow_private_network)
    {
        return Err(ObjectStoreError::EndpointPolicy);
    }
    Ok(url)
}

fn request_endpoint(
    endpoint: &Url,
    bucket: &str,
    path_style: bool,
) -> Result<Url, ObjectStoreError> {
    if path_style {
        return Ok(endpoint.clone());
    }
    let host = endpoint
        .host_str()
        .ok_or(ObjectStoreError::EndpointPolicy)?;
    if host.parse::<IpAddr>().is_ok() {
        return Err(ObjectStoreError::EndpointPolicy);
    }
    let mut derived = endpoint.clone();
    derived
        .set_host(Some(&format!("{bucket}.{host}")))
        .map_err(|_| ObjectStoreError::EndpointPolicy)?;
    Ok(derived)
}

fn validate_region(region: &str) -> Result<(), ObjectStoreError> {
    if region.is_empty()
        || region.len() > 64
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ObjectStoreError::InvalidInput {
            reason: "invalid S3 region",
        });
    }
    Ok(())
}

fn validate_bucket(bucket: &str) -> Result<(), ObjectStoreError> {
    let bytes = bucket.as_bytes();
    let edge_alphanumeric = bytes
        .first()
        .zip(bytes.last())
        .is_some_and(|(first, last)| first.is_ascii_alphanumeric() && last.is_ascii_alphanumeric());
    if !(3..=63).contains(&bytes.len())
        || !edge_alphanumeric
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        || bucket.contains("..")
        || bucket.contains(".-")
        || bucket.contains("-.")
        || bucket.parse::<Ipv4Addr>().is_ok()
    {
        return Err(ObjectStoreError::InvalidInput {
            reason: "invalid S3 bucket",
        });
    }
    Ok(())
}

fn normalize_prefix(prefix: ObjectPrefix) -> Option<String> {
    let value = prefix.as_str().trim_end_matches('/');
    (!value.is_empty()).then(|| value.to_string())
}

fn is_private_fixture_destination(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || {
                let octets = ip.octets();
                octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000
            }
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

fn build_pinned_reqwest_client(
    endpoint: &Url,
    config: &S3ObjectStoreConfig,
    resolver: &(impl DnsResolver + ?Sized),
    timeout: Duration,
) -> Result<reqwest13::Client, ObjectStoreError> {
    let policy = if config.allow_private_network {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy {
            block_private: true,
            allow_loopback: false,
        }
    };
    let ips = resolve_and_validate(endpoint, &policy, resolver)
        .map_err(|_| ObjectStoreError::EndpointPolicy)?;
    let host = endpoint
        .host_str()
        .ok_or(ObjectStoreError::EndpointPolicy)?;
    let port = endpoint
        .port_or_known_default()
        .ok_or(ObjectStoreError::EndpointPolicy)?;
    let sockets = ips
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect::<Vec<_>>();

    // reqwest's rustls-no-provider mode shares the already-present ring
    // provider. Installation is idempotent if another caller got there first.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest13::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .redirect(reqwest13::redirect::Policy::none())
        .no_proxy()
        .user_agent("ContextDesk/S3");
    if host.parse::<IpAddr>().is_err() && !host.eq_ignore_ascii_case("localhost") {
        builder = builder.resolve_to_addrs(host, &sockets);
    }
    builder
        .build()
        .map_err(|_| ObjectStoreError::EndpointPolicy)
}

fn sdk_attributes(options: &PutObjectOptions, digest: Option<&str>) -> Attributes {
    let mut attributes = Attributes::new();
    if let Some(content_type) = &options.content_type {
        attributes.insert(
            Attribute::ContentType,
            AttributeValue::from(content_type.clone()),
        );
    }
    if let Some(digest) = digest {
        attributes.insert(
            Attribute::Metadata(Cow::Borrowed(CONTENT_HASH_METADATA)),
            AttributeValue::from(digest.to_string()),
        );
    }
    attributes
}

fn sdk_put_options(options: &PutObjectOptions, digest: &str) -> PutOptions {
    PutOptions {
        attributes: sdk_attributes(options, Some(digest)),
        ..PutOptions::default()
    }
}

fn validate_body(
    options: &PutObjectOptions,
    actual_length: u64,
    actual_digest: &str,
) -> Result<(), ObjectStoreError> {
    if options
        .content_length
        .is_some_and(|expected| expected != actual_length)
    {
        return Err(ObjectStoreError::InvalidInput {
            reason: "upload content length mismatch",
        });
    }
    if options
        .content_sha256
        .as_deref()
        .is_some_and(|expected| !expected.eq_ignore_ascii_case(actual_digest))
    {
        return Err(ObjectStoreError::InvalidInput {
            reason: "upload content hash mismatch",
        });
    }
    Ok(())
}

fn metadata_from_get(
    backend: &S3ObjectStore,
    meta: SdkObjectMeta,
    attributes: &Attributes,
) -> Result<ObjectMetadata, ObjectStoreError> {
    let hash = attributes
        .get(&Attribute::Metadata(Cow::Borrowed(CONTENT_HASH_METADATA)))
        .map(|value| value.as_ref().to_string());
    Ok(ObjectMetadata {
        key: backend.local_key(&meta.location)?,
        content_length: meta.size,
        etag: meta.e_tag,
        content_sha256: hash,
    })
}

fn metadata_from_list(
    backend: &S3ObjectStore,
    meta: SdkObjectMeta,
) -> Result<ObjectMetadata, ObjectStoreError> {
    Ok(ObjectMetadata {
        key: backend.local_key(&meta.location)?,
        content_length: meta.size,
        etag: meta.e_tag,
        content_sha256: None,
    })
}

fn map_sdk_error(error: object_store_sdk::Error) -> ObjectStoreError {
    match error {
        object_store_sdk::Error::NotFound { .. } => ObjectStoreError::NotFound,
        object_store_sdk::Error::PermissionDenied { .. }
        | object_store_sdk::Error::Unauthenticated { .. } => ObjectStoreError::Authorization,
        object_store_sdk::Error::InvalidPath { .. }
        | object_store_sdk::Error::UnknownConfigurationKey { .. } => {
            ObjectStoreError::InvalidInput {
                reason: "invalid S3 request",
            }
        }
        other if error_chain_has_timeout(&other) => ObjectStoreError::Timeout,
        _ => ObjectStoreError::transport(None),
    }
}

fn error_chain_has_timeout(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(source) = current {
        if source
            .downcast_ref::<HttpError>()
            .is_some_and(|http| http.kind() == HttpErrorKind::Timeout)
        {
            return true;
        }
        current = source.source();
    }
    false
}

fn hash_hex(bytes: &[u8]) -> String {
    digest_hex(Sha256::digest(bytes))
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    let digest = digest.as_ref();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn safe_endpoint_identity(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return "[INVALID ENDPOINT]".to_string();
    };
    let Some(host) = url.host_str() else {
        return "[INVALID ENDPOINT]".to_string();
    };
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_store::ObjectCancellation;
    use crate::ssrf::MapResolver;
    use object_store_sdk::client::HttpRequestBody;
    use std::io::Cursor;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll};
    use tokio::time::sleep;
    use wiremock::matchers::{header, header_regex, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ACCESS: &str = "DUMMYACCESS123";
    const SECRET: &str = "dummy-secret-never-log";
    const TOKEN: &str = "dummy-session-token-never-log";
    const BODY_HASH: &str = "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8";

    fn config(endpoint: impl Into<String>) -> S3ObjectStoreConfig {
        S3ObjectStoreConfig {
            enabled: true,
            endpoint: endpoint.into(),
            region: "us-test-1".to_string(),
            bucket: "fixture-bucket".to_string(),
            prefix: "base/".to_string(),
            path_style: true,
            allow_private_network: true,
            access_key_ref: S3KeychainRef::parse("s3/fixture/access-key").unwrap(),
            secret_key_ref: S3KeychainRef::parse("s3/fixture/secret-key").unwrap(),
            session_token_ref: Some(S3KeychainRef::parse("s3/fixture/session-token").unwrap()),
        }
    }

    fn credentials(with_token: bool) -> ObjectCredentials {
        ObjectCredentials::new(ACCESS, SECRET, with_token.then(|| TOKEN.to_string())).unwrap()
    }

    fn fixture_backend(
        server: &MockServer,
        timeout: Duration,
    ) -> Result<S3ObjectStore, ObjectStoreError> {
        S3ObjectStore::new_with_resolver(
            config(server.uri()),
            credentials(false),
            Arc::new(MapResolver::default()),
            timeout,
        )
    }

    fn signed() -> impl wiremock::Match {
        header_regex(
            "authorization",
            "^AWS4-HMAC-SHA256 Credential=DUMMYACCESS123/",
        )
    }

    #[derive(Clone, Debug)]
    struct LazyFixtureService {
        status: u16,
        chunk: Bytes,
        polls: Arc<AtomicUsize>,
    }

    #[derive(Debug)]
    struct LazyFixtureBody {
        chunk: Option<Bytes>,
        polls: Arc<AtomicUsize>,
    }

    impl http_body::Body for LazyFixtureBody {
        type Data = Bytes;
        type Error = HttpError;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
            self.polls.fetch_add(1, Ordering::SeqCst);
            Poll::Ready(self.chunk.take().map(http_body::Frame::data).map(Ok))
        }
    }

    #[async_trait]
    impl HttpService for LazyFixtureService {
        async fn call(&self, _request: HttpRequest) -> Result<HttpResponse, HttpError> {
            let mut response = HttpResponse::new(HttpResponseBody::new(LazyFixtureBody {
                chunk: Some(self.chunk.clone()),
                polls: Arc::clone(&self.polls),
            }));
            *response.status_mut() = self.status.try_into().unwrap();
            Ok(response)
        }
    }

    fn fixture_request(method: &str, uri: &str) -> HttpRequest {
        let mut request = HttpRequest::new(HttpRequestBody::empty());
        *request.method_mut() = method.parse().unwrap();
        *request.uri_mut() = uri.parse().unwrap();
        request
    }

    #[test]
    fn config_serialization_and_diagnostics_never_contain_credentials() {
        let cfg = config("http://127.0.0.1:9000");
        let json = serde_json::to_string(&cfg).unwrap();
        let debug = format!("{cfg:?}");
        for secret in [ACCESS, SECRET, TOKEN] {
            assert!(!json.contains(secret), "{json}");
            assert!(!debug.contains(secret), "{debug}");
        }
        assert!(json.contains("s3/fixture/access-key"));
        assert!(!debug.contains("s3/fixture/access-key"));

        let backend = S3ObjectStore::new_with_resolver(
            cfg,
            credentials(true),
            Arc::new(MapResolver::default()),
            Duration::from_secs(2),
        )
        .unwrap();
        let backend_debug = format!("{backend:?}");
        for secret in [ACCESS, SECRET, TOKEN] {
            assert!(!backend_debug.contains(secret), "{backend_debug}");
        }

        let bad = serde_json::json!({
            "enabled": true,
            "endpoint": "https://objects.example.com",
            "region": "us-test-1",
            "bucket": "fixture-bucket",
            "prefix": "",
            "path_style": true,
            "allow_private_network": false,
            "access_key_ref": "sk-this-is-a-raw-secret-not-a-ref",
            "secret_key_ref": "s3/fixture/secret-key",
            "session_token_ref": null
        });
        assert!(serde_json::from_value::<S3ObjectStoreConfig>(bad).is_err());
    }

    #[test]
    fn endpoint_policy_accepts_public_https_and_explicit_private_fixture_only() {
        let public = MapResolver::from_pairs([(
            "objects.example.com",
            vec!["93.184.216.34".parse().unwrap()],
        )]);
        let mut public_cfg = config("https://objects.example.com");
        public_cfg.allow_private_network = false;
        assert!(public_cfg.validate_with_resolver(&public).is_ok());

        let mut private_cfg = config("http://127.0.0.1:9000");
        private_cfg.allow_private_network = false;
        assert!(matches!(
            private_cfg.validate_with_resolver(&MapResolver::default()),
            Err(ObjectStoreError::EndpointPolicy)
        ));
        private_cfg.allow_private_network = true;
        assert!(private_cfg
            .validate_with_resolver(&MapResolver::default())
            .is_ok());

        let mut public_http = config("http://objects.example.com");
        public_http.allow_private_network = true;
        assert!(matches!(
            public_http.validate_with_resolver(&public),
            Err(ObjectStoreError::EndpointPolicy)
        ));
    }

    #[test]
    fn endpoint_policy_rejects_metadata_link_local_userinfo_and_url_overrides() {
        for endpoint in [
            "http://169.254.169.254",
            "http://169.254.10.20",
            "https://DUMMYACCESS:secret@objects.example.com",
            "https://objects.example.com/hidden-base",
            "file:///tmp/objects",
        ] {
            let cfg = config(endpoint);
            assert!(
                cfg.validate_with_resolver(&MapResolver::default()).is_err(),
                "endpoint accepted: {endpoint}"
            );
        }

        let mut bad_bucket = config("http://127.0.0.1:9000");
        bad_bucket.bucket = "evil.example/path".to_string();
        assert!(bad_bucket
            .validate_with_resolver(&MapResolver::default())
            .is_err());
        assert!(ObjectKey::parse("https://evil.example/override").is_err());
    }

    #[tokio::test]
    async fn signed_path_style_put_get_head_and_list_are_hermetic() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/fixture-bucket/base/ws/a.txt"))
            .and(signed())
            .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"put-etag\""))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/fixture-bucket/base/ws/a.txt"))
            .and(signed())
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"get-etag\"")
                    .insert_header("content-length", "5")
                    .insert_header("x-amz-meta-contextdesk-sha256", BODY_HASH)
                    .set_body_bytes(b"alpha"),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("HEAD"))
            .and(path("/fixture-bucket/base/ws/a.txt"))
            .and(signed())
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"head-etag\"")
                    .insert_header("content-length", "5")
                    .insert_header("last-modified", "Fri, 24 Jul 2026 00:00:00 GMT")
                    .insert_header("x-amz-meta-contextdesk-sha256", BODY_HASH),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/fixture-bucket"))
            .and(query_param("list-type", "2"))
            .and(query_param("prefix", "base/ws/"))
            .and(query_param("max-keys", "2"))
            .and(signed())
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>fixture-bucket</Name><Prefix>base/ws/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>2</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>base/ws/a.txt</Key><LastModified>2026-07-24T00:00:00Z</LastModified>
  <ETag>"list-etag"</ETag><Size>5</Size><StorageClass>STANDARD</StorageClass></Contents>
</ListBucketResult>"#,
            ))
            .expect(1)
            .mount(&server)
            .await;

        let backend = fixture_backend(&server, Duration::from_secs(2)).unwrap();
        let key = ObjectKey::parse("ws/a.txt").unwrap();
        let operation = ObjectOperation::default();
        let mut input = Cursor::new(b"alpha".to_vec());
        let put = backend
            .put(
                &key,
                &mut input,
                &PutObjectOptions {
                    content_length: Some(5),
                    content_sha256: Some(BODY_HASH.to_string()),
                    content_type: Some("text/plain".to_string()),
                },
                &operation,
            )
            .await
            .unwrap();
        assert_eq!(put.content_length, 5);
        assert_eq!(put.content_sha256.as_deref(), Some(BODY_HASH));

        let mut output = Vec::new();
        let get = backend.get(&key, &mut output, &operation).await.unwrap();
        assert_eq!(output, b"alpha");
        assert_eq!(get.content_sha256.as_deref(), Some(BODY_HASH));

        let head = backend.head(&key, &operation).await.unwrap();
        assert_eq!(head.etag.as_deref(), Some("\"head-etag\""));
        assert_eq!(head.content_sha256.as_deref(), Some(BODY_HASH));

        let page = backend
            .list(
                &ListObjectsRequest::new(ObjectPrefix::parse("ws/").unwrap(), 2).unwrap(),
                &operation,
            )
            .await
            .unwrap();
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key.as_str(), "ws/a.txt");
        assert_eq!(page.objects[0].content_length, 5);
        assert!(page.next_continuation.is_none());
    }

    #[tokio::test]
    async fn redirect_to_forbidden_host_is_not_followed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/fixture-bucket/base/ws/redirect.txt"))
            .and(signed())
            .respond_with(
                ResponseTemplate::new(307)
                    .insert_header("location", "http://169.254.169.254/latest/meta-data"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let backend = fixture_backend(&server, Duration::from_secs(2)).unwrap();
        let mut output = Vec::new();
        let error = backend
            .get(
                &ObjectKey::parse("ws/redirect.txt").unwrap(),
                &mut output,
                &ObjectOperation::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ObjectStoreError::Transport { .. }));
        assert!(output.is_empty());
    }

    #[tokio::test]
    async fn timeout_and_cancellation_stop_the_client_future() {
        let server = MockServer::start().await;
        for file in ["timeout.txt", "cancel.txt"] {
            Mock::given(method("GET"))
                .and(path(format!("/fixture-bucket/base/ws/{file}")))
                .and(signed())
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_delay(Duration::from_millis(250))
                        .set_body_bytes(b"late"),
                )
                .expect(1)
                .mount(&server)
                .await;
        }
        let backend = Arc::new(fixture_backend(&server, Duration::from_secs(2)).unwrap());

        let mut timeout_output = Vec::new();
        let timeout_error = backend
            .get(
                &ObjectKey::parse("ws/timeout.txt").unwrap(),
                &mut timeout_output,
                &ObjectOperation::with_timeout(
                    ObjectCancellation::default(),
                    Duration::from_millis(20),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(timeout_error, ObjectStoreError::Timeout);

        let cancellation = ObjectCancellation::default();
        let task_cancellation = cancellation.clone();
        let task_backend = Arc::clone(&backend);
        let task = tokio::spawn(async move {
            let mut output = Vec::new();
            task_backend
                .get(
                    &ObjectKey::parse("ws/cancel.txt").unwrap(),
                    &mut output,
                    &ObjectOperation::new(task_cancellation),
                )
                .await
        });
        sleep(Duration::from_millis(20)).await;
        cancellation.cancel();
        assert_eq!(task.await.unwrap(), Err(ObjectStoreError::Cancelled));
    }

    #[tokio::test]
    async fn server_error_body_is_never_returned_or_formatted() {
        let server = MockServer::start().await;
        let body = format!("upstream exploded: {ACCESS} {SECRET} {TOKEN}");
        Mock::given(method("HEAD"))
            .and(path("/fixture-bucket/base/ws/error.txt"))
            .and(signed())
            .respond_with(ResponseTemplate::new(500).set_body_string(body))
            .expect(1)
            .mount(&server)
            .await;
        let backend = fixture_backend(&server, Duration::from_secs(2)).unwrap();
        let error = backend
            .head(
                &ObjectKey::parse("ws/error.txt").unwrap(),
                &ObjectOperation::default(),
            )
            .await
            .unwrap_err();
        let diagnostic = format!("{error:?} {error}");
        assert!(matches!(error, ObjectStoreError::Transport { .. }));
        for secret in [ACCESS, SECRET, TOKEN] {
            assert!(!diagnostic.contains(secret), "{diagnostic}");
        }
        assert!(!diagnostic.contains("upstream exploded"), "{diagnostic}");
    }

    #[tokio::test]
    async fn error_bodies_are_not_polled_and_control_responses_are_bounded() {
        let error_polls = Arc::new(AtomicUsize::new(0));
        let error_service = BoundedResponseService {
            inner: HttpClient::new(LazyFixtureService {
                status: 500,
                chunk: Bytes::from(format!("{ACCESS}:{SECRET}:{TOKEN}")),
                polls: Arc::clone(&error_polls),
            }),
            control_body_limit: 8,
        };
        let response = error_service
            .call(fixture_request(
                "HEAD",
                "https://objects.example.com/bucket/key",
            ))
            .await
            .unwrap();
        let body = response.into_body().bytes().await.unwrap();
        assert_eq!(body.as_ref(), SCRUBBED_ERROR_BODY.as_bytes());
        assert_eq!(error_polls.load(Ordering::SeqCst), 0);

        let control_polls = Arc::new(AtomicUsize::new(0));
        let control_service = BoundedResponseService {
            inner: HttpClient::new(LazyFixtureService {
                status: 200,
                chunk: Bytes::from_static(b"123456789"),
                polls: Arc::clone(&control_polls),
            }),
            control_body_limit: 8,
        };
        let error = control_service
            .call(fixture_request(
                "GET",
                "https://objects.example.com/bucket?list-type=2",
            ))
            .await
            .unwrap()
            .into_body()
            .bytes()
            .await
            .unwrap_err();
        assert_eq!(error.kind(), HttpErrorKind::Decode);
        assert_eq!(control_polls.load(Ordering::SeqCst), 1);

        let download_polls = Arc::new(AtomicUsize::new(0));
        let download_service = BoundedResponseService {
            inner: HttpClient::new(LazyFixtureService {
                status: 200,
                chunk: Bytes::from_static(b"123456789"),
                polls: Arc::clone(&download_polls),
            }),
            control_body_limit: 8,
        };
        let body = download_service
            .call(fixture_request(
                "GET",
                "https://objects.example.com/bucket/key",
            ))
            .await
            .unwrap()
            .into_body()
            .bytes()
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"123456789");
        assert_eq!(download_polls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn authorization_and_not_found_are_typed_without_secret_diagnostics() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path("/fixture-bucket/base/ws/forbidden.txt"))
            .and(signed())
            .and(header("x-amz-security-token", TOKEN))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_string(format!("<Error><Message>{SECRET}</Message></Error>")),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("HEAD"))
            .and(path("/fixture-bucket/base/ws/missing.txt"))
            .and(signed())
            .and(header("x-amz-security-token", TOKEN))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_string(format!("<Error><Message>{SECRET}</Message></Error>")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let backend = S3ObjectStore::new_with_resolver(
            config(server.uri()),
            credentials(true),
            Arc::new(MapResolver::default()),
            Duration::from_secs(2),
        )
        .unwrap();

        let forbidden = backend
            .head(
                &ObjectKey::parse("ws/forbidden.txt").unwrap(),
                &ObjectOperation::default(),
            )
            .await
            .unwrap_err();
        let missing = backend
            .head(
                &ObjectKey::parse("ws/missing.txt").unwrap(),
                &ObjectOperation::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(forbidden, ObjectStoreError::Authorization);
        assert_eq!(missing, ObjectStoreError::NotFound);
        for diagnostic in [
            format!("{forbidden:?} {forbidden}"),
            format!("{missing:?} {missing}"),
        ] {
            for secret in [ACCESS, SECRET, TOKEN] {
                assert!(!diagnostic.contains(secret), "{diagnostic}");
            }
        }
    }
}
