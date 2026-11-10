#![cfg_attr(optimized, windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    scribe_lib::run()
}
