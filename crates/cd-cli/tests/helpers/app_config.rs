//! Plant readable `AppConfig` fixtures without calling production `save_config`.
//!
//! Durable persistence is Unix-only. Tests that need a file `load_config` can
//! read must write pretty JSON themselves. Production `save_config` stays
//! fail-closed off Unix and is exercised by dedicated refusal tests.

use cd_core::config::AppConfig;
use std::path::Path;

pub fn plant_app_config(path: &Path, cfg: &AppConfig) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create AppConfig fixture parent");
    }
    let raw = serde_json::to_string_pretty(cfg).expect("serialize AppConfig fixture");
    std::fs::write(path, raw).expect("plant AppConfig fixture without claiming durable save");
}
