//! The Device helper of Lazurio App. The app's main process starts it and speaks the helper
//! protocol of `proto/lazurio/app/helper/v1` with it over standard input and output, and the
//! Device's work of `proto/lazurio/app/device/v1` (ADR 0006): the attach channel of each
//! Environment (`channel`), the lock of one agent (`lock`) and the history without content
//! (`history`). Each session passes MCP to the engine that operates the computer's applications
//! (`Lazurio/agent-desktop`, `engine`), through the tap that holds the lock around every tool
//! call (`tap`); without the engine, the channel serves no tools (`mcp_stub`). Packaging the
//! engine next to the helper is a later step (ADR 0006 step 4).

use std::io::{self, Read, Write};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

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

pub mod channel;
pub mod device;
pub mod engine;
pub mod history;
pub mod lock;
pub mod mcp_stub;
pub mod secret_start;
pub mod tap;
#[cfg(test)]
mod testkit;
pub mod wire;

use lazurio::app::helper::v1::{
    AppMessage, Failure, Hello, HelperMessage, Pong, app_message, helper_message,
};

/// The version of the helper protocol this helper speaks.
pub const PROTOCOL_VERSION: u32 = 1;

/// The name this helper gives in its Hello.
pub const HELPER_NAME: &str = "lazurio-device";

/// The largest frame the helper accepts, so a broken length cannot exhaust its memory.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// How long the channels get to close at Shutdown or the end of the input, within the two
/// seconds of ADR 0006 point 8.
const CHANNELS_CLOSE_WITHIN: Duration = Duration::from_millis(1500);

/// Speaks the helper protocol: sends Hello first, then answers each `AppMessage` until Shutdown
/// or the end of the input. Each message is framed by its length as a varint. The channels send
/// their changes of state, and who holds the computer when the end of a Stop changes it, on their
/// own, with `request_id` 0, between the answers. Before it
/// returns, every channel is closed.
///
/// # Errors
///
/// Fails when the input or output fails, or when the input holds a frame that is not an
/// `AppMessage`.
pub fn serve<R: Read, W: Write + Send>(
    input: &mut R,
    output: &mut W,
    helper_version: &str,
) -> io::Result<()> {
    serve_with(input, output, helper_version, device::Device::default())
}

/// What goes to the writer of the helper's output.
enum Outgoing {
    Message(HelperMessage),
    /// Nothing more: the writer ends.
    Close,
}

fn serve_with<R: Read, W: Write + Send>(
    input: &mut R,
    output: &mut W,
    helper_version: &str,
    device: device::Device,
) -> io::Result<()> {
    let (outbox, inbox) = mpsc::channel::<Outgoing>();
    // One writer keeps every message whole, whichever thread sends it.
    thread::scope(|scope| {
        let writer = scope.spawn(move || write_messages(output, &inbox));
        let report = {
            let outbox = outbox.clone();
            move |state| {
                // After the writer ended nobody listens; the state is dropped.
                let _ = outbox.send(Outgoing::Message(HelperMessage {
                    request_id: 0,
                    kind: Some(helper_message::Kind::ChannelState(state)),
                }));
            }
        };
        let lock_report = {
            let outbox = outbox.clone();
            move |state| {
                let _ = outbox.send(Outgoing::Message(HelperMessage {
                    request_id: 0,
                    kind: Some(helper_message::Kind::LockState(state)),
                }));
            }
        };
        let mut device = device
            .with_channel_report(Arc::new(report), helper_version)
            .with_lock_report(Arc::new(lock_report));
        let served = answer_requests(input, &outbox, &mut device, helper_version);
        device.shutdown(Instant::now() + CHANNELS_CLOSE_WITHIN);
        drop(device);
        let _ = outbox.send(Outgoing::Close);
        let written = writer
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("the helper's writer failed")));
        // A failed output is the cause when both failed.
        written.and(served)
    })
}

fn write_messages<W: Write>(output: &mut W, inbox: &mpsc::Receiver<Outgoing>) -> io::Result<()> {
    while let Ok(Outgoing::Message(message)) = inbox.recv() {
        output.write_all(&message.encode_length_delimited_to_vec())?;
        output.flush()?;
    }
    Ok(())
}

fn answer_requests<R: Read>(
    input: &mut R,
    outbox: &mpsc::Sender<Outgoing>,
    device: &mut device::Device,
    helper_version: &str,
) -> io::Result<()> {
    let send = |message: HelperMessage| {
        outbox
            .send(Outgoing::Message(message))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the helper's output closed"))
    };
    send(HelperMessage {
        request_id: 0,
        kind: Some(helper_message::Kind::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            helper_name: HELPER_NAME.to_owned(),
            helper_version: helper_version.to_owned(),
        })),
    })?;

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
                device.start_channel(request)
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
        send(HelperMessage {
            request_id,
            kind: Some(kind),
        })?;
        // A channel started by this request reports only after its answer.
        device.start_prepared();
    }
    Ok(())
}

