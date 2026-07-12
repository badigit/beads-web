//! Cross-platform helpers for spawning external processes.
//!
//! On Windows a child console process (git, gh, bd, cmd, wmic, ...) opens its
//! own console window whenever the parent has no console — for example when the
//! server runs under pm2 with `windowsHide: true`. Setting the
//! `CREATE_NO_WINDOW` creation flag suppresses that flicker. On other platforms
//! the helpers are plain constructors.
//!
//! [`output_with_timeout`] additionally caps how long a network-bound command
//! may run, so requests that hang on a slow VPN tunnel cannot pile up.

use std::ffi::OsStr;
use std::process::Output;
use std::time::Duration;

/// Windows `CREATE_NO_WINDOW` flag — stops child console processes from opening
/// their own console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Maximum time a network-bound external command may run before it is aborted.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(12);

/// Builds an async [`tokio::process::Command`] that never opens a console window.
pub fn hidden_command<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Builds a blocking [`std::process::Command`] that never opens a console window.
pub fn hidden_std_command<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs a command to completion, aborting it if it exceeds [`NETWORK_TIMEOUT`].
///
/// On timeout it returns an [`std::io::ErrorKind::TimedOut`] error so callers can
/// treat it exactly like any other spawn failure and degrade gracefully.
pub async fn output_with_timeout(cmd: &mut tokio::process::Command) -> std::io::Result<Output> {
    output_within(cmd, NETWORK_TIMEOUT).await
}

/// Runs a command, aborting it if it exceeds `limit`. Backs [`output_with_timeout`]
/// with a caller-supplied duration so the timeout path can be tested quickly.
async fn output_within(
    cmd: &mut tokio::process::Command,
    limit: Duration,
) -> std::io::Result<Output> {
    match tokio::time::timeout(limit, cmd.output()).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "external command timed out",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_command_sets_program() {
        let cmd = hidden_command("git");
        assert_eq!(cmd.as_std().get_program(), OsStr::new("git"));
    }

    #[test]
    fn hidden_std_command_sets_program() {
        let cmd = hidden_std_command("gh");
        assert_eq!(cmd.get_program(), OsStr::new("gh"));
    }

    /// A command that outlives the limit must be aborted with a TimedOut error.
    #[tokio::test]
    async fn output_within_times_out_a_hanging_command() {
        let (program, args): (&str, &[&str]) = if cfg!(windows) {
            ("ping", &["-n", "30", "127.0.0.1"])
        } else {
            ("sleep", &["30"])
        };
        let mut cmd = hidden_command(program);
        cmd.args(args);

        let result = output_within(&mut cmd, Duration::from_millis(200)).await;

        let err = result.expect_err("hanging command must time out");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }
}
