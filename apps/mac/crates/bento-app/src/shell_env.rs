//! The PATH the local server runs with. Opened from Finder or the Dock, an app inherits
//! launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, which finds neither `node`, Homebrew's tools, nor
//! the agent CLIs, so it is read from the person's login shell once, as a terminal would have it,
//! and the usual install folders are added after it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MARK: &str = "__BENTO_PATH__";
/// A shell whose startup files hang must not hold the server back for long.
const SHELL_LIMIT: Duration = Duration::from_secs(5);

/// Starts reading the login shell's PATH on a thread, so it is ready when the server starts.
pub fn warm() {
    std::thread::spawn(|| {
        path();
    });
}

/// The PATH to start the server with. Blocks the first time until the login shell answered.
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = home();
        let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
        let from_shell = home.as_deref().and_then(|h| login_shell_path(&shell, h));
        merge(from_shell.as_deref(), std::env::var("PATH").ok().as_deref(), home.as_deref(), |p| p.is_dir())
    })
}

/// HOME, or the account's home folder when the app was started without one (`env -i`).
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).or_else(std::env::home_dir)
}

fn login_shell_path(shell: &str, home: &Path) -> Option<String> {
    let script = format!("printf '%s' \"{MARK}${{PATH}}{MARK}\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .env("HOME", home)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + SHELL_LIMIT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    marked(&reader.join().ok()?)
}

/// The PATH between the marks, which startup files that print their own lines cannot fake.
fn marked(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    Some(out[start..start + len].to_owned()).filter(|p| !p.trim().is_empty())
}

/// The login shell's PATH, then the inherited one, then the usual install folders that exist.
pub fn merge(shell: Option<&str>, inherited: Option<&str>, home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> String {
    let user = ["/.local/bin", "/.bun/bin", "/.volta/bin", "/.cargo/bin", "/.npm-global/bin"];
    let usual = home
        .into_iter()
        .flat_map(|h| user.iter().map(move |d| format!("{}{d}", h.display())))
        .chain(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"].map(String::from))
        .filter(|d| exists(Path::new(d)));
    let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from);
    let mut out: Vec<String> = Vec::new();
    let given = shell.into_iter().chain(inherited).flat_map(|p| p.split(':')).map(str::to_owned);
    for dir in given.chain(usual).chain(system) {
        if !dir.is_empty() && !out.contains(&dir) {
            out.push(dir);
        }
    }
    out.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_between_the_marks() {
        assert_eq!(marked("welcome!\n__BENTO_PATH__/a:/b__BENTO_PATH__"), Some("/a:/b".into()));
        assert_eq!(marked("no marks"), None);
        assert_eq!(marked("__BENTO_PATH____BENTO_PATH__"), None);
    }

    #[test]
    fn shell_first_then_inherited_then_what_exists() {
        let home = Path::new("/Users/me");
        let exists = |p: &Path| p == Path::new("/Users/me/.local/bin") || p == Path::new("/opt/homebrew/bin");
        let path = merge(Some("/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin"), Some("/usr/bin:/bin"), Some(home), exists);
        assert_eq!(path, "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/me/.local/bin:/usr/sbin:/sbin");
        assert_eq!(merge(None, None, None, |_| false), "/usr/bin:/bin:/usr/sbin:/sbin");
    }

    #[test]
    fn a_real_login_shell_answers() {
        let home = home().unwrap();
        let path = login_shell_path("/bin/sh", &home).unwrap();
        assert!(path.split(':').any(|d| d == "/usr/bin"), "{path}");
    }
}
