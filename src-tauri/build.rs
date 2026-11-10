use std::fs;
use std::path::Path;

const BUILTIN_VARIABLE_NAMES: [&str; 3] =
    ["SCRIBE_API_HOST", "SCRIBE_API_KEY_NOTES", "SCRIBE_API_KEY_TRANSCRIPTION"];

const UPDATER_PLACEHOLDER: &str = "REPLACE_WITH_";

fn main() {
    println!("cargo::rustc-check-cfg=cfg(optimized)");
    println!("cargo::rerun-if-env-changed=OPT_LEVEL");

    let optimization_level = std::env::var("OPT_LEVEL").unwrap_or_default();

    assert_eq!(optimization_level.len(), 1);
    assert!(["0", "1", "2", "3", "s", "z"].contains(&optimization_level.as_str()));

    let optimized = optimization_level != "0";

    if optimized {
        println!("cargo::rustc-cfg=optimized");
    }

    let dotenv_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");

    println!("cargo::rerun-if-changed={}", dotenv_path.display());

    let dotenv = fs::read_to_string(&dotenv_path).unwrap_or_default();
    let dotenv_lines: Vec<&str> = dotenv.lines().collect();

    for name in BUILTIN_VARIABLE_NAMES {
        println!("cargo::rerun-if-env-changed={name}");

        let value = std::env::var(name)
            .ok()
            .or_else(|| dotenv_value(&dotenv_lines, name))
            .unwrap_or_default();

        let value_missing = optimized && value.trim().is_empty();

        if value_missing {
            println!("cargo::warning={name} is not set; this build ships without it built in");
        }

        println!("cargo::rustc-env={}={}", name, value.trim());
    }

    let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");

    println!("cargo::rerun-if-changed={}", config_path.display());

    if optimized {
        let config = fs::read_to_string(&config_path).unwrap_or_default();

        if config.contains(UPDATER_PLACEHOLDER) {
            println!(
                "cargo::warning=tauri.conf.json still holds the updater placeholder; this build \
                 cannot update itself"
            );
        }
    }

    tauri_build::build();
}

fn dotenv_value(lines: &[&str], name: &str) -> Option<String> {
    lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .find(|(key, _value)| key.trim() == name)
        .map(|(_key, value)| value.trim().trim_matches('"').trim_matches('\'').to_owned())
}
