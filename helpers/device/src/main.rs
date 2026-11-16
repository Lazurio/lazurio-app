//! `lazurio-device`: the Device helper of Lazurio App, started by the app's main process.

use std::fs::File;
use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut output = io::stdout().lock();
    let result = unbuffered_stdin().and_then(|mut input| {
        lazurio_device::serve(
            &mut input,
            &mut output,
            option_env!("LAZURIO_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
        )
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lazurio-device: helper stopped: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Standard input without the standard library's buffer, which would keep a copy of every request,
/// the Device's key among them, where nothing can wipe it. Each frame is read into a buffer that
/// is wiped after use (ADR 0006, point 2).
fn unbuffered_stdin() -> io::Result<File> {
    #[cfg(unix)]
    let handle = {
        use std::os::fd::AsFd;
        io::stdin().as_fd().try_clone_to_owned()?
    };
    #[cfg(windows)]
    let handle = {
        use std::os::windows::io::AsHandle;
        io::stdin().as_handle().try_clone_to_owned()?
    };
    Ok(File::from(handle))
}
