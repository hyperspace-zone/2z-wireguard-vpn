package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const version = "0.1.0"

type config struct {
	ControlPlaneURL   string
	GateName          string
	GateToken         string
	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	ExecutionMode     string
	StateDir          string
}

type claimResponse struct {
	Job *job `json:"job"`
}

type job struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	SessionID     *string         `json:"sessionId"`
	AssignmentID  *string         `json:"assignmentId"`
	AttemptNumber int             `json:"attemptNumber"`
}

func main() {
	cfg, err := readConfig()
	if err != nil {
		fatal(err)
	}

	client := &http.Client{Timeout: 20 * time.Second}
	logJSON("agent_started", map[string]any{
		"gate":          cfg.GateName,
		"version":       version,
		"executionMode": cfg.ExecutionMode,
		"stateDir":      cfg.StateDir,
	})

	lastHeartbeat := time.Time{}
	for {
		if time.Since(lastHeartbeat) >= cfg.HeartbeatInterval {
			if err := sendHeartbeat(client, cfg); err != nil {
				logJSON("heartbeat_failed", map[string]any{"error": err.Error()})
			} else {
				lastHeartbeat = time.Now()
			}
			if err := sendActualState(client, cfg); err != nil {
				logJSON("actual_state_failed", map[string]any{"error": err.Error()})
			}
		}

		claimed, err := claimJob(client, cfg)
		if err != nil {
			logJSON("claim_failed", map[string]any{"error": err.Error()})
			sleep(cfg.PollInterval)
			continue
		}
		if claimed == nil {
			sleep(cfg.PollInterval)
			continue
		}

		result := executeJob(cfg, *claimed)
		if err := reportJob(client, cfg, claimed.ID, result); err != nil {
			logJSON("report_failed", map[string]any{
				"jobId": claimed.ID,
				"error": err.Error(),
			})
		}
	}
}

type jobResult struct {
	Status          string         `json:"status"`
	ActualStateHash string         `json:"actualStateHash,omitempty"`
	ErrorCode       string         `json:"errorCode,omitempty"`
	ResultSummary   map[string]any `json:"resultSummary"`
}

func executeJob(cfg config, item job) jobResult {
	logJSON("job_received", map[string]any{
		"jobId":         item.ID,
		"type":          item.Type,
		"attemptNumber": item.AttemptNumber,
	})

	switch item.Type {
	case "apply_assignment":
		if cfg.ExecutionMode == "ack" {
			return jobResult{
				Status:          "succeeded",
				ActualStateHash: actualStateHash(),
				ResultSummary: map[string]any{
					"executionMode": cfg.ExecutionMode,
					"note":          "assignment acknowledged without host mutation",
				},
			}
		}
		if cfg.ExecutionMode == "apply" {
			return executeApplyAssignment(cfg, item)
		}
		return jobResult{
			Status:    "retryable_failed",
			ErrorCode: "host_mutation_not_enabled",
			ResultSummary: map[string]any{
				"executionMode": cfg.ExecutionMode,
				"note":          "set GATE_AGENT_EXECUTION_MODE=apply to mutate host WireGuard state",
			},
		}
	case "revoke_assignment":
		if cfg.ExecutionMode == "ack" {
			return jobResult{
				Status:          "succeeded",
				ActualStateHash: actualStateHash(),
				ResultSummary: map[string]any{
					"executionMode": cfg.ExecutionMode,
					"note":          "assignment revoke acknowledged without host mutation",
				},
			}
		}
		if cfg.ExecutionMode == "apply" {
			return executeRevokeAssignment(cfg, item)
		}
		return jobResult{
			Status:    "retryable_failed",
			ErrorCode: "host_mutation_not_enabled",
			ResultSummary: map[string]any{
				"executionMode": cfg.ExecutionMode,
				"note":          "set GATE_AGENT_EXECUTION_MODE=apply to mutate host WireGuard state",
			},
		}
	default:
		return jobResult{
			Status:    "failed",
			ErrorCode: "unsupported_job_type",
			ResultSummary: map[string]any{
				"type": item.Type,
			},
		}
	}
}

type assignmentPayload struct {
	AssignmentID string      `json:"assignmentId"`
	Operation    string      `json:"operation"`
	Role         string      `json:"role"`
	Plan         preparePlan `json:"plan"`
	NetworkPlan  networkPlan `json:"networkPlan"`
}

type preparePlan struct {
	PlanID         string         `json:"planId"`
	PublicMaterial publicMaterial `json:"publicMaterial"`
	RoutingModel   map[string]any `json:"routingModel"`
	FirewallModel  map[string]any `json:"firewallModel"`
}

