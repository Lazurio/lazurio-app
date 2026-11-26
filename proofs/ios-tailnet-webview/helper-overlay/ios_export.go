// The proof adds this one file to helpers/tailnet through `go build -overlay`, without changing the
// helper itself. iOS lets an app start no child process, so the helper is linked into the app as
// a C archive and these two functions replace its standard input and output. They call the
// helper's own nodes and proxy.

package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"

	"tailscale.com/net/netns"

	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

var (
	iosMu    sync.Mutex
	iosState = "not started"
	iosProxy *Proxy
	iosNodes *Nodes
)

type iosStart struct {
	Tailnet        string   `json:"tailnet"`
	ControlURL     string   `json:"controlUrl"`
	Hostname       string   `json:"hostname"`
	StateDirectory string   `json:"stateDirectory"`
	Domains        []string `json:"domains"`
	StateKeyHex    string   `json:"stateKeyHex"`
}

type iosStarted struct {
	Port     uint32 `json:"port,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Error    string `json:"error,omitempty"`
}

func describeState(state *tailnetv1.NodeState) string {
	switch kind := state.GetState().(type) {
	case *tailnetv1.NodeState_Starting:
		return "starting"
	case *tailnetv1.NodeState_NeedsLogin:
		return "needs-login"
	case *tailnetv1.NodeState_Running:
		return "running " + strings.Join(kind.Running.GetAddresses(), ",")
	case *tailnetv1.NodeState_Stopped:
		return "stopped " + kind.Stopped.GetReason()
	}
	return "unknown"
}

//export LazurioTailnetStart
func LazurioTailnetStart(config *C.char) *C.char {
	answer := func(started iosStarted) *C.char {
		data, _ := json.Marshal(started)
		return C.CString(string(data))
	}
	var request iosStart
	if err := json.Unmarshal([]byte(C.GoString(config)), &request); err != nil {
		return answer(iosStarted{Error: err.Error()})
	}
	key, err := hex.DecodeString(request.StateKeyHex)
	if err != nil {
		return answer(iosStarted{Error: "state key: " + err.Error()})
	}
	// The simulator's test control server is on the loopback; the node needs no interface binding.
	netns.SetEnabled(false)
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	iosMu.Lock()
	defer iosMu.Unlock()
	iosNodes = NewNodes(func(state *tailnetv1.NodeState) {
		iosMu.Lock()
		iosState = describeState(state)
		iosMu.Unlock()
	}, logger)
	iosProxy, err = StartProxy(iosNodes, logger)
	if err != nil {
		return answer(iosStarted{Error: err.Error()})
	}
	state, begin, err := iosNodes.Start(&tailnetv1.StartNode{
		Tailnet:        request.Tailnet,
		ControlUrl:     request.ControlURL,
		Hostname:       request.Hostname,
		StateDirectory: request.StateDirectory,
		Domains:        request.Domains,
		StateKey:       key,
	})
	if err != nil {
		return answer(iosStarted{Error: err.Error()})
	}
	iosState = describeState(state)
	begin()
	return answer(iosStarted{Port: iosProxy.Port(), Username: iosProxy.username, Password: iosProxy.password})
}

//export LazurioTailnetState
func LazurioTailnetState() *C.char {
	iosMu.Lock()
	defer iosMu.Unlock()
	return C.CString(iosState)
}
