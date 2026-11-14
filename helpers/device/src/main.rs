//! `lazurio-device`: the Device helper of Lazurio App, started by the app's main process.

use std::io::{self, BufReader};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    match lazurio_device::serve(&mut input, &mut output, env!("CARGO_PKG_VERSION")) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lazurio-device: helper stopped: {error}");
            ExitCode::FAILURE
        }
    }
}
