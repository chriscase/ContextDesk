use cd_core::help::HelpIndex;
use std::path::{Path, PathBuf};

const PAGE_ID: &str = "context-selection-model-boundary";
const ASSET_PATHS: [&str; 3] = [
    "assets/context-answer-operation.svg",
    "assets/ordinary-linked-context.svg",
    "assets/retrieval-caps-model-boundary.svg",
];

fn checked_in_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("help")
}

#[test]
fn system_operation_help_covers_model_boundaries_with_accessible_assets() {
    let index = HelpIndex::load(checked_in_root()).unwrap();
    let page = index.page(PAGE_ID).unwrap();

    assert_eq!(page.assets.len(), ASSET_PATHS.len());
    for path in ASSET_PATHS {
        let asset = page
            .assets
            .iter()
            .find(|asset| asset.path == path)
            .unwrap_or_else(|| panic!("missing declared Help asset {path}"));
        assert!(
            !asset.alt.trim().is_empty(),
            "{path} needs alternative text"
        );

        let (mime, bytes) = index.asset(PAGE_ID, path).unwrap();
        assert_eq!(mime, "image/svg+xml");
        let svg = String::from_utf8(bytes).unwrap();
        assert!(svg.contains("role=\"img\""), "{path} needs an image role");
        assert!(
            svg.contains("aria-labelledby="),
            "{path} needs an accessible name and description"
        );
        assert!(svg.contains("<title"), "{path} needs an SVG title");
        assert!(svg.contains("<desc"), "{path} needs an SVG description");
    }

    for literal in [
        "## Ordinary chat and linked Log Explorer chat",
        "## How each source can participate",
        "Workspace and Markdown",
        "SQLite or Postgres",
        "HTTP, Confluence, web, X, or MCP",
        "## Selection, capping, and context fitting",
        "## What the selected model can receive",
        "## Provenance and failure honesty",
        "evaluator truth or hidden expected conclusions",
    ] {
        assert!(
            page.body.contains(literal),
            "system-operation Help is missing {literal:?}"
        );
    }
}

#[test]
fn system_operation_help_is_discoverable_by_boundary_questions() {
    let index = HelpIndex::load(checked_in_root()).unwrap();
    for query in [
        "ordinary linked chat context",
        "what is sent to models",
        "deterministic retrieval caps",
        "database skills markdown connectors",
        "provenance failure honesty",
    ] {
        let hits = index.search_keyword(query, 5);
        assert!(
            hits.iter().any(|hit| hit.page_id == PAGE_ID),
            "query={query:?} hits={hits:?}"
        );
    }
}
