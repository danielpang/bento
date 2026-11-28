//! One app per data folder. A second server on the same folder stops the first one's Postgres
//! as a leftover and takes it over, so a second launch (a binary started twice, `open -n`)
//! brings the first window forward instead and exits. macOS sends a plain second `open` of the
//! bundle to the running app on its own; this covers the launches it does not.
//!
//! The first process holds an exclusive lock on `<data>/mac-app/instance.lock` for as long as it
//! runs and listens on a socket; a later one finds the lock taken and asks over the socket.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a launch waits for a first process that holds the lock but does not answer, which
/// is one that is quitting (its server can take twenty seconds to stop) or just starting.
const WAIT_FOR_FIRST: Duration = Duration::from_secs(30);

pub struct Instance {
    _lock: Option<File>,
    listener: Option<UnixListener>,
}

pub enum Claim {
    First(Instance),
    /// Another process has this data folder and was asked to come forward.
    Running,
    /// Another process holds it and never answered.
    Stuck,
}

pub fn claim(data_dir: &Path) -> Claim {
    let dir = data_dir.join("mac-app");
    let _ = std::fs::create_dir_all(&dir);
    let Ok(lock) = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("instance.lock")) else {
        // A folder this process cannot write fails the server's own start, which says why.
        return Claim::First(Instance { _lock: None, listener: None });
    };
    let socket = socket_path(data_dir, lock.metadata().map(|m| m.uid()).unwrap_or(0));
    let deadline = Instant::now() + WAIT_FOR_FIRST;
    loop {
        if lock.try_lock().is_ok() {
            let listener = socket.as_deref().and_then(|p| {
                let _ = std::fs::remove_file(p);
                UnixListener::bind(p).ok()
            });
            return Claim::First(Instance { _lock: Some(lock), listener });
        }
        if socket.as_deref().is_some_and(ask_to_open) {
            return Claim::Running;
        }
        if Instant::now() >= deadline {
            return Claim::Stuck;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

impl Instance {
    /// Calls `open` on a thread of its own each time a later launch asks.
    pub fn listen(&mut self, open: impl Fn() + Send + 'static) {
        let Some(listener) = self.listener.take() else { return };
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut line = String::new();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                if BufReader::new(&stream).read_line(&mut line).is_ok() && line.trim() == "open" {
                    open();
                    let _ = (&stream).write_all(b"ok\n");
                }
            }
        });
    }
}

fn ask_to_open(socket: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream.write_all(b"open\n").is_err() {
        return false;
    }
    let mut answer = String::new();
    BufReader::new(&stream).read_line(&mut answer).is_ok() && answer.trim() == "ok"
}

/// A socket path must fit in 104 bytes, which a data folder often does not, so the socket lives
/// in a folder of this user's under `/tmp`, named by a hash of the data folder. None when that
/// folder belongs to someone else or others can reach it: the lock alone still holds.
fn socket_path(data_dir: &Path, uid: u32) -> Option<PathBuf> {
    let dir = PathBuf::from(format!("/tmp/bento-mac-{uid}"));
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return None;
    }
    let canonical = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_owned());
    Some(dir.join(format!("{:016x}.sock", fnv1a(canonical.as_os_str().as_encoded_bytes()))))
}

/// Stable across builds, unlike `DefaultHasher`, so a dev build and the bundle find each other.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bento-instance-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_second_claim_asks_the_first_to_open() {
        let dir = scratch("second");
        let Claim::First(mut first) = claim(&dir) else { panic!("first claim") };
        let (tx, rx) = std::sync::mpsc::channel();
        first.listen(move || tx.send(()).unwrap());
        assert!(matches!(claim(&dir), Claim::Running));
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(first);
        assert!(matches!(claim(&dir), Claim::First(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn socket_names_are_short_and_per_folder() {
        let dir = scratch("short");
        let uid = std::fs::metadata(&dir).unwrap().uid();
        let long = dir.join("a-very-long-folder-name-that-goes-on-and-on-and-on-and-on/and/on/and/on/.data");
        assert!(socket_path(&long, uid).unwrap().as_os_str().len() < 104);
        assert_ne!(fnv1a(b"/a"), fnv1a(b"/b"));
    }
}
