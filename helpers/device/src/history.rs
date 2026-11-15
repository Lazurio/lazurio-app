//! The history of what happened on this computer, without any content (ADR 0006 point 5).
//!
//! Each entry names when, which Environment, what kind of event and, for a tool call, the tool's
//! name. Never arguments, screen contents, text or passwords. Entries are `HistoryEntry` messages
//! of the helper protocol, size-delimited, in `history.pb` in the data directory the main process
//! gave. When the file passes [`MAX_BYTES`] it becomes `history.1.pb`, replacing the older one, so
//! the history keeps between one and two files' worth of entries.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

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
        }
    }

    /// Records one event. `tool` is only for kind [`kind::TOOL`], and only the tool's name.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be written.
    pub fn record(
        &self,
        at_unix_ms: u64,
        environment_id: &str,
        kind: &'static str,
        tool: Option<&str>,
    ) -> io::Result<()> {
        let entry = HistoryEntry {
            at_unix_ms,
            environment_id: environment_id.to_owned(),
            kind: kind.to_owned(),
            tool: tool.unwrap_or_default().to_owned(),
        };
        if let Some(directory) = self.current.parent() {
            std::fs::create_dir_all(directory)?;
        }
        if std::fs::metadata(&self.current).is_ok_and(|metadata| metadata.len() >= self.max_bytes) {
            std::fs::rename(&self.current, &self.previous)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.current)?;
        file.write_all(&entry.encode_length_delimited_to_vec())
    }

    /// A page of the history, the newest first. `page_token` is the token of the previous page,
    /// empty for the first. A broken or cut-off tail of a file is skipped, never fatal.
    #[must_use]
    pub fn page(&self, page_token: &str, limit: u32) -> HistoryPage {
        let offset = page_token.parse::<usize>().unwrap_or(0);
        let limit = usize::try_from(limit)
            .unwrap_or(MAX_PAGE)
            .clamp(1, MAX_PAGE);
        let mut entries = read_entries(&self.previous);
        entries.extend(read_entries(&self.current));
        entries.reverse();
        let next = offset.saturating_add(limit);
        HistoryPage {
            next_page_token: if next < entries.len() {
                next.to_string()
            } else {
                String::new()
            },
            entries: entries.into_iter().skip(offset).take(limit).collect(),
        }
    }
}

fn read_entries(path: &Path) -> Vec<HistoryEntry> {
    let mut bytes = Vec::new();
    if File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .is_err()
    {
        return Vec::new();
    }
    let mut remaining = bytes.as_slice();
    let mut entries = Vec::new();
    while !remaining.is_empty() {
        match HistoryEntry::decode_length_delimited(&mut remaining) {
            Ok(entry) => entries.push(entry),
            Err(_) => break,
        }
    }
    entries
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir()
            .join("lazurio-device-tests")
            .join(format!("history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        directory
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
        assert_eq!(
            first
                .entries
                .iter()
                .map(|e| e.at_unix_ms)
                .collect::<Vec<_>>(),
            [4, 3]
        );
        assert_eq!(first.next_page_token, "2");
        let last = history.page("4", 2);
        assert_eq!(last.entries.len(), 1);
        assert_eq!(last.next_page_token, "");
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
            }
        );
        assert_eq!(page.entries[0].tool, "");
    }

    #[test]
    fn rotates_and_keeps_the_previous_file() {
        let directory = scratch("rotate");
        let history = History::with_max_bytes(&directory, 64);
        for index in 0..20 {
            history
                .record(index, "env-a", kind::CONNECTED, None)
                .expect("recorded");
        }
        assert!(directory.join("history.1.pb").exists());
        let page = history.page("", 200);
        assert_eq!(page.entries[0].at_unix_ms, 19, "the newest is first");
        assert!(page.entries.len() < 20, "older files are dropped");
    }

    #[test]
    fn a_cut_off_tail_is_skipped() {
        let directory = scratch("tail");
        let history = History::new(&directory);
        history
            .record(1, "env-a", kind::CONNECTED, None)
            .expect("recorded");
        let mut file = OpenOptions::new()
            .append(true)
            .open(directory.join("history.pb"))
            .expect("open");
        file.write_all(&[0x40, 0x01]).expect("a broken tail");
        let page = history.page("", 10);
        assert_eq!(page.entries.len(), 1);
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
