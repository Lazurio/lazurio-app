//! The history of what happened on this computer, without any content (ADR 0006 point 5).
//!
//! Each entry names when, which Environment, what kind of event and, for a tool call, the tool's
//! name. Never arguments, screen contents, text or passwords. Entries are `HistoryEntry` messages
//! of the helper protocol, size-delimited, in `history.pb` in the data directory the main process
//! gave. When the file passes [`MAX_BYTES`] it becomes `history.1.pb`, replacing the older one, so
//! the history keeps between one and two files' worth of entries.
//!
//! Every entry carries a sequence, one more than the entry before it. Pages are cut by sequence,
//! so entries recorded between two pages never shift them. Before the first write, a cut-off last
//! entry (a crash in the middle of a write) is cut from the file, so later entries stay readable.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use prost::Message;

use crate::lazurio::app::device::v1::{HistoryEntry, HistoryPage};

/// The size at which the current file is rotated.
pub const MAX_BYTES: u64 = 1024 * 1024;

/// The most entries one page carries.
pub const MAX_PAGE: usize = 200;

/// The kinds of events, a fixed vocabulary.
pub mod kind {
    pub const CONNECTED: &str = "connected";
    pub const DISCONNECTED: &str = "disconnected";
    pub const REFUSED: &str = "refused";
    pub const TOOL: &str = "tool";
    pub const STOPPED: &str = "stopped";
}

/// The history in one data directory.
pub struct History {
    current: PathBuf,
    previous: PathBuf,
    max_bytes: u64,
    /// The sequence of the next entry, once the files were checked; `None` before the first
    /// write and after a failed one, so the next write checks the files again.
    next_sequence: Mutex<Option<u64>>,
}

impl History {
    /// The history kept in `directory`.
    #[must_use]
    pub fn new(directory: &Path) -> Self {
        Self::with_max_bytes(directory, MAX_BYTES)
    }

    fn with_max_bytes(directory: &Path, max_bytes: u64) -> Self {
        Self {
            current: directory.join("history.pb"),
            previous: directory.join("history.1.pb"),
            max_bytes,
            next_sequence: Mutex::new(None),
        }
    }

    /// Records one event. `tool` is only for kind [`kind::TOOL`], and only the tool's name.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be checked or written.
    pub fn record(
        &self,
        at_unix_ms: u64,
        environment_id: &str,
        kind: &'static str,
        tool: Option<&str>,
    ) -> io::Result<()> {
        let mut next = self
            .next_sequence
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let sequence = match *next {
            Some(sequence) => sequence,
            None => self.prepare()?,
        };
        let entry = HistoryEntry {
            at_unix_ms,
            environment_id: environment_id.to_owned(),
            kind: kind.to_owned(),
            tool: tool.unwrap_or_default().to_owned(),
            sequence,
        };
        // Until this write succeeds, the next one checks the files again.
        *next = None;
        if std::fs::metadata(&self.current).is_ok_and(|metadata| metadata.len() >= self.max_bytes) {
            std::fs::rename(&self.current, &self.previous)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.current)?;
        file.write_all(&entry.encode_length_delimited_to_vec())?;
        *next = Some(sequence + 1);
        Ok(())
    }

    /// Cuts a broken tail from the current file and returns the sequence of the next entry.
    fn prepare(&self) -> io::Result<u64> {
        if let Some(directory) = self.current.parent() {
            std::fs::create_dir_all(directory)?;
        }
        // Any read error but a missing file refuses the write: appending without knowing the
        // file would reuse a sequence or land behind a broken tail.
        let (current, valid_bytes, file_bytes) = read_file(&self.current)?;
        if valid_bytes < file_bytes {
            OpenOptions::new()
                .write(true)
                .open(&self.current)?
                .set_len(valid_bytes)?;
        }
        let (previous, _, _) = read_file(&self.previous)?;
        Ok(previous
            .iter()
            .chain(&current)
            .map(|entry| entry.sequence)
            .max()
            .map_or(1, |last| last + 1))
    }

