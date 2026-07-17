//! ContextDesk headless server — stub until the server epic lands.
//!
//! This binary exists so packaging and CI have a stable entrypoint.
//! Do not expose network ports until auth and policy are implemented.

use clap::Parser;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "cd-server",
    version,
    about = "ContextDesk headless server (stub)"
)]
struct Args {
    /// Print branding and exit (smoke check).
    #[arg(long)]
    print_branding: bool,
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let args = Args::parse();
    let branding = cd_core::Branding::default();

    if args.print_branding {
        println!(
            "{} ({}) — {}",
            branding.name, branding.slug, branding.tagline
        );
        return;
    }

    tracing::info!(
        product = %branding.name,
        version = cd_core::VERSION,
        "cd-server stub: no listeners bound. See docs/ROADMAP.md and server epic issues."
    );
    eprintln!(
        "{} server is not implemented yet (v{}). Use --print-branding for a smoke check.",
        branding.name,
        cd_core::VERSION
    );
    std::process::exit(2);
}
