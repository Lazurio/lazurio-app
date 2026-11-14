package main

import (
	"bufio"
	"bytes"
	"errors"
	"testing"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	helperv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/helper/v1"
	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

type fakeTailnets struct {
	started []*tailnetv1.StartNode
	// out, when set, receives a NeedsLogin event as soon as the node may report.
	out *Outbox
}

func (f *fakeTailnets) Start(request *tailnetv1.StartNode) (*tailnetv1.NodeState, func(), error) {
	f.started = append(f.started, request)
	if request.GetTailnet() == "broken" {
		return nil, nil, errors.New("no such tailnet")
	}
	begin := func() {
		if f.out == nil {
			return
		}
		_ = f.out.Send(&helperv1.HelperMessage{Kind: &helperv1.HelperMessage_NodeState{NodeState: &tailnetv1.NodeState{
			Tailnet: request.GetTailnet(),
			State:   &tailnetv1.NodeState_NeedsLogin{NeedsLogin: &tailnetv1.NeedsLogin{LoginUrl: "https://headscale.example/register/x"}},
		}}})
	}
	return &tailnetv1.NodeState{
		Tailnet: request.GetTailnet(),
		State:   &tailnetv1.NodeState_Starting{Starting: &tailnetv1.Starting{}},
	}, begin, nil
}

var testEndpoint = &tailnetv1.ProxyEndpoint{Host: "127.0.0.1", Port: 4242, Username: "u", Password: "p"}

func runServe(t *testing.T, messages []*helperv1.AppMessage, tailnets *fakeTailnets) []*helperv1.HelperMessage {
	t.Helper()
	var input bytes.Buffer
	for _, message := range messages {
		if _, err := protodelim.MarshalTo(&input, message); err != nil {
			t.Fatalf("encode request %d: %v", message.GetRequestId(), err)
		}
	}
	var output bytes.Buffer
	out := NewOutbox(&output)
	tailnets.out = out
	if err := serve(bufio.NewReader(&input), out, "1.2.3", tailnets, testEndpoint); err != nil {
		t.Fatalf("serve: %v", err)
	}
	var replies []*helperv1.HelperMessage
	reader := bufio.NewReader(&output)
	for reader.Buffered() > 0 || output.Len() > 0 {
		reply := &helperv1.HelperMessage{}
		if err := protodelim.UnmarshalFrom(reader, reply); err != nil {
			break
		}
		replies = append(replies, reply)
	}
	return replies
}

func expect(t *testing.T, got []*helperv1.HelperMessage, want []*helperv1.HelperMessage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d messages, want %d: %v", len(got), len(want), got)
	}
	for index := range want {
		if !proto.Equal(got[index], want[index]) {
			t.Fatalf("message %d = %v, want %v", index, got[index], want[index])
		}
	}
}

var hello = &helperv1.HelperMessage{Kind: &helperv1.HelperMessage_Hello{Hello: &helperv1.Hello{
	ProtocolVersion: 1, HelperName: "lazurio-tailnet", HelperVersion: "1.2.3",
}}}

var endpoint = &helperv1.HelperMessage{Kind: &helperv1.HelperMessage_ProxyEndpoint{ProxyEndpoint: testEndpoint}}

func TestServeAnswersInOrderAndStopsOnShutdown(t *testing.T) {
	replies := runServe(t, []*helperv1.AppMessage{
		{RequestId: 7, Kind: &helperv1.AppMessage_Ping{Ping: &helperv1.Ping{Nonce: []byte{1, 2, 3}}}},
		{RequestId: 8},
		{RequestId: 9, Kind: &helperv1.AppMessage_Shutdown{Shutdown: &helperv1.Shutdown{}}},
		{RequestId: 10, Kind: &helperv1.AppMessage_Ping{Ping: &helperv1.Ping{}}},
	}, &fakeTailnets{})

	expect(t, replies, []*helperv1.HelperMessage{
		hello,
		endpoint,
		{RequestId: 7, Kind: &helperv1.HelperMessage_Pong{Pong: &helperv1.Pong{Nonce: []byte{1, 2, 3}}}},
		failure(8, "unknown_request", "the helper does not serve this kind of request"),
	})
}

func TestServeStartsNodesAndReportsWhatFails(t *testing.T) {
	tailnets := &fakeTailnets{}
	replies := runServe(t, []*helperv1.AppMessage{
		{RequestId: 1, Kind: &helperv1.AppMessage_StartNode{StartNode: &tailnetv1.StartNode{Tailnet: "example"}}},
		{RequestId: 2, Kind: &helperv1.AppMessage_StartNode{StartNode: &tailnetv1.StartNode{Tailnet: "broken"}}},
	}, tailnets)

	expect(t, replies, []*helperv1.HelperMessage{
		hello,
		endpoint,
		{RequestId: 1, Kind: &helperv1.HelperMessage_NodeState{NodeState: &tailnetv1.NodeState{
			Tailnet: "example",
			State:   &tailnetv1.NodeState_Starting{Starting: &tailnetv1.Starting{}},
		}}},
		// The node's own report comes only after the reply to its start.
		{Kind: &helperv1.HelperMessage_NodeState{NodeState: &tailnetv1.NodeState{
			Tailnet: "example",
			State:   &tailnetv1.NodeState_NeedsLogin{NeedsLogin: &tailnetv1.NeedsLogin{LoginUrl: "https://headscale.example/register/x"}},
		}}},
		failure(2, "start_node_failed", "no such tailnet"),
	})
	if len(tailnets.started) != 2 {
		t.Fatalf("started %d nodes, want 2", len(tailnets.started))
	}
}

func TestServeEndsQuietlyWhenTheAppClosesItsInput(t *testing.T) {
	expect(t, runServe(t, nil, &fakeTailnets{}), []*helperv1.HelperMessage{hello, endpoint})
}
