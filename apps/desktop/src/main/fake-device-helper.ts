// Tests only: lazurio-device. After Shutdown "stop" exits, "linger" never exits, "crash" exits after
// Ping, "mute" closes its output. "v3": each StartChannel gets Connecting, then the next of
// LAZURIO_FAKE_DEVICE_OUTCOMES (connected, working, needs-hand-over, refused:<reason>).
// LAZURIO_FAKE_DEVICE_STOP=silent ignores StopChannel.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { ChannelStateSchema } from "@lazurio/app-contracts/device/v1";
import { decodeFrames, encodeFrame } from "@lazurio/app-contracts/framing";
import {
  AppMessageSchema,
  HelperMessageSchema,
  type AppMessage,
} from "@lazurio/app-contracts/helper/v1";

const afterShutdown = process.argv[2] ?? "stop";
const servesV3 = afterShutdown === "v3";
const outcomes = (process.env["LAZURIO_FAKE_DEVICE_OUTCOMES"] ?? "")
  .split(",")
  .filter((outcome) => outcome !== "");
const silentStop = process.env["LAZURIO_FAKE_DEVICE_STOP"] === "silent";

type Kind = NonNullable<MessageInitShape<typeof HelperMessageSchema>["kind"]>;
type AppKind = AppMessage["kind"];
type ChannelStateInit = NonNullable<MessageInitShape<typeof ChannelStateSchema>["state"]>;

const send = (message: MessageInitShape<typeof HelperMessageSchema>) => {
  process.stdout.write(encodeFrame(HelperMessageSchema, create(HelperMessageSchema, message)));
};
const answer = (requestId: bigint, kind: Kind) => send({ requestId, kind });

const stopped = () => {
  send({ requestId: 0n, kind: { case: "deviceStopped", value: { allEnginesEnded: true } } });
  if (afterShutdown === "linger") {
    // Keeps the process alive until the test's scope ends it by its PID.
    // @effect-diagnostics-next-line globalTimers:off - A fixture outside Effect, as small as it can be.
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
};

// The state a StartChannel's channel reaches after Connecting.
const outcomeOf = (outcome: string): ChannelStateInit => {
  if (outcome === "needs-hand-over") {
    return {
      case: "needsHandOver",
      value: { reason: "session_ended", failedAttempts: 0, retryAfterMs: 0n, httpStatus: 0 },
    };
  }
  if (outcome === "working") {
    return { case: "working", value: { tool: "click", application: "E2E" } };
  }
  if (outcome.startsWith("refused:")) {
    return { case: "refused", value: { reason: outcome.slice("refused:".length), httpStatus: 0 } };
  }
  return { case: "connected", value: {} };
};

let idle = 1n;
const v3 = (requestId: bigint, request: AppKind): boolean => {
  if (!servesV3) return false;
  switch (request.case) {
    case "configureDevice":
      answer(requestId, { case: "deviceReady", value: { contractVersion: 3 } });
      return true;
    case "startChannel": {
      const { environmentId } = request.value;
      answer(requestId, {
        case: "channelState",
        value: { environmentId, state: { case: "connecting", value: { failedAttempts: 0 } } },
      });
      const state = outcomeOf(outcomes.shift() ?? "connected");
      send({ requestId: 0n, kind: { case: "channelState", value: { environmentId, state } } });
      return true;
    }
    case "stopChannel": {
      if (silentStop) return true;
      const { environmentId } = request.value;
      answer(requestId, {
        case: "channelState",
        value: { environmentId, state: { case: "off", value: {} } },
      });
      return true;
    }
    case "stopAgent":
      idle += 1n;
      answer(requestId, {
        case: "lockState",
        value: { idle: true, sequence: idle, holderEnvironmentId: "", holderEnvironmentLabel: "" },
      });
      return true;
    default:
      return false;
  }
};

send({
  requestId: 0n,
  kind: {
    case: "hello",
    value: { protocolVersion: 1, helperName: "lazurio-device", helperVersion: "0.0.0-test" },
  },
});

for await (const message of decodeFrames(AppMessageSchema, process.stdin)) {
  if (message.kind.case === "ping") {
    send({
      requestId: message.requestId,
      kind: { case: "pong", value: { nonce: message.kind.value.nonce } },
    });
    if (afterShutdown === "mute") {
      process.stdout.end();
      // @effect-diagnostics-next-line globalTimers:off - A fixture outside Effect, as small as it can be.
      setInterval(() => {}, 1000);
    }
  } else if (message.kind.case === "shutdown") {
    stopped();
    break;
  } else if (v3(message.requestId, message.kind)) {
    continue;
  } else if (afterShutdown === "crash") {
    process.exit(1);
  }
}
