//! `StartChannel` is the one request that carries secrets: the Device's key seed and the tailnet
//! proxy's credentials. prost decodes a oneof variant into a temporary and drops replaced or
//! half-decoded values without wiping them, so this request never goes through prost. This module
//! reads it straight from the frame into types that wipe themselves when dropped, on every path:
//! a malformed field, a repeated secret, a second variant of the envelope's oneof, or success
//! (ADR 0006, point 2).
//!
//! Only the envelope's top level is scanned here, to find `start_channel` (field 21). A frame
//! without it is decoded by prost as before, and a frame with it is never handed to prost.

use zeroize::Zeroizing;

/// The envelope's `start_channel` field (`lazurio.app.helper.v1.AppMessage`).
const START_CHANNEL_FIELD: u32 = 21;

/// The envelope's `request_id` field. A frame with `start_channel` carries nothing else, so no
/// other variant of the oneof can replace it.
const REQUEST_ID_FIELD: u32 = 1;

/// A `StartChannel` whose secrets wipe themselves. Its `Debug` names the secrets' presence and
/// never their bytes, so no log or panic message can carry them.
#[derive(Default)]
pub struct StartRequest {
    pub environment_id: String,
    pub environment_label: String,
    pub attach_url: String,
    pub device_id: String,
    pub key_seed: Zeroizing<Vec<u8>>,
    pub proxy: Option<ProxyRequest>,
}

/// The tailnet proxy of a `StartChannel`, whose credentials wipe themselves. Its `Debug` hides
/// the credentials.
#[derive(Default)]
pub struct ProxyRequest {
    pub host: String,
    pub port: u32,
    pub username: Zeroizing<String>,
    pub password: Zeroizing<String>,
}

impl std::fmt::Debug for StartRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartRequest")
            .field("environment_id", &self.environment_id)
            .field("environment_label", &self.environment_label)
            .field("attach_url", &self.attach_url)
            .field("device_id", &self.device_id)
            .field("key_seed", &format_args!("<{} bytes>", self.key_seed.len()))
            .field("proxy", &self.proxy)
            .finish()
    }
}

impl std::fmt::Debug for ProxyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &"<hidden>")
            .field("password", &"<hidden>")
            .finish()
    }
}

/// What the scan of a frame found.
#[derive(Debug)]
pub enum Scanned {
    /// No `start_channel`: prost may decode the frame.
    Other,
    /// A `start_channel`, with the envelope's request id.
    Start {
        request_id: u64,
        request: StartRequest,
    },
    /// A `start_channel` that is refused before anything else happens, with the reason for the
    /// log: a repeated secret, a second variant, or a field of the wrong type.
    Refused {
        request_id: u64,
        reason: &'static str,
    },
}

