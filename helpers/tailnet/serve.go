package main

import (
	"errors"
	"fmt"
	"io"

	"google.golang.org/protobuf/encoding/protodelim"

	helperv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/helper/v1"
)

const (
	protocolVersion = 1
	helperName      = "lazurio-tailnet"
)

// serve speaks the helper protocol: it sends Hello first, then answers each AppMessage until
// Shutdown or the end of its input. Each message is framed by its length as a varint.
func serve(in protodelim.Reader, out io.Writer, helperVersion string) error {
	hello := &helperv1.HelperMessage{
		Kind: &helperv1.HelperMessage_Hello{Hello: &helperv1.Hello{
			ProtocolVersion: protocolVersion,
			HelperName:      helperName,
			HelperVersion:   helperVersion,
		}},
	}
	if err := send(out, hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	for {
		message := &helperv1.AppMessage{}
		if err := protodelim.UnmarshalFrom(in, message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read message: %w", err)
		}

		var reply *helperv1.HelperMessage
		switch kind := message.GetKind().(type) {
		case *helperv1.AppMessage_Ping:
			reply = &helperv1.HelperMessage{
				RequestId: message.GetRequestId(),
				Kind:      &helperv1.HelperMessage_Pong{Pong: &helperv1.Pong{Nonce: kind.Ping.GetNonce()}},
			}
		case *helperv1.AppMessage_Shutdown:
			return nil
		default:
			reply = &helperv1.HelperMessage{
				RequestId: message.GetRequestId(),
				Kind: &helperv1.HelperMessage_Failure{Failure: &helperv1.Failure{
					Code:    "unknown_request",
					Message: "the helper does not serve this kind of request",
				}},
			}
		}
		if err := send(out, reply); err != nil {
			return fmt.Errorf("send reply to request %d: %w", message.GetRequestId(), err)
		}
	}
}

func send(out io.Writer, message *helperv1.HelperMessage) error {
	_, err := protodelim.MarshalTo(out, message)
	return err
}