type networkPlan struct {
	PlanID         string             `json:"planId"`
	SessionID      string             `json:"sessionId"`
	Generation     int                `json:"generation"`
	PublicMaterial publicMaterial     `json:"publicMaterial"`
	RoutingModel   map[string]any     `json:"routingModel"`
	FirewallModel  map[string]any     `json:"firewallModel"`
	Ingress        assignmentEndpoint `json:"ingress"`
	Egress         assignmentEndpoint `json:"egress"`
}

type publicMaterial struct {
	SessionID                  string   `json:"sessionId"`
	Generation                 int      `json:"generation"`
	Mode                       string   `json:"mode"`
	DestinationCidrs           []string `json:"destinationCidrs"`
	ClientAddress              string   `json:"clientAddress"`
	ClientPublicKey            string   `json:"clientPublicKey"`
	PersistentKeepaliveSeconds int      `json:"persistentKeepaliveSeconds"`
	MTU                        int      `json:"mtu"`
}

type assignmentEndpoint struct {
	AssignmentID  string        `json:"assignmentId"`
	Role          string        `json:"role"`
	Handle        string        `json:"handle"`
	GateName      string        `json:"gateName"`
	PublicIPv4    string        `json:"publicIpv4"`
	LocalMaterial localMaterial `json:"localMaterial"`
}

type localMaterial struct {
	AssignmentID      string             `json:"assignmentId"`
	Role              string             `json:"role"`
	Handle            string             `json:"handle"`
	DoubleZeroAddress string             `json:"doubleZeroAddress"`
	Interfaces        materialInterfaces `json:"interfaces"`
	WireGuard         materialWireGuard  `json:"wireGuard"`
}

type materialInterfaces struct {
	Client  string `json:"client,omitempty"`
	Transit string `json:"transit"`
}

type materialWireGuard struct {
	ClientPublicKey   string `json:"clientPublicKey,omitempty"`
	ClientListenPort  int    `json:"clientListenPort,omitempty"`
	TransitPublicKey  string `json:"transitPublicKey"`
	TransitListenPort int    `json:"transitListenPort"`
}

type assignmentState struct {
	AssignmentID      string        `json:"assignmentId"`
	Role              string        `json:"role"`
	Handle            string        `json:"handle"`
	SessionID         string        `json:"sessionId"`
	SourceCidr        string        `json:"sourceCidr,omitempty"`
	ClientAddress     string        `json:"clientAddress"`
	DestinationCidrs  []string      `json:"destinationCidrs"`
	RoutingTable      int           `json:"routingTable"`
	RulePriority      int           `json:"rulePriority"`
	ClientPrivateKey  string        `json:"clientPrivateKey,omitempty"`
	TransitPrivateKey string        `json:"transitPrivateKey"`
	Material          localMaterial `json:"material"`
	CreatedAt         string        `json:"createdAt"`
}

func executeApplyAssignment(cfg config, item job) jobResult {
	payload, err := decodeAssignmentPayload(item)
	if err != nil {
		return failed("invalid_payload", err)
	}
	switch payload.Operation {
	case "prepare":
		material, err := prepareAssignment(cfg, payload)
		if err != nil {
			return retryable("prepare_failed", err)
		}
		return jobResult{
			Status:          "succeeded",
			ActualStateHash: actualStateHash(),
			ResultSummary: map[string]any{
				"operation":     "prepare",
				"executionMode": cfg.ExecutionMode,
				"material":      material,
			},
		}
	case "commit":
		state, err := commitAssignment(cfg, payload)
		if err != nil {
			return retryable("commit_failed", err)
		}
		return jobResult{
			Status:          "succeeded",
			ActualStateHash: actualStateHash(),
			ResultSummary: map[string]any{
				"operation":     "commit",
				"executionMode": cfg.ExecutionMode,
				"material":      state.Material,
			},
		}
	default:
		return failed("unsupported_assignment_operation", fmt.Errorf("unsupported operation %q", payload.Operation))
	}
}

func executeRevokeAssignment(cfg config, item job) jobResult {
	payload, err := decodeAssignmentPayload(item)
	if err != nil {
		return failed("invalid_payload", err)
	}
	if err := revokeAssignment(cfg, payload); err != nil {
		return retryable("revoke_failed", err)
	}
	return jobResult{
		Status:          "succeeded",
		ActualStateHash: actualStateHash(),
		ResultSummary: map[string]any{
			"operation":     "revoke",
			"executionMode": cfg.ExecutionMode,
			"assignmentId":  payload.AssignmentID,
		},
	}
}

func decodeAssignmentPayload(item job) (assignmentPayload, error) {
	var payload assignmentPayload
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return payload, err
	}
	if payload.AssignmentID == "" && item.AssignmentID != nil {
		payload.AssignmentID = *item.AssignmentID
	}
	if payload.AssignmentID == "" {
		return payload, errors.New("assignmentId is required")
	}
	if payload.Role == "" {
		payload.Role = payload.NetworkPlan.Ingress.Role
	}
	return payload, nil
}