fn unknown_request() -> helper_message::Kind {
    helper_message::Kind::Failure(Failure {
        code: "unknown_request".to_owned(),
        message: "the helper does not serve this kind of request".to_owned(),
    })
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
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use base64::Engine as _;

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

    /// Runs `serve` on its own thread with a Device that dials `connector`, and returns the
    /// pipe to its input, its replies and the thread.
    fn serve_in_background(
        connector: wire::Connector,
        timing: channel::Timing,
    ) -> (
        std::sync::mpsc::Sender<Vec<u8>>,
        testkit::Replies,
        std::thread::JoinHandle<io::Result<()>>,
    ) {
        serve_with_engine(connector, timing, None)
    }

    fn serve_with_engine(
        connector: wire::Connector,
        timing: channel::Timing,
        engine: Option<engine::EngineSpec>,
    ) -> (
        std::sync::mpsc::Sender<Vec<u8>>,
        testkit::Replies,
        std::thread::JoinHandle<io::Result<()>>,
    ) {
        let (input, mut reader) = testkit::pipe();
        let (mut tap, replies) = testkit::output();
        let mut device =
            device::Device::with_lock_path(Some(testkit::scratch("lock").join("agent.lock")))
                .with_channels(connector, timing);
        if let Some(engine) = engine {
            device = device.with_engine(engine);
        }
        let thread = std::thread::spawn(move || serve_with(&mut reader, &mut tap, "1.2.3", device));
        (input, replies, thread)
    }

    fn configure(request_id: u64) -> AppMessage {
        use super::lazurio::app::device::v1::ConfigureDevice;
        AppMessage {
            request_id,
            kind: Some(app_message::Kind::ConfigureDevice(ConfigureDevice {
                data_directory: testkit::scratch("data").to_string_lossy().into_owned(),
                computer_name: "Work laptop".to_owned(),
            })),
        }
    }

    fn start_channel(
        request_id: u64,
        environment_id: &str,
        proxy: Option<super::lazurio::app::device::v1::TailnetProxy>,
    ) -> AppMessage {
        use super::lazurio::app::device::v1::StartChannel;
        AppMessage {
            request_id,
            kind: Some(app_message::Kind::StartChannel(StartChannel {
                environment_id: environment_id.to_owned(),
                environment_label: "Environment".to_owned(),
                attach_url: testkit::ATTACH_URL.to_owned(),
                device_id: testkit::DEVICE_ID.to_owned(),
                key_seed: testkit::SEED.to_vec(),
                proxy,
            })),
        }
    }

    fn channel_state(
        message: &HelperMessage,
    ) -> (&str, &super::lazurio::app::device::v1::channel_state::State) {
        match &message.kind {
            Some(helper_message::Kind::ChannelState(state)) => (
                state.environment_id.as_str(),
                state.state.as_ref().expect("a state"),
            ),
            other => panic!("expected a ChannelState, got {other:?}"),
        }
    }

    #[test]
    fn a_started_channel_reports_its_states_and_no_secret_ever_leaves_the_helper() {
        use super::lazurio::app::device::v1::{Connected, Connecting, TailnetProxy, channel_state};
        let environment = testkit::FakeEnvironment::start(|session: &mut testkit::Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let proxy = testkit::FakeProxy::start("lazurio", "proxy-secret-7f3a", environment.address);
        let (input, mut replies, thread) =
            serve_in_background(environment.connector(), testkit::quick_timing());

        input
            .send(frames(&[configure(1)]))
            .expect("the helper reads");
        assert_eq!(replies.next().request_id, 0, "Hello");
        assert_eq!(replies.next().request_id, 1);
        input
            .send(frames(&[start_channel(
                2,
                "env-a",
                Some(TailnetProxy {
                    host: "127.0.0.1".to_owned(),
                    port: u32::from(proxy.port),
                    username: "lazurio".to_owned(),
                    password: "proxy-secret-7f3a".to_owned(),
                }),
            )]))
            .expect("the helper reads");
        let answer = replies.next();
        assert_eq!(answer.request_id, 2);
        assert_eq!(
            channel_state(&answer),
            (
                "env-a",
                &channel_state::State::Connecting(Connecting { failed_attempts: 0 })
            )
        );
        let unsolicited = replies.next();
        assert_eq!(
            unsolicited.request_id, 0,
            "a change of state comes on its own"
        );
        assert_eq!(
            channel_state(&unsolicited),
            ("env-a", &channel_state::State::Connected(Connected {}))
        );

        drop(input);
        thread.join().expect("serve ends").expect("cleanly");
        replies.drain();
        let all = &replies.all;
        assert!(
            !all.windows(32).any(|window| window == testkit::SEED),
            "no key"
        );
        for secret in [
            b"proxy-secret-7f3a".as_slice(),
            base64::engine::general_purpose::STANDARD
                .encode("lazurio:proxy-secret-7f3a")
                .as_bytes(),
        ] {
            assert!(
                !all.windows(secret.len()).any(|window| window == secret),
                "no proxy credentials"
            );
        }
    }

    #[test]
    fn shutdown_closes_every_channel_within_two_seconds() {
        use super::lazurio::app::device::v1::{Connected, channel_state};
        let environment = testkit::FakeEnvironment::start(|session: &mut testkit::Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let mute = testkit::MuteServer::start();
        // Contract v1's timing: a quiet session pings only every 15 s, and a handshake waits 20 s.
        let (input, mut replies, thread) =
            serve_in_background(environment.connector(), channel::Timing::default());
        input
            .send(frames(&[configure(1), start_channel(2, "env-a", None)]))
            .expect("reads");
        replies.next();
        replies.next();
        replies.next();
        assert_eq!(
            channel_state(&replies.next()),
            ("env-a", &channel_state::State::Connected(Connected {}))
        );
        // A second Environment whose handshake hangs, reached through the mute server.
        let (mute_input, mut mute_replies, mute_thread) =
            serve_in_background(mute.connector(), channel::Timing::default());
        mute_input
            .send(frames(&[configure(1), start_channel(2, "env-b", None)]))
            .expect("reads");
        mute_replies.next();
        mute_replies.next();
        mute_replies.next();
        assert_eq!(mute.next(), testkit::Event::Tcp);

        let shutdown = AppMessage {
            request_id: 3,
            kind: Some(app_message::Kind::Shutdown(Shutdown {})),
        };
        let started = std::time::Instant::now();
        input
            .send(frames(std::slice::from_ref(&shutdown)))
            .expect("reads");
        thread.join().expect("serve ends").expect("cleanly");
        mute_input.send(frames(&[shutdown])).expect("reads");
        mute_thread.join().expect("serve ends").expect("cleanly");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "both helpers stopped within two seconds, took {:?}",
            started.elapsed()
        );
        assert_eq!(
            environment.until(|event| *event == testkit::Event::Closed),
            testkit::Event::Closed
        );
        assert_eq!(mute.next(), testkit::Event::Closed);
    }

    #[test]
    fn shutdown_ends_the_engine_within_two_seconds() {
        let _forks = testkit::spawning();
        let environment = testkit::FakeEnvironment::start(|session: &mut testkit::Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let engines = testkit::FakeEngines::start();
        let (input, mut replies, thread) = serve_with_engine(
            environment.connector(),
            channel::Timing::default(),
            Some(engines.spec()),
        );
        input
            .send(frames(&[configure(1), start_channel(2, "env-a", None)]))
            .expect("reads");
        for _ in 0..4 {
            replies.next();
        }
        assert_eq!(engines.next(), testkit::EngineEvent::Started(1));

        let started = std::time::Instant::now();
        input
            .send(frames(&[AppMessage {
                request_id: 3,
                kind: Some(app_message::Kind::Shutdown(Shutdown {})),
            }]))
            .expect("reads");
        thread.join().expect("serve ends").expect("cleanly");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the helper and its engine stopped within two seconds, took {:?}",
            started.elapsed()
        );
        assert_eq!(
            engines.until(|event| matches!(event, testkit::EngineEvent::Ended(_))),
            testkit::EngineEvent::Ended(1)
        );
    }

    #[test]
    fn the_end_of_input_closes_every_channel_within_two_seconds() {
        let environment = testkit::FakeEnvironment::start(|session: &mut testkit::Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let (input, mut replies, thread) =
            serve_in_background(environment.connector(), channel::Timing::default());
        input
            .send(frames(&[configure(1), start_channel(2, "env-a", None)]))
            .expect("reads");
        for _ in 0..4 {
            replies.next();
        }
        let started = std::time::Instant::now();
        drop(input);
        thread.join().expect("serve ends").expect("cleanly");
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(
            environment.until(|event| *event == testkit::Event::Closed),
            testkit::Event::Closed
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