/// A frame that is not protobuf at all.
#[derive(Debug, PartialEq, Eq)]
pub struct Malformed(pub &'static str);

/// Scans the envelope's top level and, when it holds `start_channel`, reads it.
///
/// # Errors
///
/// Fails when the frame is not valid protobuf wire format.
pub fn scan(frame: &[u8]) -> Result<Scanned, Malformed> {
    let mut reader = Reader::new(frame);
    let mut request_id = 0;
    let mut others = 0_u32;
    let mut start: Option<&[u8]> = None;
    let mut starts = 0_u32;
    while let Some((field, wire)) = reader.tag()? {
        match (field, wire) {
            (REQUEST_ID_FIELD, Wire::Varint) => request_id = reader.varint()?,
            (START_CHANNEL_FIELD, Wire::Len) => {
                starts += 1;
                start = Some(reader.bytes()?);
            }
            (START_CHANNEL_FIELD, _) => {
                reader.skip(wire)?;
                starts += 1;
            }
            (_, wire) => {
                others += 1;
                reader.skip(wire)?;
            }
        }
    }
    if starts == 0 {
        return Ok(Scanned::Other);
    }
    // Read the request even when it is refused, so a secret it holds lands in a type that wipes.
    let parsed = start.map(read_start).transpose()?;
    if starts > 1 || others > 0 {
        return Ok(Scanned::Refused {
            request_id,
            reason: "a frame with start_channel carries only request_id and start_channel, once",
        });
    }
    match parsed {
        Some(Ok(request)) => Ok(Scanned::Start {
            request_id,
            request,
        }),
        Some(Err(reason)) => Ok(Scanned::Refused { request_id, reason }),
        None => Ok(Scanned::Refused {
            request_id,
            reason: "start_channel has the wrong wire type",
        }),
    }
}

/// Reads a `StartChannel` message. A repeated secret field or a field of the wrong type is a
/// refusal; the partly read request is dropped, and its secrets with it, wiped.
fn read_start(bytes: &[u8]) -> Result<Result<StartRequest, &'static str>, Malformed> {
    let mut reader = Reader::new(bytes);
    let mut request = StartRequest::default();
    let mut refusal = None;
    let mut seeds = 0_u32;
    let mut proxies = 0_u32;
    while let Some((field, wire)) = reader.tag()? {
        match (field, wire) {
            (1, Wire::Len) => request.environment_id = string(reader.bytes()?)?,
            (2, Wire::Len) => request.environment_label = string(reader.bytes()?)?,
            (3, Wire::Len) => request.attach_url = string(reader.bytes()?)?,
            (4, Wire::Len) => request.device_id = string(reader.bytes()?)?,
            (5, Wire::Len) => {
                seeds += 1;
                // Replacing the seed wipes the previous one: the old value is a Zeroizing.
                request.key_seed = Zeroizing::new(reader.bytes()?.to_vec());
            }
            (6, Wire::Len) => {
                proxies += 1;
                let proxy = read_proxy(reader.bytes()?)?;
                match proxy {
                    Ok(proxy) => request.proxy = Some(proxy),
                    Err(reason) => refusal = Some(reason),
                }
            }
            (1..=6, _) => {
                reader.skip(wire)?;
                refusal = Some("a field of start_channel has the wrong wire type");
            }
            (_, wire) => reader.skip(wire)?,
        }
    }
    if seeds > 1 {
        refusal = Some("start_channel repeats key_seed");
    }
    if proxies > 1 {
        refusal = Some("start_channel repeats proxy");
    }
    Ok(refusal.map_or(Ok(request), Err))
}

fn read_proxy(bytes: &[u8]) -> Result<Result<ProxyRequest, &'static str>, Malformed> {
    let mut reader = Reader::new(bytes);
    let mut proxy = ProxyRequest::default();
    let mut refusal = None;
    let mut usernames = 0_u32;
    let mut passwords = 0_u32;
    while let Some((field, wire)) = reader.tag()? {
        match (field, wire) {
            (1, Wire::Len) => proxy.host = string(reader.bytes()?)?,
            (2, Wire::Varint) => {
                proxy.port = u32::try_from(reader.varint()?)
                    .map_err(|_| Malformed("the proxy's port does not fit 32 bits"))?;
            }
            (3, Wire::Len) => {
                usernames += 1;
                proxy.username = Zeroizing::new(string(reader.bytes()?)?);
            }
            (4, Wire::Len) => {
                passwords += 1;
                proxy.password = Zeroizing::new(string(reader.bytes()?)?);
            }
            (1..=4, _) => {
                reader.skip(wire)?;
                refusal = Some("a field of the proxy has the wrong wire type");
            }
            (_, wire) => reader.skip(wire)?,
        }
    }
    if usernames > 1 || passwords > 1 {
        refusal = Some("the proxy repeats its credentials");
    }
    Ok(refusal.map_or(Ok(proxy), Err))
}

