//! The Device helper of Lazurio App. The app's main process starts it and speaks the helper
//! protocol of `proto/lazurio/app/helper/v1` with it over standard input and output, and the
//! Device's work of `proto/lazurio/app/device/v1` (ADR 0006). The engine that operates the
//! computer's applications (`Lazurio/agent-desktop`) joins in a later step.

use std::io::{self, Read, Write};

use prost::Message;
use zeroize::Zeroizing;

/// The code generated from `proto/`, in modules that follow its packages.
#[allow(clippy::all, clippy::pedantic)]
pub mod lazurio {
    pub mod app {
        pub mod device {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/lazurio.app.device.v1.rs"));
            }
        }
        pub mod helper {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/lazurio.app.helper.v1.rs"));
            }
        }
        pub mod tailnet {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/lazurio.app.tailnet.v1.rs"));
            }
        }
    }
}

pub mod device;
pub mod history;
pub mod lock;
pub mod secret_start;

use lazurio::app::helper::v1::{
    AppMessage, Failure, Hello, HelperMessage, Pong, app_message, helper_message,
};

/// The version of the helper protocol this helper speaks.
pub const PROTOCOL_VERSION: u32 = 1;

/// The name this helper gives in its Hello.
pub const HELPER_NAME: &str = "lazurio-device";

/// The largest frame the helper accepts, so a broken length cannot exhaust its memory.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Speaks the helper protocol: sends Hello first, then answers each `AppMessage` until Shutdown
/// or the end of the input. Each message is framed by its length as a varint.
///
/// # Errors
///
/// Fails when the input or output fails, or when the input holds a frame that is not an
/// `AppMessage`.
pub fn serve<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    helper_version: &str,
) -> io::Result<()> {
    send(
        output,
        &HelperMessage {
            request_id: 0,
            kind: Some(helper_message::Kind::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                helper_name: HELPER_NAME.to_owned(),
                helper_version: helper_version.to_owned(),
            })),
        },
    )?;

    let mut device = device::Device::default();
    while let Some(frame) = read_frame(input)? {
        // The frame is wiped when it goes out of scope. StartChannel, the one request with
        // secrets, never goes through prost (`secret_start`).
        let request_id;
        let kind = match secret_start::scan(&frame)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.0))?
        {
            secret_start::Scanned::Start {
                request_id: id,
                request,
            } => {
                request_id = id;
                device.start_channel(&request)
            }
            secret_start::Scanned::Refused {
                request_id: id,
                reason,
            } => {
                request_id = id;
                helper_message::Kind::Failure(Failure {
                    code: "invalid_request".to_owned(),
                    message: reason.to_owned(),
                })
            }
            secret_start::Scanned::Other => {
                let message = AppMessage::decode(frame.as_slice())
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                request_id = message.request_id;
                match message.kind {
                    Some(app_message::Kind::Ping(ping)) => {
                        helper_message::Kind::Pong(Pong { nonce: ping.nonce })
                    }
                    Some(app_message::Kind::Shutdown(_)) => return Ok(()),
                    // This helper serves no other helper's work, such as the tailnet's.
                    Some(kind) => device.answer(&kind).unwrap_or_else(unknown_request),
                    None => unknown_request(),
                }
            }
        };
        send(
            output,
            &HelperMessage {
                request_id,
                kind: Some(kind),
            },
        )?;
    }
    Ok(())
}
fn unknown_request() -> helper_message::Kind {
    helper_message::Kind::Failure(Failure {
        code: "unknown_request".to_owned(),
        message: "the helper does not serve this kind of request".to_owned(),
    })
}

fn send<W: Write>(output: &mut W, message: &HelperMessage) -> io::Result<()> {
    output.write_all(&message.encode_length_delimited_to_vec())?;
    output.flush()
}

/// Reads one frame, or `None` when the input ends between frames.
fn read_frame<R: Read>(input: &mut R) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
    let mut length: u64 = 0;
    let mut shift = 0_u32;
    loop {
        let Some(byte) = read_byte(input)? else {
            if shift == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the input ended inside a frame's length",
            ));
        };
        length |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a frame's length is longer than a varint",
            ));
        }
    }
    let length = usize::try_from(length)
        .ok()
        .filter(|length| *length <= MAX_FRAME_BYTES)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "a frame is larger than the helper accepts",
            )
        })?;
    let mut frame = Zeroizing::new(vec![0; length]);
    input.read_exact(&mut frame)?;
    Ok(Some(frame))
}