func prepareAssignment(cfg config, payload assignmentPayload) (localMaterial, error) {
	existing, err := readAssignmentState(cfg, payload.AssignmentID)
	if err == nil && existing.Material.AssignmentID != "" {
		return existing.Material, nil
	}
	if payload.Role != "Ingress" && payload.Role != "Egress" {
		return localMaterial{}, fmt.Errorf("unsupported role %q", payload.Role)
	}
	if payload.Plan.PublicMaterial.ClientAddress == "" || len(payload.Plan.PublicMaterial.DestinationCidrs) == 0 {
		return localMaterial{}, errors.New("plan public material is incomplete")
	}

	clientPrivateKey := ""
	clientPublicKey := ""
	clientListenPort := 0
	if payload.Role == "Ingress" {
		clientPrivateKey, clientPublicKey, err = generateWireGuardKeyPair()
		if err != nil {
			return localMaterial{}, err
		}
		clientListenPort, err = chooseUDPPort()
		if err != nil {
			return localMaterial{}, err
		}
	}
	transitPrivateKey, transitPublicKey, err := generateWireGuardKeyPair()
	if err != nil {
		return localMaterial{}, err
	}
	transitListenPort, err := chooseUDPPort()
	if err != nil {
		return localMaterial{}, err
	}
	doubleZeroAddress, err := localIPv4("doublezero0")
	if err != nil {
		return localMaterial{}, err
	}

	handle := "hs-assignment-" + payload.AssignmentID
	short := shortAssignmentID(payload.AssignmentID)
	interfaces := materialInterfaces{Transit: "hst" + roleSuffix(payload.Role) + short}
	if payload.Role == "Ingress" {
		interfaces.Client = "hsc" + short
	}
	material := localMaterial{
		AssignmentID:      payload.AssignmentID,
		Role:              payload.Role,
		Handle:            handle,
		DoubleZeroAddress: doubleZeroAddress,
		Interfaces:        interfaces,
		WireGuard: materialWireGuard{
			ClientPublicKey:   clientPublicKey,
			ClientListenPort:  clientListenPort,
			TransitPublicKey:  transitPublicKey,
			TransitListenPort: transitListenPort,
		},
	}
	state := assignmentState{
		AssignmentID:      payload.AssignmentID,
		Role:              payload.Role,
		Handle:            handle,
		SessionID:         payload.Plan.PublicMaterial.SessionID,
		SourceCidr:        readMapString(payload.Plan.FirewallModel, "sourceCidr"),
		ClientAddress:     payload.Plan.PublicMaterial.ClientAddress,
		DestinationCidrs:  payload.Plan.PublicMaterial.DestinationCidrs,
		RoutingTable:      routingTable(payload.AssignmentID),
		RulePriority:      rulePriority(payload.AssignmentID),
		ClientPrivateKey:  clientPrivateKey,
		TransitPrivateKey: transitPrivateKey,
		Material:          material,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeAssignmentState(cfg, state); err != nil {
		return localMaterial{}, err
	}
	return material, nil
}

func commitAssignment(cfg config, payload assignmentPayload) (assignmentState, error) {
	state, err := readAssignmentState(cfg, payload.AssignmentID)
	if err != nil {
		return state, fmt.Errorf("assignment must be prepared before commit: %w", err)
	}
	if err := runCommand("sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return state, err
	}
	if err := ensureNftBase(); err != nil {
		return state, err
	}
	deleteNftRules("inet", "hyperspace", "input", state.Handle)
	deleteNftRules("inet", "hyperspace", "forward", state.Handle)
	deleteNftRules("ip", "hyperspace_nat", "postrouting", state.Handle)

	if state.Role == "Ingress" {
		return state, commitIngress(state, payload.NetworkPlan)
	}
	if state.Role == "Egress" {
		return state, commitEgress(state, payload.NetworkPlan)
	}
	return state, fmt.Errorf("unsupported role %q", state.Role)
}

func commitIngress(state assignmentState, plan networkPlan) error {
	pm := plan.PublicMaterial
	if pm.ClientPublicKey == "" {
		return errors.New("client public key is required for ingress commit")
	}
	egress := plan.Egress.LocalMaterial
	if egress.WireGuard.TransitPublicKey == "" || plan.Egress.PublicIPv4 == "" || egress.WireGuard.TransitListenPort == 0 {
		return errors.New("egress transit material is incomplete")
	}
	mtu := pm.MTU
	if mtu == 0 {
		mtu = 1420
	}
	keepalive := pm.PersistentKeepaliveSeconds
	if keepalive == 0 {
		keepalive = 25
	}
	if err := configureWireGuardInterface(wgInterfaceConfig{
		Name:       state.Material.Interfaces.Client,
		PrivateKey: state.ClientPrivateKey,
		ListenPort: state.Material.WireGuard.ClientListenPort,
		MTU:        mtu,
		Peers: []wgPeer{{
			PublicKey:           pm.ClientPublicKey,
			AllowedIPs:          []string{pm.ClientAddress},
			PersistentKeepalive: keepalive,
		}},
	}); err != nil {
		return err
	}
	if state.SourceCidr != "" {
		if err := runCommand("nft", "add", "rule", "inet", "hyperspace", "input", "udp", "dport", strconv.Itoa(state.Material.WireGuard.ClientListenPort), "ip", "saddr", "!=", state.SourceCidr, "counter", "drop", "comment", state.Handle); err != nil {
			return err
		}
	}
	if err := configureWireGuardInterface(wgInterfaceConfig{
		Name:       state.Material.Interfaces.Transit,
		PrivateKey: state.TransitPrivateKey,
		ListenPort: state.Material.WireGuard.TransitListenPort,
		MTU:        mtu,
		Peers: []wgPeer{{
			PublicKey:           egress.WireGuard.TransitPublicKey,
			AllowedIPs:          pm.DestinationCidrs,
			Endpoint:            net.JoinHostPort(plan.Egress.PublicIPv4, strconv.Itoa(egress.WireGuard.TransitListenPort)),
			PersistentKeepalive: keepalive,
		}},
	}); err != nil {
		return err
	}
	if err := runCommand("ip", "route", "replace", pm.ClientAddress, "dev", state.Material.Interfaces.Client); err != nil {
		return err
	}
	for _, cidr := range pm.DestinationCidrs {
		if err := runCommand("ip", "route", "replace", cidr, "dev", state.Material.Interfaces.Transit, "table", strconv.Itoa(state.RoutingTable)); err != nil {
			return err
		}
	}
	deleteIPRule(pm.ClientAddress, state.RoutingTable, state.RulePriority)
	if err := runCommand("ip", "rule", "add", "from", pm.ClientAddress, "table", strconv.Itoa(state.RoutingTable), "priority", strconv.Itoa(state.RulePriority)); err != nil {
		return err
	}
	if err := runCommand("nft", "add", "rule", "inet", "hyperspace", "forward", "iifname", state.Material.Interfaces.Client, "oifname", state.Material.Interfaces.Transit, "counter", "accept", "comment", state.Handle); err != nil {
		return err
	}
	return runCommand("nft", "add", "rule", "inet", "hyperspace", "forward", "iifname", state.Material.Interfaces.Transit, "oifname", state.Material.Interfaces.Client, "counter", "accept", "comment", state.Handle)
}

func commitEgress(state assignmentState, plan networkPlan) error {
	pm := plan.PublicMaterial
	ingress := plan.Ingress.LocalMaterial
	if ingress.WireGuard.TransitPublicKey == "" || plan.Ingress.PublicIPv4 == "" || ingress.WireGuard.TransitListenPort == 0 {
		return errors.New("ingress transit material is incomplete")
	}
	defaultIface, err := defaultRouteInterface()
	if err != nil {
		return err
	}
	mtu := pm.MTU
	if mtu == 0 {
		mtu = 1420
	}
	keepalive := pm.PersistentKeepaliveSeconds
	if keepalive == 0 {
		keepalive = 25
	}
	if err := configureWireGuardInterface(wgInterfaceConfig{
		Name:       state.Material.Interfaces.Transit,
		PrivateKey: state.TransitPrivateKey,
		ListenPort: state.Material.WireGuard.TransitListenPort,
		MTU:        mtu,
		Peers: []wgPeer{{
			PublicKey:           ingress.WireGuard.TransitPublicKey,
			AllowedIPs:          []string{pm.ClientAddress},
			Endpoint:            net.JoinHostPort(plan.Ingress.PublicIPv4, strconv.Itoa(ingress.WireGuard.TransitListenPort)),
			PersistentKeepalive: keepalive,
		}},
	}); err != nil {
		return err
	}
	if err := runCommand("ip", "route", "replace", pm.ClientAddress, "dev", state.Material.Interfaces.Transit); err != nil {
		return err
	}
	if err := runCommand("nft", "add", "rule", "inet", "hyperspace", "forward", "iifname", state.Material.Interfaces.Transit, "oifname", defaultIface, "counter", "accept", "comment", state.Handle); err != nil {
		return err
	}
	if err := runCommand("nft", "add", "rule", "inet", "hyperspace", "forward", "iifname", defaultIface, "oifname", state.Material.Interfaces.Transit, "counter", "accept", "comment", state.Handle); err != nil {
		return err
	}
	return runCommand("nft", "add", "rule", "ip", "hyperspace_nat", "postrouting", "oifname", defaultIface, "ip", "saddr", pm.ClientAddress, "counter", "masquerade", "comment", state.Handle)
}

func sendHeartbeat(client *http.Client, cfg config) error {
	doubleZero := doubleZeroStatus()
	body := map[string]any{
		"gateId":           cfg.GateName,
		"agentVersion":     version,
		"bootId":           bootID(),
		"observedEndpoint": hostname(),
		"doubleZero":       doubleZero,
		"capabilities": []string{
			"heartbeat",
			"job-claim",
			"actual-state-report",
			"host-mutation:" + cfg.ExecutionMode,
			"wireguard-tools:" + commandState("wg"),
			"iproute2:" + commandState("ip"),
			"nft:" + commandState("nft"),
			"doublezero0:" + linkState("doublezero0"),
		},
		"reportedAt": time.Now().UTC().Format(time.RFC3339),
	}
	return postJSON(client, cfg, "/v1/gate/heartbeat", body, nil)
}

func sendActualState(client *http.Client, cfg config) error {
	body := map[string]any{
		"gateId":         cfg.GateName,
		"bootId":         bootID(),
		"agentVersion":   version,
		"stateHash":      actualStateHash(),
		"managedHandles": managedHandles(cfg),
		"capabilities": []string{
			"actual-state-report",
			"host-mutation:" + cfg.ExecutionMode,
			"doublezero0:" + linkState("doublezero0"),
		},
		"reportedAt": time.Now().UTC().Format(time.RFC3339),
	}
	return postJSON(client, cfg, "/v1/gate/actual-state", body, nil)
}

func claimJob(client *http.Client, cfg config) (*job, error) {
	var response claimResponse
	if err := postJSON(client, cfg, "/v1/gate/jobs/claim", map[string]any{}, &response); err != nil {
		return nil, err
	}
	return response.Job, nil
}

func reportJob(client *http.Client, cfg config, jobID string, result jobResult) error {
	return postJSON(client, cfg, "/v1/gate/jobs/"+jobID+"/report", result, nil)
}

func postJSON(client *http.Client, cfg config, path string, payload any, out any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", strings.TrimRight(cfg.ControlPlaneURL, "/")+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-gate-name", cfg.GateName)
	req.Header.Set("x-gate-token", cfg.GateToken)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("control-plane returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	if out != nil && len(body) > 0 {
		return json.Unmarshal(body, out)
	}
	return nil
}