fn string(bytes: &[u8]) -> Result<String, Malformed> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| Malformed("a string is not UTF-8"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wire {
    Varint,
    Fixed64,
    Len,
    Fixed32,
}

/// Protobuf's wire format, read without copying.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn tag(&mut self) -> Result<Option<(u32, Wire)>, Malformed> {
        if self.bytes.is_empty() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let field =
            u32::try_from(tag >> 3).map_err(|_| Malformed("a field number is too large"))?;
        if field == 0 {
            return Err(Malformed("field number 0"));
        }
        let wire = match tag & 7 {
            0 => Wire::Varint,
            1 => Wire::Fixed64,
            2 => Wire::Len,
            5 => Wire::Fixed32,
            _ => return Err(Malformed("a wire type the protocol does not use")),
        };
        Ok(Some((field, wire)))
    }

    fn varint(&mut self) -> Result<u64, Malformed> {
        let mut value = 0_u64;
        for (index, byte) in self.bytes.iter().enumerate().take(10) {
            value |= u64::from(byte & 0x7f) << (7 * index);
            if byte & 0x80 == 0 {
                self.bytes = &self.bytes[index + 1..];
                return Ok(value);
            }
        }
        Err(Malformed("a varint is cut off or too long"))
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], Malformed> {
        if length > self.bytes.len() {
            return Err(Malformed("a field is cut off"));
        }
        let (taken, rest) = self.bytes.split_at(length);
        self.bytes = rest;
        Ok(taken)
    }

    fn bytes(&mut self) -> Result<&'a [u8], Malformed> {
        let length =
            usize::try_from(self.varint()?).map_err(|_| Malformed("a length is too large"))?;
        self.take(length)
    }

    fn skip(&mut self, wire: Wire) -> Result<(), Malformed> {
        match wire {
            Wire::Varint => self.varint().map(|_| ()),
            Wire::Fixed64 => self.take(8).map(|_| ()),
            Wire::Len => self.bytes().map(|_| ()),
            Wire::Fixed32 => self.take(4).map(|_| ()),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::lazurio::app::device::v1::{StartChannel, TailnetProxy};
    use crate::lazurio::app::helper::v1::{AppMessage, Ping, app_message};
    use prost::Message;

    fn start_message() -> AppMessage {
        AppMessage {
            request_id: 9,
            kind: Some(app_message::Kind::StartChannel(StartChannel {
                environment_id: "env-a".to_owned(),
                environment_label: "Environment A".to_owned(),
                attach_url: "wss://launchpad.example.lazurio.io/.lazurio/computers/attach"
                    .to_owned(),
                device_id: "work-laptop".to_owned(),
                key_seed: vec![0xA5; 32],
                proxy: Some(TailnetProxy {
                    host: "127.0.0.1".to_owned(),
                    port: 41_000,
                    username: "user".to_owned(),
                    password: "secret".to_owned(),
                }),
            })),
        }
    }

    /// Appends one length-delimited field to a protobuf message.
    fn push_len(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
        prost::encoding::encode_varint(u64::from(field << 3 | 2), buffer);
        prost::encoding::encode_varint(bytes.len() as u64, buffer);
        buffer.extend_from_slice(bytes);
    }

    #[test]
    fn reads_what_prost_encodes() {
        let frame = start_message().encode_to_vec();
        let Ok(Scanned::Start {
            request_id,
            request,
        }) = scan(&frame)
        else {
            panic!("a StartChannel");
        };
        assert_eq!(request_id, 9);
        assert_eq!(request.environment_id, "env-a");
        assert_eq!(request.device_id, "work-laptop");
        assert_eq!(request.key_seed.as_slice(), [0xA5; 32].as_slice());
        let proxy = request.proxy.expect("a proxy");
        assert_eq!((proxy.host.as_str(), proxy.port), ("127.0.0.1", 41_000));
        assert_eq!(
            (proxy.username.as_str(), proxy.password.as_str()),
            ("user", "secret")
        );
    }

    #[test]
    fn leaves_every_other_request_to_prost() {
        let ping = AppMessage {
            request_id: 1,
            kind: Some(app_message::Kind::Ping(Ping { nonce: vec![1] })),
        };
        assert!(matches!(scan(&ping.encode_to_vec()), Ok(Scanned::Other)));
    }

    #[test]
    fn a_start_channel_cut_off_after_its_seed_is_malformed() {
        let frame = start_message().encode_to_vec();
        // Drop the last bytes, inside the proxy, after the seed was read.
        let cut = &frame[..frame.len() - 3];
        assert!(scan(cut).is_err());
    }

    #[test]
    fn a_repeated_seed_is_refused() {
        let mut start = StartChannel {
            environment_id: "env-a".to_owned(),
            key_seed: vec![1; 32],
            ..StartChannel::default()
        }
        .encode_to_vec();
        push_len(&mut start, 5, &[2; 32]);
        let mut frame = Vec::new();
        push_len(&mut frame, START_CHANNEL_FIELD, &start);
        assert!(matches!(
            scan(&frame),
            Ok(Scanned::Refused { reason, .. }) if reason == "start_channel repeats key_seed"
        ));
    }

    #[test]
    fn repeated_proxy_credentials_are_refused() {
        let mut proxy = TailnetProxy {
            host: "127.0.0.1".to_owned(),
            port: 41_000,
            username: "user".to_owned(),
            password: "one".to_owned(),
        }
        .encode_to_vec();
        push_len(&mut proxy, 4, b"two");
        let mut start = StartChannel {
            environment_id: "env-a".to_owned(),
            key_seed: vec![1; 32],
            ..StartChannel::default()
        }
        .encode_to_vec();
        push_len(&mut start, 6, &proxy);
        let mut frame = Vec::new();
        push_len(&mut frame, START_CHANNEL_FIELD, &start);
        assert!(matches!(scan(&frame), Ok(Scanned::Refused { .. })));
    }

    #[test]
    fn another_variant_after_a_start_channel_is_refused() {
        let mut frame = start_message().encode_to_vec();
        // A Ping (field 2) after the StartChannel would make prost replace it.
        frame.extend(
            AppMessage {
                request_id: 0,
                kind: Some(app_message::Kind::Ping(Ping { nonce: vec![] })),
            }
            .encode_to_vec(),
        );
        assert!(matches!(
            scan(&frame),
            Ok(Scanned::Refused { request_id: 9, .. })
        ));
    }

    #[test]
    fn a_second_start_channel_is_refused() {
        let mut frame = start_message().encode_to_vec();
        frame.extend(start_message().encode_to_vec());
        assert!(matches!(scan(&frame), Ok(Scanned::Refused { .. })));
    }

    #[test]
    fn unknown_fields_are_skipped() {
        let mut start = StartChannel {
            environment_id: "env-a".to_owned(),
            key_seed: vec![1; 32],
            ..StartChannel::default()
        }
        .encode_to_vec();
        push_len(&mut start, 99, b"later");
        let mut frame = Vec::new();
        push_len(&mut frame, START_CHANNEL_FIELD, &start);
        let Ok(Scanned::Start { request, .. }) = scan(&frame) else {
            panic!("a StartChannel");
        };
        assert_eq!(request.key_seed.len(), 32);
    }

    #[test]
    fn any_other_top_level_field_next_to_a_start_channel_is_refused() {
        let mut frame = start_message().encode_to_vec();
        prost::encoding::encode_varint(u64::from(98_u32 << 3), &mut frame);
        prost::encoding::encode_varint(5, &mut frame);
        assert!(matches!(scan(&frame), Ok(Scanned::Refused { .. })));
    }

    #[test]
    fn debug_output_never_carries_the_secrets() {
        let Ok(Scanned::Start { request, .. }) = scan(&start_message().encode_to_vec()) else {
            panic!("a StartChannel");
        };
        let shown = format!("{request:?}");
        assert!(shown.contains("<32 bytes>") && shown.contains("<hidden>"));
        assert!(!shown.contains("secret") && !shown.contains("user\""));
        assert!(!shown.contains("165"), "no byte of the seed (0xA5 = 165)");
    }

    #[test]
    fn the_secrets_are_held_in_types_that_wipe_themselves() {
        // The type is the guarantee: every path that drops a request runs Zeroizing's Drop.
        fn wipes<T: zeroize::ZeroizeOnDrop>(_: &T) {}
        let request = StartRequest::default();
        wipes(&request.key_seed);
        let proxy = ProxyRequest::default();
        wipes(&proxy.username);
        wipes(&proxy.password);
    }
}