    /// A page of the history, the newest first: the entries older than `page_token` (a sequence),
    /// or the newest ones for an empty token. A file that cannot be read now adds nothing to the
    /// page; reading changes nothing, so the next page shows it again once it is readable.
    #[must_use]
    pub fn page(&self, page_token: &str, limit: u32) -> HistoryPage {
        let before = page_token.parse::<u64>().ok();
        let limit = usize::try_from(limit)
            .unwrap_or(MAX_PAGE)
            .clamp(1, MAX_PAGE);
        let read = |path: &Path| {
            read_file(path)
                .map(|(entries, _, _)| entries)
                .unwrap_or_default()
        };
        let mut entries = read(&self.previous);
        entries.extend(read(&self.current));
        entries.retain(|entry| before.is_none_or(|before| entry.sequence < before));
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.sequence));
        let more = entries.len() > limit;
        entries.truncate(limit);
        HistoryPage {
            next_page_token: if more {
                entries
                    .last()
                    .map(|entry| entry.sequence.to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            },
            entries,
        }
    }
}

/// The whole entries of a file, how many bytes they take, and the file's size. A broken or
/// cut-off tail ends the reading. A missing file is empty.
///
/// # Errors
///
/// Fails on any other error of opening or reading the file.
fn read_file(path: &Path) -> io::Result<(Vec<HistoryEntry>, u64, u64)> {
    let mut bytes = Vec::new();
    match File::open(path).and_then(|mut file| file.read_to_end(&mut bytes)) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), 0, 0)),
        Err(error) => return Err(error),
    }
    let mut remaining = bytes.as_slice();
    let mut entries = Vec::new();
    let mut valid = 0;
    while !remaining.is_empty() {
        match HistoryEntry::decode_length_delimited(&mut remaining) {
            Ok(entry) => {
                entries.push(entry);
                valid = bytes.len() - remaining.len();
            }
            Err(_) => break,
        }
    }
    let size = |length: usize| u64::try_from(length).unwrap_or(u64::MAX);
    Ok((entries, size(valid), size(bytes.len())))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// A fresh directory for one test; tests run in parallel, so each gets its own.
    fn scratch(name: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let index = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir()
            .join("lazurio-device-tests")
            .join(format!("history-{name}-{}-{index}", std::process::id()))
    }

    fn sequences(page: &HistoryPage) -> Vec<u64> {
        page.entries.iter().map(|entry| entry.sequence).collect()
    }

    #[test]
    fn records_events_and_pages_them_newest_first() {
        let history = History::new(&scratch("pages"));
        for index in 0..5 {
            history
                .record(index, "env-a", kind::TOOL, Some("desktop_click"))
                .expect("recorded");
        }
        let first = history.page("", 2);
        assert_eq!(sequences(&first), [5, 4]);
        assert_eq!(first.next_page_token, "4");
        let second = history.page(&first.next_page_token, 2);
        assert_eq!(sequences(&second), [3, 2]);
        let last = history.page(&second.next_page_token, 2);
        assert_eq!(sequences(&last), [1]);
        assert_eq!(last.next_page_token, "");
    }

    #[test]
    fn an_event_recorded_between_pages_never_shifts_them() {
        let history = History::new(&scratch("stable"));
        for index in 0..4 {
            history
                .record(index, "env-a", kind::CONNECTED, None)
                .expect("recorded");
        }
        let first = history.page("", 2);
        assert_eq!(sequences(&first), [4, 3]);
        history
            .record(9, "env-a", kind::TOOL, Some("desktop_type"))
            .expect("recorded");
        let second = history.page(&first.next_page_token, 2);
        assert_eq!(sequences(&second), [2, 1], "no repeat and no gap");
        assert_eq!(
            sequences(&history.page("", 1)),
            [5],
            "the new entry is newest"
        );
    }

    #[test]
    fn an_entry_holds_only_the_tool_name_and_what_happened() {
        let history = History::new(&scratch("content"));
        history
            .record(1, "env-a", kind::TOOL, Some("desktop_type"))
            .expect("recorded");
        history
            .record(2, "env-a", kind::STOPPED, None)
            .expect("recorded");
        let page = history.page("", 10);
        assert_eq!(
            page.entries[1],
            HistoryEntry {
                at_unix_ms: 1,
                environment_id: "env-a".to_owned(),
                kind: "tool".to_owned(),
                tool: "desktop_type".to_owned(),
                sequence: 1,
            }
        );
        assert_eq!(page.entries[0].tool, "");
    }

    #[test]
    fn rotates_and_keeps_counting() {
        let directory = scratch("rotate");
        let history = History::with_max_bytes(&directory, 64);
        for index in 0..20 {
            history
                .record(index, "env-a", kind::CONNECTED, None)
                .expect("recorded");
        }
        assert!(directory.join("history.1.pb").exists());
        let page = history.page("", 200);
        assert_eq!(page.entries[0].sequence, 20, "the newest is first");
        assert!(page.entries.len() < 20, "older files are dropped");
        // A new History on the same files continues the sequence.
        let again = History::with_max_bytes(&directory, 64);
        again
            .record(99, "env-a", kind::CONNECTED, None)
            .expect("recorded");
        assert_eq!(again.page("", 1).entries[0].sequence, 21);
    }

    #[test]
    fn a_cut_off_tail_is_cut_before_the_next_entry() {
        let directory = scratch("tail");
        History::new(&directory)
            .record(1, "env-a", kind::CONNECTED, None)
            .expect("recorded");
        // A crash in the middle of a write: a length that promises more than follows.
        let mut file = OpenOptions::new()
            .append(true)
            .open(directory.join("history.pb"))
            .expect("open");
        file.write_all(&[0x40, 0x01, 0x02]).expect("a broken tail");
        drop(file);
        let history = History::new(&directory);
        history
            .record(2, "env-a", kind::TOOL, Some("desktop_click"))
            .expect("recorded");
        history
            .record(3, "env-a", kind::STOPPED, None)
            .expect("recorded");
        let page = history.page("", 10);
        assert_eq!(
            sequences(&page),
            [3, 2, 1],
            "the entries after the crash are readable"
        );
    }

    /// A history file that can be written but not read: the write must be refused, so no
    /// sequence is reused and no entry lands behind an unchecked tail.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_refuses_the_write_until_it_can_be_checked() {
        use std::os::unix::fs::PermissionsExt;
        let directory = scratch("unreadable");
        History::new(&directory)
            .record(1, "env-a", kind::CONNECTED, None)
            .expect("recorded");
        let path = directory.join("history.pb");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o200)).expect("chmod");
        if File::open(&path).is_ok() {
            // Running as a user that reads anything (root): the case cannot be built here.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .expect("chmod back");
            return;
        }
        let history = History::new(&directory);
        let refused = history.record(2, "env-a", kind::TOOL, Some("desktop_click"));
        assert_eq!(
            refused.expect_err("the write is refused").kind(),
            io::ErrorKind::PermissionDenied
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod back");
        history
            .record(3, "env-a", kind::STOPPED, None)
            .expect("recorded once readable");
        assert_eq!(
            sequences(&history.page("", 10)),
            [2, 1],
            "the next entry continues the sequence, nothing is hidden"
        );
    }

    #[test]
    fn a_page_is_capped_and_an_unknown_token_starts_over() {
        let history = History::new(&scratch("cap"));
        for index in 0..3 {
            history
                .record(index, "env-a", kind::CONNECTED, None)
                .expect("recorded");
        }
        assert_eq!(history.page("garbage", 0).entries.len(), 1);
        assert_eq!(history.page("", 10_000).entries.len(), 3);
    }
}
