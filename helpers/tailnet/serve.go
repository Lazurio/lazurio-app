package main

import (
	"errors"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/encoding/protodelim"

	helperv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/helper/v1"
	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

const (
	protocolVersion = 1
	helperName      = "lazurio-tailnet"
)

// Outbox writes the helper's messages to its output, one whole frame at a time, from the
// conversation and from the nodes' events alike.
type Outbox struct {
	mu  sync.Mutex
	out io.Writer
}

// NewOutbox writes framed messages to out.
func NewOutbox(out io.Writer) *Outbox {
	return &Outbox{out: out}
}

// Send writes one message, framed by its length as a varint.
func (o *Outbox) Send(message *helperv1.HelperMessage) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := protodelim.MarshalTo(o.out, message)
	return err
}

// TailnetService starts tailnet nodes; Nodes implements it.
type TailnetService interface {
	Start(request *tailnetv1.StartNode) (*tailnetv1.NodeState, error)
}

func failure(requestID uint64, code, message string) *helperv1.HelperMessage {
	return &helperv1.HelperMessage{
		RequestId: requestID,
		Kind:      &helperv1.HelperMessage_Failure{Failure: &helperv1.Failure{Code: code, Message: message}},
	}
}

// serve speaks the helper protocol: Hello first, then the proxy's endpoint, then an answer to each
// AppMessage until Shutdown or the end of the input.
func serve(
	in protodelim.Reader,
	out *Outbox,
	helperVersion string,
	tailnets TailnetService,
	proxy *tailnetv1.ProxyEndpoint,
) error {
	hello := &helperv1.HelperMessage{
		Kind: &helperv1.HelperMessage_Hello{Hello: &helperv1.Hello{
			ProtocolVersion: protocolVersion,
			HelperName:      helperName,
			HelperVersion:   helperVersion,
		}},
	}
	if err := out.Send(hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	endpoint := &helperv1.HelperMessage{
		Kind: &helperv1.HelperMessage_ProxyEndpoint{ProxyEndpoint: proxy},
	}
	if err := out.Send(endpoint); err != nil {
		return fmt.Errorf("send the proxy's endpoint: %w", err)
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
		case *helperv1.AppMessage_StartNode:
			state, err := tailnets.Start(kind.StartNode)
			if err != nil {
				reply = failure(message.GetRequestId(), "start_node_failed", err.Error())
			} else {
				reply = &helperv1.HelperMessage{
					RequestId: message.GetRequestId(),
					Kind:      &helperv1.HelperMessage_NodeState{NodeState: state},
				}
			}
		default:
			reply = failure(message.GetRequestId(), "unknown_request", "the helper does not serve this kind of request")
		}
		if err := out.Send(reply); err != nil {
			return fmt.Errorf("send reply to request %d: %w", message.GetRequestId(), err)
		}
	}
}
