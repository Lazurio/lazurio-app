package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"sync"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"

	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

// Nodes holds one tsnet node per tailnet, all running at once, and routes a host name to the node
// whose domains it belongs to. Nothing is routed between tailnets.
type Nodes struct {
	mu     sync.Mutex
	nodes  map[string]*node
	emit   func(*tailnetv1.NodeState)
	logger *slog.Logger
}

type node struct {
	tailnet string
	domains []string
	server  *tsnet.Server
	cancel  context.CancelFunc
}

// NewNodes makes an empty set of nodes that reports each change of state through emit.
func NewNodes(emit func(*tailnetv1.NodeState), logger *slog.Logger) *Nodes {
	return &Nodes{nodes: map[string]*node{}, emit: emit, logger: logger}
}

// normalizeDomain lowercases a DNS suffix and drops its dots at either end.
func normalizeDomain(domain string) string {
	return strings.Trim(strings.ToLower(domain), ".")
}

func validateStart(request *tailnetv1.StartNode) error {
	if request.GetTailnet() == "" {
		return errors.New("a node needs the name of its tailnet")
	}
	control, err := url.Parse(request.GetControlUrl())
	if err != nil || control.Scheme != "https" || control.Host == "" || control.User != nil {
		return errors.New("the control server must be an https:// address without credentials")
	}
	if request.GetHostname() == "" {
		return errors.New("a node needs a hostname")
	}
	if !filepath.IsAbs(request.GetStateDirectory()) {
		return errors.New("the state directory must be an absolute path")
	}
	if len(request.GetDomains()) == 0 {
		return errors.New("a node needs at least one domain of its Environments")
	}
	for _, domain := range request.GetDomains() {
		if normalized := normalizeDomain(domain); normalized == "" || !strings.Contains(normalized, ".") {
			return fmt.Errorf("%q is not a DNS suffix", domain)
		}
	}
	return nil
}

// Start starts the node of one tailnet and reports its first state.
func (n *Nodes) Start(request *tailnetv1.StartNode) (*tailnetv1.NodeState, error) {
	if err := validateStart(request); err != nil {
		return nil, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, exists := n.nodes[request.GetTailnet()]; exists {
		return nil, fmt.Errorf("the node of %s already runs", request.GetTailnet())
	}
	domains := make([]string, 0, len(request.GetDomains()))
	for _, domain := range request.GetDomains() {
		domains = append(domains, normalizeDomain(domain))
	}
	for _, other := range n.nodes {
		for _, taken := range other.domains {
			for _, domain := range domains {
				if domain == taken || strings.HasSuffix(domain, "."+taken) || strings.HasSuffix(taken, "."+domain) {
					return nil, fmt.Errorf("%s overlaps %s of the tailnet %s", domain, taken, other.tailnet)
				}
			}
		}
	}
	logger := n.logger.With("tailnet", request.GetTailnet())
	server := &tsnet.Server{
		Dir:        request.GetStateDirectory(),
		Hostname:   request.GetHostname(),
		ControlURL: request.GetControlUrl(),
		Logf:       func(format string, args ...any) { logger.Debug(fmt.Sprintf(format, args...)) },
		UserLogf:   func(format string, args ...any) { logger.Info(fmt.Sprintf(format, args...)) },
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := server.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start the node: %w", err)
	}
	n.nodes[request.GetTailnet()] = &node{
		tailnet: request.GetTailnet(),
		domains: domains,
		server:  server,
		cancel:  cancel,
	}
	go n.watch(ctx, request.GetTailnet(), server, logger)
	return &tailnetv1.NodeState{
		Tailnet: request.GetTailnet(),
		State:   &tailnetv1.NodeState_Starting{Starting: &tailnetv1.Starting{}},
	}, nil
}

// watch reports the node's login address and its state for as long as the node runs.
func (n *Nodes) watch(ctx context.Context, tailnet string, server *tsnet.Server, logger *slog.Logger) {
	client, err := server.LocalClient()
	if err != nil {
		logger.Error("no local client for the node", "error", err)
		return
	}
	watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		logger.Error("cannot watch the node", "error", err)
		return
	}
	defer func() { _ = watcher.Close() }()
	// tsnet asks for an interactive login while it starts, and the address it gets (BrowseToURL)
	// may come before this watcher exists. The status keeps it, so a node that needs a login
	// reports the address from there; each address is reported once.
	reported := ""
	reportLogin := func(loginURL string) {
		if loginURL == "" || loginURL == reported {
			return
		}
		reported = loginURL
		n.emit(&tailnetv1.NodeState{
			Tailnet: tailnet,
			State:   &tailnetv1.NodeState_NeedsLogin{NeedsLogin: &tailnetv1.NeedsLogin{LoginUrl: loginURL}},
		})
	}
	for {
		notification, err := watcher.Next()
		if err != nil {
			if ctx.Err() == nil {
				n.emit(&tailnetv1.NodeState{
					Tailnet: tailnet,
					State:   &tailnetv1.NodeState_Stopped{Stopped: &tailnetv1.Stopped{Reason: err.Error()}},
				})
			}
			return
		}
		if notification.BrowseToURL != nil {
			reportLogin(*notification.BrowseToURL)
		}
		if notification.State != nil && *notification.State == ipn.NeedsLogin {
			if status, err := client.Status(ctx); err == nil {
				reportLogin(status.AuthURL)
			}
		}
		if notification.State != nil && *notification.State == ipn.Running {
			status, err := client.Status(ctx)
			if err != nil {
				logger.Error("cannot read the node's status", "error", err)
				continue
			}
			addresses := make([]string, 0, len(status.TailscaleIPs))
			for _, address := range status.TailscaleIPs {
				addresses = append(addresses, address.String())
			}
			n.emit(&tailnetv1.NodeState{
				Tailnet: tailnet,
				State:   &tailnetv1.NodeState_Running{Running: &tailnetv1.Running{Addresses: addresses}},
			})
		}
	}
}

// DialerFor gives the dialer of the node whose domains the host name belongs to.
func (n *Nodes) DialerFor(hostname string) (DialFunc, bool) {
	name := normalizeDomain(hostname)
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, candidate := range n.nodes {
		for _, domain := range candidate.domains {
			if name == domain || strings.HasSuffix(name, "."+domain) {
				return candidate.server.Dial, true
			}
		}
	}
	return nil, false
}

// Close stops every node.
func (n *Nodes) Close() {
	n.mu.Lock()
	defer n.mu.Unlock()
	for tailnet, candidate := range n.nodes {
		candidate.cancel()
		_ = candidate.server.Close()
		delete(n.nodes, tailnet)
	}
}