fn read_byte<R: Read>(input: &mut R) -> io::Result<Option<u8>> {
    let mut byte = [0_u8; 1];
    loop {
        match input.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => return Ok(Some(byte[0])),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::lazurio::app::helper::v1::{Ping, Shutdown};
    use super::lazurio::app::tailnet::v1::StartNode;
    use super::*;

    fn frames(messages: &[AppMessage]) -> Vec<u8> {
        messages
            .iter()
            .flat_map(Message::encode_length_delimited_to_vec)
            .collect()
    }

    fn replies(mut bytes: &[u8]) -> Vec<HelperMessage> {
        let mut replies = Vec::new();
        while !bytes.is_empty() {
            replies
                .push(HelperMessage::decode_length_delimited(&mut bytes).expect("a reply decodes"));
        }
        replies
    }

    #[test]
    fn answers_in_order_and_stops_on_shutdown() {
        let input = frames(&[
            AppMessage {
                request_id: 7,
                kind: Some(app_message::Kind::Ping(Ping {
                    nonce: vec![1, 2, 3],
                })),
            },
            AppMessage {
                request_id: 8,
                kind: Some(app_message::Kind::StartNode(StartNode::default())),
            },
            AppMessage {
                request_id: 9,
                kind: Some(app_message::Kind::Shutdown(Shutdown {})),
            },
            AppMessage {
                request_id: 10,
                kind: Some(app_message::Kind::Ping(Ping { nonce: vec![] })),
            },
        ]);
        let mut output = Vec::new();

        serve(&mut input.as_slice(), &mut output, "1.2.3").expect("serve ends cleanly");

        let replies = replies(&output);
        assert_eq!(
            replies.len(),
            3,
            "Hello, Pong and Failure, nothing after Shutdown"
        );
        assert_eq!(
            replies[0].kind,
            Some(helper_message::Kind::Hello(Hello {
                protocol_version: 1,
                helper_name: "lazurio-device".to_owned(),
                helper_version: "1.2.3".to_owned(),
            }))
        );
        assert_eq!(replies[1].request_id, 7);
        assert_eq!(
            replies[1].kind,
            Some(helper_message::Kind::Pong(Pong {
                nonce: vec![1, 2, 3]
            }))
        );
        assert_eq!(replies[2].request_id, 8);
        assert!(
            matches!(replies[2].kind, Some(helper_message::Kind::Failure(ref failure)) if failure.code == "unknown_request")
        );
    }

    #[test]
    fn serves_the_devices_work_through_the_envelope() {
        use super::lazurio::app::device::v1::{ConfigureDevice, DeviceReady};
        let input = frames(&[AppMessage {
            request_id: 11,
            kind: Some(app_message::Kind::ConfigureDevice(ConfigureDevice {
                data_directory: std::env::temp_dir()
                    .join("lazurio-device")
                    .to_string_lossy()
                    .into_owned(),
                computer_name: "Work laptop".to_owned(),
            })),
        }]);
        let mut output = Vec::new();

        serve(&mut input.as_slice(), &mut output, "1.2.3").expect("serve ends cleanly");

        let replies = replies(&output);
        assert_eq!(replies[1].request_id, 11);
        assert_eq!(
            replies[1].kind,
            Some(helper_message::Kind::DeviceReady(DeviceReady {
                contract_version: 1
            }))
        );
    }

    #[test]
    fn a_refused_start_channel_is_still_answered_and_its_key_never_echoed() {
        use super::lazurio::app::device::v1::{ConfigureDevice, StartChannel};
        let input = frames(&[
            AppMessage {
                request_id: 1,
                kind: Some(app_message::Kind::ConfigureDevice(ConfigureDevice {
                    data_directory: std::env::temp_dir().to_string_lossy().into_owned(),
                    computer_name: "Work laptop".to_owned(),
                })),
            },
            AppMessage {
                request_id: 2,
                kind: Some(app_message::Kind::StartChannel(StartChannel {
                    environment_id: "env-a".to_owned(),
                    attach_url: "wss://launchpad.example.lazurio.io/.lazurio/computers/attach"
                        .to_owned(),
                    device_id: "work-laptop".to_owned(),
                    key_seed: vec![0xA5; 32],
                    ..StartChannel::default()
                })),
            },
        ]);
        let mut output = Vec::new();

        serve(&mut input.as_slice(), &mut output, "1.2.3").expect("serve ends cleanly");

        assert!(
            !output.windows(32).any(|window| window == [0xA5; 32]),
            "no reply carries the key"
        );
        let replies = replies(&output);
        assert!(
            matches!(replies[2].kind, Some(helper_message::Kind::Failure(ref failure)) if failure.code == "not_implemented")
        );
    }

    #[test]
    fn ends_quietly_when_the_app_closes_its_input() {
        let mut output = Vec::new();
        serve(&mut [].as_slice(), &mut output, "1.2.3").expect("serve ends cleanly");
        assert_eq!(replies(&output).len(), 1, "only Hello");
    }

    #[test]
    fn refuses_a_frame_larger_than_it_accepts() {
        let mut input = Vec::new();
        prost::encoding::encode_varint(
            u64::try_from(MAX_FRAME_BYTES + 1).expect("fits"),
            &mut input,
        );
        let error = serve(&mut input.as_slice(), &mut Vec::new(), "1.2.3").expect_err("too large");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