func readConfig() (config, error) {
	controlPlaneURL := os.Getenv("CONTROL_PLANE_URL")
	gateName := os.Getenv("GATE_NAME")
	gateToken := os.Getenv("GATE_TOKEN")
	if controlPlaneURL == "" || gateName == "" || gateToken == "" {
		return config{}, errors.New("CONTROL_PLANE_URL, GATE_NAME, and GATE_TOKEN are required")
	}
	return config{
		ControlPlaneURL:   controlPlaneURL,
		GateName:          gateName,
		GateToken:         gateToken,
		PollInterval:      durationEnv("POLL_INTERVAL", 2*time.Second),
		HeartbeatInterval: durationEnv("HEARTBEAT_INTERVAL", 10*time.Second),
		ExecutionMode:     stringEnv("GATE_AGENT_EXECUTION_MODE", "observe"),
		StateDir:          stringEnv("GATE_AGENT_STATE_DIR", "/var/lib/hyperspace-gate"),
	}, nil
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func stringEnv(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}

func actualStateHash() string {
	parts := []string{
		bootID(),
		commandOutput("ip", "-br", "link", "show", "doublezero0"),
		commandOutput("wg", "show"),
		commandOutput("nft", "list", "ruleset"),
	}
	hash := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(hash[:])
}

func bootID() string {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

func commandState(name string) string {
	if _, err := exec.LookPath(name); err != nil {
		return "missing"
	}
	return "present"
}

func linkState(name string) string {
	output := commandOutput("ip", "-br", "link", "show", name)
	if output == "" {
		return "missing"
	}
	if strings.Contains(output, "UP") {
		return "up"
	}
	return "present"
}

func commandOutput(name string, args ...string) string {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func commandOutputTimeout(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return strings.TrimSpace(string(output)), ctx.Err()
	}
	return strings.TrimSpace(string(output)), err
}

func doubleZeroStatus() map[string]any {
	now := time.Now().UTC().Format(time.RFC3339)
	output, err := commandOutputTimeout(4*time.Second, "doublezero", "status")
	if err != nil {
		status := map[string]any{
			"reportedAt": now,
			"error":      err.Error(),
		}
		if output != "" {
			status["raw"] = output
		}
		return status
	}
	parsed := parseDoubleZeroStatus(output)
	parsed["reportedAt"] = now
	return parsed
}

func parseDoubleZeroStatus(output string) map[string]any {
	lines := strings.Split(output, "\n")
	for index := 0; index+1 < len(lines); index++ {
		headers := splitStatusTableLine(lines[index])
		values := splitStatusTableLine(lines[index+1])
		if len(headers) == 0 || len(values) == 0 {
			continue
		}
		row := map[string]string{}
		for columnIndex, header := range headers {
			if columnIndex >= len(values) {
				break
			}
			row[header] = values[columnIndex]
		}
		if _, ok := row["Current Device"]; !ok {
			continue
		}
		status := map[string]any{}
		copyDoubleZeroField(status, row, "Tunnel Status", "tunnelStatus")
		copyDoubleZeroField(status, row, "Last Session Update", "lastSessionUpdate")
		copyDoubleZeroField(status, row, "Tunnel Name", "tunnelName")
		copyDoubleZeroField(status, row, "Tunnel Src", "tunnelSrc")
		copyDoubleZeroField(status, row, "Tunnel Dst", "tunnelDst")
		copyDoubleZeroField(status, row, "Doublezero IP", "doubleZeroIp")
		copyDoubleZeroField(status, row, "User Type", "userType")
		copyDoubleZeroField(status, row, "Reconciler", "reconciler")
		copyDoubleZeroField(status, row, "Tenant", "tenant")
		copyDoubleZeroField(status, row, "Current Device", "currentDevice")
		copyDoubleZeroLatencyDevice(status, row, "Lowest Latency Device")
		copyDoubleZeroField(status, row, "Metro", "metro")
		copyDoubleZeroField(status, row, "Network", "network")
		return status
	}
	return map[string]any{
		"error": "doublezero status output did not contain a Current Device table",
		"raw":   output,
	}
}

func splitStatusTableLine(line string) []string {
	parts := strings.Split(line, "|")
	cells := make([]string, 0, len(parts))
	for _, part := range parts {
		cell := strings.TrimSpace(part)
		if cell == "" && len(cells) == 0 {
			continue
		}
		cells = append(cells, cell)
	}
	return cells
}

func copyDoubleZeroField(target map[string]any, source map[string]string, sourceKey string, targetKey string) {
	value := strings.TrimSpace(source[sourceKey])
	if value != "" {
		target[targetKey] = value
	}
}

func copyDoubleZeroLatencyDevice(target map[string]any, source map[string]string, sourceKey string) {
	value := strings.TrimSpace(source[sourceKey])
	if value == "" {
		return
	}
	device, warning := parseDoubleZeroLatencyDevice(value)
	if device != "" {
		target["lowestLatencyDevice"] = device
	}
	if warning != nil {
		target["lowestLatencyDeviceWarning"] = *warning
	}
}

func parseDoubleZeroLatencyDevice(value string) (string, *bool) {
	cleaned := strings.TrimSpace(value)
	if strings.HasPrefix(cleaned, "✅") {
		warning := false
		return strings.TrimSpace(strings.TrimPrefix(cleaned, "✅")), &warning
	}
	if strings.HasPrefix(cleaned, "⚠️") {
		warning := true
		return strings.TrimSpace(strings.TrimPrefix(cleaned, "⚠️")), &warning
	}
	if strings.HasPrefix(cleaned, "⚠") {
		warning := true
		return strings.TrimSpace(strings.TrimPrefix(cleaned, "⚠")), &warning
	}
	return cleaned, nil
}

type wgInterfaceConfig struct {
	Name       string
	PrivateKey string
	ListenPort int
	MTU        int
	Peers      []wgPeer
}

type wgPeer struct {
	PublicKey           string
	AllowedIPs          []string
	Endpoint            string
	PersistentKeepalive int
}

func configureWireGuardInterface(input wgInterfaceConfig) error {
	if input.Name == "" || input.PrivateKey == "" || input.ListenPort == 0 {
		return errors.New("wireguard interface config is incomplete")
	}
	runIgnore("ip", "link", "delete", "dev", input.Name)
	if err := runCommand("ip", "link", "add", "dev", input.Name, "type", "wireguard"); err != nil {
		return err
	}
	privateKeyFile, cleanup, err := writeTempPrivateKey(input.PrivateKey)
	if err != nil {
		return err
	}
	defer cleanup()

	args := []string{"set", input.Name, "private-key", privateKeyFile, "listen-port", strconv.Itoa(input.ListenPort)}
	for _, peer := range input.Peers {
		if peer.PublicKey == "" || len(peer.AllowedIPs) == 0 {
			return errors.New("wireguard peer config is incomplete")
		}
		args = append(args, "peer", peer.PublicKey, "allowed-ips", strings.Join(peer.AllowedIPs, ","))
		if peer.Endpoint != "" {
			args = append(args, "endpoint", peer.Endpoint)
		}
		if peer.PersistentKeepalive > 0 {
			args = append(args, "persistent-keepalive", strconv.Itoa(peer.PersistentKeepalive))
		}
	}
	if err := runCommand("wg", args...); err != nil {
		return err
	}
	if input.MTU > 0 {
		if err := runCommand("ip", "link", "set", "dev", input.Name, "mtu", strconv.Itoa(input.MTU)); err != nil {
			return err
		}
	}
	return runCommand("ip", "link", "set", "up", "dev", input.Name)
}

func writeTempPrivateKey(privateKey string) (string, func(), error) {
	file, err := os.CreateTemp("", "hyperspace-wg-key-*")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	cleanup := func() {
		_ = os.Remove(path)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	if _, err := file.WriteString(privateKey + "\n"); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return path, cleanup, nil
}

func revokeAssignment(cfg config, payload assignmentPayload) error {
	state, err := readAssignmentState(cfg, payload.AssignmentID)
	if err != nil {
		state = derivedAssignmentState(payload.AssignmentID, payload.Role)
	}
	deleteNftRules("inet", "hyperspace", "input", state.Handle)
	deleteNftRules("inet", "hyperspace", "forward", state.Handle)
	deleteNftRules("ip", "hyperspace_nat", "postrouting", state.Handle)
	if state.ClientAddress != "" {
		deleteIPRule(state.ClientAddress, state.RoutingTable, state.RulePriority)
		runIgnore("ip", "route", "del", state.ClientAddress, "dev", state.Material.Interfaces.Client)
		runIgnore("ip", "route", "del", state.ClientAddress, "dev", state.Material.Interfaces.Transit)
		for _, cidr := range state.DestinationCidrs {
			runIgnore("ip", "route", "del", cidr, "dev", state.Material.Interfaces.Transit, "table", strconv.Itoa(state.RoutingTable))
		}
	}
	if state.Material.Interfaces.Client != "" {
		runIgnore("ip", "link", "delete", "dev", state.Material.Interfaces.Client)
	}
	if state.Material.Interfaces.Transit != "" {
		runIgnore("ip", "link", "delete", "dev", state.Material.Interfaces.Transit)
	}
	return os.RemoveAll(assignmentDir(cfg, payload.AssignmentID))
}

func derivedAssignmentState(assignmentID string, role string) assignmentState {
	short := shortAssignmentID(assignmentID)
	interfaces := materialInterfaces{Transit: "hst" + roleSuffix(role) + short}
	if role == "Ingress" || role == "" {
		interfaces.Client = "hsc" + short
	}
	return assignmentState{
		AssignmentID: assignmentID,
		Role:         role,
		Handle:       "hs-assignment-" + assignmentID,
		RoutingTable: routingTable(assignmentID),
		RulePriority: rulePriority(assignmentID),
		Material: localMaterial{
			AssignmentID: assignmentID,
			Role:         role,
			Handle:       "hs-assignment-" + assignmentID,
			Interfaces:   interfaces,
		},
	}
}

func ensureNftBase() error {
	runIgnore("nft", "add", "table", "inet", "hyperspace")
	runIgnore("nft", "add", "chain", "inet", "hyperspace", "input", "{", "type", "filter", "hook", "input", "priority", "0", ";", "policy", "accept", ";", "}")
	runIgnore("nft", "add", "chain", "inet", "hyperspace", "forward", "{", "type", "filter", "hook", "forward", "priority", "0", ";", "policy", "accept", ";", "}")
	runIgnore("nft", "add", "table", "ip", "hyperspace_nat")
	runIgnore("nft", "add", "chain", "ip", "hyperspace_nat", "postrouting", "{", "type", "nat", "hook", "postrouting", "priority", "srcnat", ";", "policy", "accept", ";", "}")
	return nil
}

func deleteNftRules(family string, table string, chain string, comment string) {
	if comment == "" {
		return
	}
	output := commandOutput("nft", "-a", "list", "chain", family, table, chain)
	if output == "" {
		return
	}
	handlePattern := regexp.MustCompile(`handle ([0-9]+)`)
	for _, line := range strings.Split(output, "\n") {
		if !strings.Contains(line, `comment "`+comment+`"`) && !strings.Contains(line, "comment "+comment) {
			continue
		}
		match := handlePattern.FindStringSubmatch(line)
		if len(match) != 2 {
			continue
		}
		runIgnore("nft", "delete", "rule", family, table, chain, "handle", match[1])
	}
}

func deleteIPRule(clientAddress string, table int, priority int) {
	if clientAddress == "" || table == 0 || priority == 0 {
		return
	}
	for {
		err := runCommand("ip", "rule", "del", "from", clientAddress, "table", strconv.Itoa(table), "priority", strconv.Itoa(priority))
		if err != nil {
			return
		}
	}
}

func generateWireGuardKeyPair() (string, string, error) {
	privateKey, err := commandOutputRequired("wg", "genkey")
	if err != nil {
		return "", "", err
	}
	publicKey, err := commandOutputInput(privateKey+"\n", "wg", "pubkey")
	if err != nil {
		return "", "", err
	}
	return privateKey, publicKey, nil
}

func chooseUDPPort() (int, error) {
	listener, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	addr, ok := listener.LocalAddr().(*net.UDPAddr)
	if !ok {
		return 0, errors.New("unexpected udp listener address")
	}
	return addr.Port, nil
}

func localIPv4(interfaceName string) (string, error) {
	output, err := commandOutputRequired("ip", "-4", "-o", "addr", "show", "dev", interfaceName)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(output)
	for index, field := range fields {
		if field == "inet" && index+1 < len(fields) {
			return strings.Split(fields[index+1], "/")[0], nil
		}
	}
	return "", fmt.Errorf("no ipv4 address found on %s", interfaceName)
}

func defaultRouteInterface() (string, error) {
	output, err := commandOutputRequired("ip", "route", "show", "default")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(output)
	for index, field := range fields {
		if field == "dev" && index+1 < len(fields) {
			return fields[index+1], nil
		}
	}
	return "", errors.New("default route interface not found")
}

func readMapString(values map[string]any, key string) string {
	value, ok := values[key]
	if !ok || value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func readAssignmentState(cfg config, assignmentID string) (assignmentState, error) {
	var state assignmentState
	data, err := os.ReadFile(assignmentStatePath(cfg, assignmentID))
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	return state, nil
}

func writeAssignmentState(cfg config, state assignmentState) error {
	dir := assignmentDir(cfg, state.AssignmentID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "assignment.json"), encoded, 0o600)
}

func managedHandles(cfg config) []string {
	root := filepath.Join(cfg.StateDir, "assignments")
	entries, err := os.ReadDir(root)
	if err != nil {
		return []string{}
	}
	handles := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		state, err := readAssignmentState(cfg, entry.Name())
		if err != nil || state.Handle == "" {
			continue
		}
		handles = append(handles, state.Handle)
	}
	return handles
}

func assignmentDir(cfg config, assignmentID string) string {
	return filepath.Join(cfg.StateDir, "assignments", assignmentID)
}

func assignmentStatePath(cfg config, assignmentID string) string {
	return filepath.Join(assignmentDir(cfg, assignmentID), "assignment.json")
}

func shortAssignmentID(assignmentID string) string {
	cleaned := strings.ReplaceAll(assignmentID, "-", "")
	if len(cleaned) > 10 {
		return cleaned[:10]
	}
	return cleaned
}

func roleSuffix(role string) string {
	if role == "Egress" {
		return "e"
	}
	return "i"
}

func routingTable(assignmentID string) int {
	sum := sha256.Sum256([]byte(assignmentID + ":table"))
	return 20000 + (((int(sum[0]) << 8) + int(sum[1])) % 20000)
}

func rulePriority(assignmentID string) int {
	sum := sha256.Sum256([]byte(assignmentID + ":priority"))
	return 10000 + ((int(sum[0])<<8)+int(sum[1]))%15000
}

func runCommand(name string, args ...string) error {
	_, err := commandOutputRequired(name, args...)
	return err
}

func runIgnore(name string, args ...string) {
	_ = runCommand(name, args...)
}

func commandOutputRequired(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func commandOutputInput(input string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func retryable(code string, err error) jobResult {
	return jobResult{
		Status:    "retryable_failed",
		ErrorCode: code,
		ResultSummary: map[string]any{
			"error": err.Error(),
		},
	}
}

func failed(code string, err error) jobResult {
	return jobResult{
		Status:    "failed",
		ErrorCode: code,
		ResultSummary: map[string]any{
			"error": err.Error(),
		},
	}
}

func logJSON(event string, fields map[string]any) {
	fields["event"] = event
	fields["now"] = time.Now().UTC().Format(time.RFC3339)
	encoded, _ := json.Marshal(fields)
	fmt.Println(string(encoded))
}

func sleep(duration time.Duration) {
	time.Sleep(duration)
}

func fatal(err error) {
	logJSON("agent_fatal", map[string]any{"error": err.Error()})
	os.Exit(1)
}
