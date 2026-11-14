package main

import (
	"bufio"
	"bytes"
	"testing"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	helperv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/helper/v1"
)

func TestServeAnswersInOrderAndStopsOnShutdown(t *testing.T) {
	var input bytes.Buffer
	for _, message := range []*helperv1.AppMessage{
		{RequestId: 7, Kind: &helperv1.AppMessage_Ping{Ping: &helperv1.Ping{Nonce: []byte{1, 2, 3}}}},
		{RequestId: 8},
		{RequestId: 9, Kind: &helperv1.AppMessage_Shutdown{Shutdown: &helperv1.Shutdown{}}},
		{RequestId: 10, Kind: &helperv1.AppMessage_Ping{Ping: &helperv1.Ping{}}},
	} {
		if _, err := protodelim.MarshalTo(&input, message); err != nil {
			t.Fatalf("encode request %d: %v", message.GetRequestId(), err)
		}
	}

	var output bytes.Buffer
	if err := serve(bufio.NewReader(&input), &output, "1.2.3"); err != nil {
		t.Fatalf("serve: %v", err)
	}

	want := []*helperv1.HelperMessage{
		{Kind: &helperv1.HelperMessage_Hello{Hello: &helperv1.Hello{
			ProtocolVersion: 1, HelperName: "lazurio-tailnet", HelperVersion: "1.2.3",
		}}},
		{RequestId: 7, Kind: &helperv1.HelperMessage_Pong{Pong: &helperv1.Pong{Nonce: []byte{1, 2, 3}}}},
		{RequestId: 8, Kind: &helperv1.HelperMessage_Failure{Failure: &helperv1.Failure{
			Code: "unknown_request", Message: "the helper does not serve this kind of request",
		}}},
	}
	reader := bufio.NewReader(&output)
	for index, expected := range want {
		got := &helperv1.HelperMessage{}
		if err := protodelim.UnmarshalFrom(reader, got); err != nil {
			t.Fatalf("decode reply %d: %v", index, err)
		}
		if !proto.Equal(got, expected) {
			t.Fatalf("reply %d = %v, want %v", index, got, expected)
		}
	}
	if reader.Buffered() != 0 {
		t.Fatalf("the helper answered after Shutdown")
	}
}

func TestServeEndsQuietlyWhenTheAppClosesItsInput(t *testing.T) {
	var output bytes.Buffer
	if err := serve(bufio.NewReader(&bytes.Buffer{}), &output, "1.2.3"); err != nil {
		t.Fatalf("serve: %v", err)
	}
	if output.Len() == 0 {
		t.Fatalf("the helper sent no Hello")
	}
}
