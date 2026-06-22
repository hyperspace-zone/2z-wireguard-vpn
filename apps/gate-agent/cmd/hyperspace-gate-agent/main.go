package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.1.4"

var defaultNTPDiscoveryHosts = []string{
	"0.pool.ntp.org",
	"1.pool.ntp.org",
	"2.pool.ntp.org",
	"3.pool.ntp.org",
	"0.es.pool.ntp.org",
	"1.es.pool.ntp.org",
	"2.es.pool.ntp.org",
	"3.es.pool.ntp.org",
	"es.pool.ntp.org",
	"0.asia.pool.ntp.org",
	"1.asia.pool.ntp.org",
	"2.asia.pool.ntp.org",
	"3.asia.pool.ntp.org",
	"0.europe.pool.ntp.org",
	"1.europe.pool.ntp.org",
	"2.europe.pool.ntp.org",
	"3.europe.pool.ntp.org",
	"europe.pool.ntp.org",
	"0.north-america.pool.ntp.org",
	"1.north-america.pool.ntp.org",
	"2.north-america.pool.ntp.org",
	"3.north-america.pool.ntp.org",
	"time.cloudflare.com",
	"time.google.com",
	"time.aws.com",
	"time.facebook.com",
	"time.euro.apple.com",
	"time.esa.int",
	"time1.esa.int",
	"ntp.ripe.net",
	"ptbtime1.ptb.de",
	"ptbtime2.ptb.de",
	"ntp1.inrim.it",
	"ntp2.inrim.it",
	"ntppool1.time.nl",
	"ntppool2.time.nl",
	"ntp.vsl.nl",
	"ntp.neel.ch",
	"hora.roa.es",
	"minuto.roa.es",
	"tick.espanix.net",
	"tock.espanix.net",
	"ntp.i2t.ehu.eus",
	"pt.pool.ntp.org",
	"fr.pool.ntp.org",
	"it.pool.ntp.org",
	"nl.pool.ntp.org",
	"de.pool.ntp.org",
}

type config struct {
	ControlPlaneURL    string
	GateName           string
	GateToken          string
	PollInterval       time.Duration
	HeartbeatInterval  time.Duration
	ExecutionMode      string
	StateDir           string
	ProbeListenAddress string
	ProbePort          int
	ProbeSharedSecret  string
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
	var probeManager *probeServerManager
	if cfg.ProbePort > 0 {
		probeManager = newProbeServerManager(cfg)
		probeManager.Start()
	}

	client := &http.Client{Timeout: 20 * time.Second}
	logJSON("agent_started", map[string]any{
		"gate":          cfg.GateName,
		"version":       version,
		"executionMode": cfg.ExecutionMode,
		"stateDir":      cfg.StateDir,
		"probePort":     cfg.ProbePort,
	})

	lastHeartbeat := time.Time{}
	for {
		if time.Since(lastHeartbeat) >= cfg.HeartbeatInterval {
			if err := sendHeartbeat(client, cfg, probeManager); err != nil {
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
	case "probe":
		return executeProbeJob(cfg, item)
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

const probeMagic = "hyperspace-gate-probe-v1"
const soReusePort = 0x0F
const probeServerSyncInterval = 2 * time.Second
const oneWayClockSyncMaxOffsetSeconds = 0.002
const clockSyncCacheTTL = 5 * time.Second

var clockSyncCache = struct {
	mu           sync.Mutex
	checkedAt    time.Time
	reliable     bool
	clockErrorMs float64
	clockErrorOK bool
}{
	checkedAt: time.Time{},
}

type probeServerBinding struct {
	Transport string
	Interface string
	IfIndex   int
}

type managedProbeListener struct {
	Binding   probeServerBinding
	Conn      net.PacketConn
	Ready     bool
	LastError string
	StartedAt time.Time
	UpdatedAt time.Time
}

type probeServerManager struct {
	cfg       config
	addr      string
	interval  time.Duration
	mu        sync.RWMutex
	listeners map[string]*managedProbeListener
}

type probeJobPayload struct {
	Kind             string                 `json:"kind"`
	SourceGateID     string                 `json:"sourceGateId"`
	SourceGateName   string                 `json:"sourceGateName"`
	TargetGateID     string                 `json:"targetGateId"`
	TargetGateName   string                 `json:"targetGateName"`
	TargetPublicIPv4 string                 `json:"targetPublicIpv4"`
	TargetProbePort  int                    `json:"targetProbePort"`
	Count            int                    `json:"count"`
	IntervalMs       int                    `json:"intervalMs"`
	TimeoutMs        int                    `json:"timeoutMs"`
	Transports       []probeTransportConfig `json:"transports"`
}

type probeTransportConfig struct {
	Name      string `json:"name"`
	Interface string `json:"interface"`
}

type probePacket struct {
	Magic                string `json:"magic"`
	SourceGate           string `json:"sourceGate"`
	TargetGate           string `json:"targetGate,omitempty"`
	Nonce                string `json:"nonce"`
	Seq                  int    `json:"seq"`
	ClientTxWallUnixNano int64  `json:"clientTxWallUnixNano"`
	ServerRxWallUnixNano int64  `json:"serverRxWallUnixNano,omitempty"`
	ServerTxWallUnixNano int64  `json:"serverTxWallUnixNano,omitempty"`
	ServerObservedRemote string `json:"serverObservedRemote,omitempty"`
	HMAC                 string `json:"hmac,omitempty"`
}

type probeSample struct {
	Seq                int      `json:"seq"`
	RTTMs              float64  `json:"rttMs"`
	ForwardOneWayMs    *float64 `json:"forwardOneWayMs,omitempty"`
	ReverseOneWayMs    *float64 `json:"reverseOneWayMs,omitempty"`
	SourceClockErrorMs *float64 `json:"sourceClockErrorMs,omitempty"`
	TargetClockErrorMs *float64 `json:"targetClockErrorMs,omitempty"`
	ClockErrorMs       *float64 `json:"clockErrorMs,omitempty"`
}

type probeMetricSummary struct {
	Min float64 `json:"min,omitempty"`
	P50 float64 `json:"p50,omitempty"`
	P95 float64 `json:"p95,omitempty"`
	Max float64 `json:"max,omitempty"`
}

type probeTransportResult struct {
	Transport          string             `json:"transport"`
	Status             string             `json:"status"`
	SourceInterface    string             `json:"sourceInterface,omitempty"`
	TargetEndpoint     string             `json:"targetEndpoint,omitempty"`
	PacketCount        int                `json:"packetCount"`
	PacketsReceived    int                `json:"packetsReceived"`
	LossPercent        float64            `json:"lossPercent"`
	RTTMs              probeMetricSummary `json:"rttMs,omitempty"`
	JitterMs           float64            `json:"jitterMs,omitempty"`
	ForwardOneWayMs    probeMetricSummary `json:"forwardOneWayMs,omitempty"`
	ReverseOneWayMs    probeMetricSummary `json:"reverseOneWayMs,omitempty"`
	OneWayClockErrorMs float64            `json:"oneWayClockErrorMs,omitempty"`
	Samples            []probeSample      `json:"samples,omitempty"`
	Chrony             map[string]any     `json:"chrony,omitempty"`
	MeasuredAt         string             `json:"measuredAt"`
	ErrorCode          string             `json:"errorCode,omitempty"`
	ErrorMessage       string             `json:"errorMessage,omitempty"`
}

type probeJobKindPayload struct {
	Kind string `json:"kind"`
}

type ntpDiscoveryPayload struct {
	Kind          string   `json:"kind"`
	GateID        string   `json:"gateId"`
	GateName      string   `json:"gateName"`
	SampleSeconds int      `json:"sampleSeconds"`
	MaxCandidates int      `json:"maxCandidates"`
	Hosts         []string `json:"hosts"`
}

type ntpDiscoveryCandidate struct {
	Address               string   `json:"address"`
	Names                 []string `json:"names"`
	Stratum               int      `json:"stratum"`
	RootDelayMs           float64  `json:"rootDelayMs"`
	RootDispersionMs      float64  `json:"rootDispersionMs"`
	PeerDelayMs           float64  `json:"peerDelayMs"`
	OffsetFromCurrentMs   float64  `json:"offsetFromCurrentMs"`
	EstimatedClockErrorMs float64  `json:"estimatedClockErrorMs"`
	GoodSamples           int      `json:"goodSamples"`
}

func executeProbeJob(cfg config, item job) jobResult {
	kind, err := decodeProbeJobKind(item)
	if err != nil {
		return failed("invalid_probe_payload", err)
	}
	if kind == "gate_ntp_discovery_v1" {
		return executeNTPDiscoveryJob(item)
	}
	if kind != "gate_benchmark_v1" {
		return failed("invalid_probe_payload", fmt.Errorf("unsupported probe kind %q", kind))
	}
	payload, err := decodeProbePayload(item)
	if err != nil {
		return failed("invalid_probe_payload", err)
	}
	results := make([]probeTransportResult, 0, len(payload.Transports))
	for _, transport := range payload.Transports {
		result := runProbeTransport(cfg, payload, transport)
		results = append(results, result)
	}
	return jobResult{
		Status:          "succeeded",
		ActualStateHash: actualStateHash(),
		ResultSummary: map[string]any{
			"kind":           "gate_benchmark_v1",
			"sourceGateId":   payload.SourceGateID,
			"sourceGateName": payload.SourceGateName,
			"targetGateId":   payload.TargetGateID,
			"targetGateName": payload.TargetGateName,
			"results":        results,
		},
	}
}

func decodeProbeJobKind(item job) (string, error) {
	var payload probeJobKindPayload
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return "", err
	}
	if payload.Kind == "" {
		return "", errors.New("probe kind is required")
	}
	return payload.Kind, nil
}

func decodeProbePayload(item job) (probeJobPayload, error) {
	var payload probeJobPayload
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return payload, err
	}
	if payload.Kind != "gate_benchmark_v1" {
		return payload, fmt.Errorf("unsupported probe kind %q", payload.Kind)
	}
	if payload.TargetGateID == "" || payload.TargetGateName == "" || payload.TargetPublicIPv4 == "" {
		return payload, errors.New("target gate fields are required")
	}
	if payload.TargetProbePort == 0 {
		payload.TargetProbePort = cfgDefaultProbePort()
	}
	if payload.Count <= 0 {
		payload.Count = 10
	}
	if payload.IntervalMs <= 0 {
		payload.IntervalMs = 100
	}
	if payload.TimeoutMs <= 0 {
		payload.TimeoutMs = 1000
	}
	if len(payload.Transports) == 0 {
		payload.Transports = []probeTransportConfig{
			{Name: "public", Interface: "public"},
			{Name: "doublezero", Interface: "doublezero0"},
		}
	}
	return payload, nil
}

func cfgDefaultProbePort() int {
	return 19192
}

func executeNTPDiscoveryJob(item job) jobResult {
	payload, err := decodeNTPDiscoveryPayload(item)
	if err != nil {
		return failed("invalid_ntp_discovery_payload", err)
	}
	measuredAt := time.Now().UTC().Format(time.RFC3339Nano)
	currentChrony := chronyTrackingSummary()
	currentClockErrorMs, currentClockErrorOK := chronyClockErrorMs(currentChrony)
	currentSources := chronySourceAddresses()
	candidatesByAddress := resolveNTPDiscoveryCandidates(payload.GateName, payload.Hosts, payload.MaxCandidates, currentSources)
	added := make([]string, 0, len(candidatesByAddress))
	for address := range candidatesByAddress {
		if err := runCommand("chronyc", "add", "server", address, "iburst", "minpoll", "4", "maxpoll", "4", "noselect"); err == nil {
			added = append(added, address)
		}
	}
	defer func() {
		for _, address := range added {
			runIgnore("chronyc", "delete", address)
		}
	}()
	if len(added) > 0 {
		time.Sleep(time.Duration(payload.SampleSeconds) * time.Second)
	}
	candidates := make([]ntpDiscoveryCandidate, 0, len(added))
	for _, address := range added {
		candidate, ok := readNTPDiscoveryCandidate(address, candidatesByAddress[address])
		if ok {
			candidates = append(candidates, candidate)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].EstimatedClockErrorMs == candidates[j].EstimatedClockErrorMs {
			return candidates[i].Address < candidates[j].Address
		}
		return candidates[i].EstimatedClockErrorMs < candidates[j].EstimatedClockErrorMs
	})
	recommendation := map[string]any{}
	if len(candidates) > 0 {
		best := candidates[0]
		improvesCurrent := !currentClockErrorOK || best.EstimatedClockErrorMs < currentClockErrorMs
		recommendation = map[string]any{
			"address":               best.Address,
			"names":                 best.Names,
			"estimatedClockErrorMs": best.EstimatedClockErrorMs,
			"improvesCurrent":       improvesCurrent,
		}
		if currentClockErrorOK {
			recommendation["currentClockErrorMs"] = currentClockErrorMs
			recommendation["estimatedSavingsMs"] = compactFloat(currentClockErrorMs - best.EstimatedClockErrorMs)
		}
	}
	resultCandidates := candidates
	if len(resultCandidates) > 20 {
		resultCandidates = resultCandidates[:20]
	}
	summary := map[string]any{
		"kind":                   "gate_ntp_discovery_v1",
		"gateId":                 payload.GateID,
		"gateName":               payload.GateName,
		"measuredAt":             measuredAt,
		"sampleSeconds":          payload.SampleSeconds,
		"maxCandidates":          payload.MaxCandidates,
		"resolvedCandidateCount": len(candidatesByAddress),
		"sampledCandidateCount":  len(added),
		"validCandidateCount":    len(candidates),
		"currentChrony":          currentChrony,
		"recommendation":         recommendation,
		"candidates":             resultCandidates,
		"note":                   "Candidates are sampled with chronyc noselect. The agent does not mutate chrony configuration or switch system time sources.",
	}
	if currentClockErrorOK {
		summary["currentClockErrorMs"] = currentClockErrorMs
	}
	return jobResult{
		Status:          "succeeded",
		ActualStateHash: actualStateHash(),
		ResultSummary:   summary,
	}
}

func decodeNTPDiscoveryPayload(item job) (ntpDiscoveryPayload, error) {
	var payload ntpDiscoveryPayload
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return payload, err
	}
	if payload.Kind != "gate_ntp_discovery_v1" {
		return payload, fmt.Errorf("unsupported ntp discovery kind %q", payload.Kind)
	}
	if payload.SampleSeconds <= 0 {
		payload.SampleSeconds = 30
	}
	if payload.SampleSeconds < 10 {
		payload.SampleSeconds = 10
	}
	if payload.SampleSeconds > 120 {
		payload.SampleSeconds = 120
	}
	if payload.MaxCandidates <= 0 {
		payload.MaxCandidates = 96
	}
	if payload.MaxCandidates < 16 {
		payload.MaxCandidates = 16
	}
	if payload.MaxCandidates > 256 {
		payload.MaxCandidates = 256
	}
	return payload, nil
}

func resolveNTPDiscoveryCandidates(gateName string, requestedHosts []string, maxCandidates int, skipAddresses map[string]bool) map[string][]string {
	hosts := dedupeStrings(append(ntpDiscoveryHostsForGate(gateName), requestedHosts...))
	candidates := map[string][]string{}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	for _, host := range hosts {
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ip := address.IP.To4()
			if ip == nil {
				continue
			}
			text := ip.String()
			if skipAddresses[text] {
				continue
			}
			candidates[text] = append(candidates[text], host)
			if len(candidates) >= maxCandidates {
				return candidates
			}
		}
	}
	return candidates
}

func ntpDiscoveryHostsForGate(gateName string) []string {
	hosts := append([]string{}, defaultNTPDiscoveryHosts...)
	cityCountryPools := map[string][]string{
		"ams": {"nl.pool.ntp.org"},
		"chi": {"us.pool.ntp.org"},
		"fra": {"de.pool.ntp.org"},
		"lon": {"uk.pool.ntp.org"},
		"mad": {"es.pool.ntp.org"},
		"nyc": {"us.pool.ntp.org"},
		"osl": {"no.pool.ntp.org"},
		"sjc": {"us.pool.ntp.org"},
		"sia": {"lt.pool.ntp.org"},
		"sin": {"sg.pool.ntp.org"},
		"sto": {"se.pool.ntp.org"},
		"tyo": {"jp.pool.ntp.org"},
	}
	for token, pools := range cityCountryPools {
		if strings.Contains(gateName, "-"+token+"-") {
			for _, pool := range pools {
				hosts = append(hosts, pool, "0."+pool, "1."+pool, "2."+pool, "3."+pool)
			}
		}
	}
	return hosts
}

func chronySourceAddresses() map[string]bool {
	output := commandOutput("chronyc", "-n", "sources")
	addresses := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		for _, field := range strings.Fields(line) {
			ip := net.ParseIP(field)
			if ip != nil && ip.To4() != nil {
				addresses[ip.String()] = true
			}
		}
	}
	return addresses
}

func readNTPDiscoveryCandidate(address string, names []string) (ntpDiscoveryCandidate, bool) {
	output := commandOutput("chronyc", "ntpdata", address)
	if output == "" || strings.Contains(output, "No such source") {
		return ntpDiscoveryCandidate{}, false
	}
	return readNTPDiscoveryCandidateFromOutput(address, names, output)
}

func readNTPDiscoveryCandidateFromOutput(address string, names []string, output string) (ntpDiscoveryCandidate, bool) {
	stratum, ok := chronyDataInt(output, "Stratum")
	if !ok || stratum <= 0 {
		return ntpDiscoveryCandidate{}, false
	}
	goodSamples, ok := chronyDataInt(output, "Total good RX")
	if !ok || goodSamples <= 0 {
		return ntpDiscoveryCandidate{}, false
	}
	rootDelayMs, ok := chronyDataSecondsMs(output, "Root delay")
	if !ok {
		return ntpDiscoveryCandidate{}, false
	}
	rootDispersionMs, ok := chronyDataSecondsMs(output, "Root dispersion")
	if !ok {
		return ntpDiscoveryCandidate{}, false
	}
	peerDelayMs, ok := chronyDataSecondsMs(output, "Peer delay")
	if !ok || peerDelayMs <= 0 {
		return ntpDiscoveryCandidate{}, false
	}
	offsetMs, _ := chronyDataSecondsMs(output, "Offset")
	estimateMs := compactFloat(((rootDelayMs + peerDelayMs) / 2) + rootDispersionMs)
	return ntpDiscoveryCandidate{
		Address:               address,
		Names:                 dedupeStrings(names),
		Stratum:               stratum,
		RootDelayMs:           compactFloat(rootDelayMs),
		RootDispersionMs:      compactFloat(rootDispersionMs),
		PeerDelayMs:           compactFloat(peerDelayMs),
		OffsetFromCurrentMs:   compactFloat(offsetMs),
		EstimatedClockErrorMs: estimateMs,
		GoodSamples:           goodSamples,
	}, true
}

func chronyDataInt(output string, key string) (int, bool) {
	value, ok := chronyDataField(output, key)
	if !ok {
		return 0, false
	}
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 0, false
	}
	parsed, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func chronyDataSecondsMs(output string, key string) (float64, bool) {
	value, ok := chronyDataField(output, key)
	if !ok {
		return 0, false
	}
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, false
	}
	return parsed * 1000, true
}

func chronyDataField(output string, key string) (string, bool) {
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		if strings.TrimSpace(parts[0]) == key {
			return strings.TrimSpace(parts[1]), true
		}
	}
	return "", false
}

func dedupeStrings(values []string) []string {
	seen := map[string]bool{}
	deduped := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		deduped = append(deduped, value)
	}
	return deduped
}

func runProbeTransport(cfg config, payload probeJobPayload, transport probeTransportConfig) probeTransportResult {
	measuredAt := time.Now().UTC().Format(time.RFC3339Nano)
	result := probeTransportResult{
		Transport:      transport.Name,
		Status:         "failed",
		PacketCount:    payload.Count,
		TargetEndpoint: net.JoinHostPort(payload.TargetPublicIPv4, strconv.Itoa(payload.TargetProbePort)),
		Chrony:         chronyTrackingSummary(),
		MeasuredAt:     measuredAt,
	}
	sourceClockSyncOK := chronySummaryReliable(result.Chrony)
	result.Chrony["oneWayClockSyncOk"] = sourceClockSyncOK
	var sourceClockErrorMs *float64
	if clockErrorMs, ok := chronyClockErrorMs(result.Chrony); ok {
		sourceClockErrorMs = float64Ptr(clockErrorMs)
		result.Chrony["clockErrorMs"] = clockErrorMs
	}
	if transport.Name != "public" && transport.Name != "doublezero" {
		result.ErrorCode = "unsupported_transport"
		result.ErrorMessage = fmt.Sprintf("unsupported transport %q", transport.Name)
		return result
	}
	iface, err := resolveProbeInterface(transport.Interface)
	if err != nil {
		result.ErrorCode = "interface_unavailable"
		result.ErrorMessage = err.Error()
		return result
	}
	result.SourceInterface = iface

	target, err := net.ResolveUDPAddr("udp4", result.TargetEndpoint)
	if err != nil {
		result.ErrorCode = "invalid_target"
		result.ErrorMessage = err.Error()
		return result
	}
	conn, err := listenUDPOnInterface(iface)
	if err != nil {
		result.ErrorCode = "socket_bind_failed"
		result.ErrorMessage = err.Error()
		return result
	}
	defer conn.Close()

	samples := make([]probeSample, 0, payload.Count)
	for seq := 1; seq <= payload.Count; seq++ {
		sample, err := runProbeSample(conn, cfg, payload, target, seq, time.Duration(payload.TimeoutMs)*time.Millisecond, sourceClockSyncOK, sourceClockErrorMs)
		if err == nil {
			samples = append(samples, sample)
		}
		if seq < payload.Count {
			time.Sleep(time.Duration(payload.IntervalMs) * time.Millisecond)
		}
	}

	result.Samples = samples
	result.PacketsReceived = len(samples)
	result.LossPercent = compactFloat((float64(payload.Count-len(samples)) / float64(payload.Count)) * 100)
	if len(samples) == 0 {
		result.ErrorCode = "no_probe_responses"
		result.ErrorMessage = "target gate did not return UDP probe responses"
		return result
	}
	result.Status = "succeeded"
	result.RTTMs = summarizeProbeSamples(samples, func(sample probeSample) float64 { return sample.RTTMs })
	result.ForwardOneWayMs = summarizeProbeSamples(samples, func(sample probeSample) float64 { return optionalFloat64(sample.ForwardOneWayMs) })
	result.ReverseOneWayMs = summarizeProbeSamples(samples, func(sample probeSample) float64 { return optionalFloat64(sample.ReverseOneWayMs) })
	clockErrorSummary := summarizeProbeSamples(samples, func(sample probeSample) float64 { return optionalFloat64(sample.ClockErrorMs) })
	result.OneWayClockErrorMs = clockErrorSummary.P95
	result.JitterMs = compactFloat(result.RTTMs.P95 - result.RTTMs.P50)
	return result
}

func resolveProbeInterface(value string) (string, error) {
	if value == "" || value == "public" {
		return defaultRouteInterface()
	}
	if linkState(value) == "missing" {
		return "", fmt.Errorf("interface %s is missing", value)
	}
	return value, nil
}

func listenUDPOnInterface(interfaceName string) (net.PacketConn, error) {
	return listenUDPWithOptions("0.0.0.0:0", interfaceName, false)
}

func listenUDPWithOptions(addr string, interfaceName string, reusePort bool) (net.PacketConn, error) {
	listenConfig := net.ListenConfig{}
	listenConfig.Control = func(network string, address string, conn syscall.RawConn) error {
		var controlErr error
		err := conn.Control(func(fd uintptr) {
			if reusePort {
				if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
					controlErr = err
					return
				}
				if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, soReusePort, 1); err != nil {
					controlErr = err
					return
				}
			}
			if interfaceName != "" {
				controlErr = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, interfaceName)
			}
		})
		if err != nil {
			return err
		}
		return controlErr
	}
	return listenConfig.ListenPacket(context.Background(), "udp4", addr)
}

func runProbeSample(
	conn net.PacketConn,
	cfg config,
	payload probeJobPayload,
	target *net.UDPAddr,
	seq int,
	timeout time.Duration,
	sourceClockSyncOK bool,
	sourceClockErrorMs *float64,
) (probeSample, error) {
	nonce, err := randomHex(16)
	if err != nil {
		return probeSample{}, err
	}
	clientTx := time.Now()
	request := probePacket{
		Magic:                probeMagic,
		SourceGate:           cfg.GateName,
		TargetGate:           payload.TargetGateName,
		Nonce:                nonce,
		Seq:                  seq,
		ClientTxWallUnixNano: clientTx.UnixNano(),
	}
	signProbePacket(&request, cfg.ProbeSharedSecret)
	encoded, err := json.Marshal(request)
	if err != nil {
		return probeSample{}, err
	}
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return probeSample{}, err
	}
	start := time.Now()
	if _, err := conn.WriteTo(encoded, target); err != nil {
		return probeSample{}, err
	}
	buffer := make([]byte, 4096)
	for {
		n, _, err := conn.ReadFrom(buffer)
		if err != nil {
			return probeSample{}, err
		}
		clientRx := time.Now()
		var response probePacket
		if err := json.Unmarshal(buffer[:n], &response); err != nil {
			continue
		}
		if response.Magic != probeMagic || response.Nonce != nonce || response.Seq != seq {
			continue
		}
		if !verifyProbePacket(response, cfg.ProbeSharedSecret) {
			continue
		}
		sample := probeSample{
			Seq:             seq,
			RTTMs:           compactFloat(float64(clientRx.Sub(start).Microseconds()) / 1000),
			ForwardOneWayMs: nil,
			ReverseOneWayMs: nil,
		}
		if sourceClockSyncOK && probeObservedRemoteClockSyncOK(response.ServerObservedRemote) {
			sample.ForwardOneWayMs = float64Ptr(compactFloat(nsToMs(response.ServerRxWallUnixNano - request.ClientTxWallUnixNano)))
			sample.ReverseOneWayMs = float64Ptr(compactFloat(nsToMs(clientRx.UnixNano() - response.ServerTxWallUnixNano)))
			if sourceClockErrorMs != nil {
				sample.SourceClockErrorMs = float64Ptr(*sourceClockErrorMs)
			}
			if targetClockErrorMs, ok := probeObservedRemoteClockErrorMs(response.ServerObservedRemote); ok {
				sample.TargetClockErrorMs = float64Ptr(targetClockErrorMs)
				if sourceClockErrorMs != nil {
					sample.ClockErrorMs = float64Ptr(compactFloat(*sourceClockErrorMs + targetClockErrorMs))
				}
			}
		}
		return sample, nil
	}
}

func newProbeServerManager(cfg config) *probeServerManager {
	return &probeServerManager{
		cfg:       cfg,
		addr:      net.JoinHostPort(cfg.ProbeListenAddress, strconv.Itoa(cfg.ProbePort)),
		interval:  probeServerSyncInterval,
		listeners: map[string]*managedProbeListener{},
	}
}

func (manager *probeServerManager) Start() {
	manager.sync()
	go func() {
		ticker := time.NewTicker(manager.interval)
		defer ticker.Stop()
		for range ticker.C {
			manager.sync()
		}
	}()
}

func (manager *probeServerManager) sync() {
	desired := probeServerBindings()
	desiredByTransport := map[string]probeServerBinding{}
	for _, binding := range desired {
		desiredByTransport[binding.Transport] = binding
		manager.ensureListener(binding)
	}

	manager.mu.Lock()
	for transport, listener := range manager.listeners {
		if _, ok := desiredByTransport[transport]; !ok {
			if listener.Conn != nil {
				_ = listener.Conn.Close()
			}
			delete(manager.listeners, transport)
			logJSON("probe_server_stopped", map[string]any{
				"transport": listener.Binding.Transport,
				"interface": listener.Binding.Interface,
				"ifIndex":   listener.Binding.IfIndex,
				"reason":    "interface_unavailable",
			})
		}
	}
	manager.mu.Unlock()
}

func (manager *probeServerManager) ensureListener(binding probeServerBinding) {
	manager.mu.RLock()
	current := manager.listeners[binding.Transport]
	restart := listenerNeedsRestart(current, binding)
	manager.mu.RUnlock()
	if !restart {
		return
	}

	if current != nil && current.Conn != nil {
		_ = current.Conn.Close()
	}

	conn, err := listenUDPWithOptions(manager.addr, binding.Interface, true)
	if err != nil {
		manager.mu.Lock()
		manager.listeners[binding.Transport] = &managedProbeListener{
			Binding:   binding,
			Ready:     false,
			LastError: err.Error(),
			UpdatedAt: time.Now(),
		}
		manager.mu.Unlock()
		logJSON("probe_server_bind_failed", map[string]any{
			"transport": binding.Transport,
			"interface": binding.Interface,
			"ifIndex":   binding.IfIndex,
			"error":     err.Error(),
		})
		return
	}

	listener := &managedProbeListener{
		Binding:   binding,
		Conn:      conn,
		Ready:     true,
		StartedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	manager.mu.Lock()
	manager.listeners[binding.Transport] = listener
	manager.mu.Unlock()

	startProbeServerLoop(manager.cfg, conn, binding, func(err error) {
		manager.markListenerExited(binding.Transport, conn, err)
	})
}

func listenerNeedsRestart(current *managedProbeListener, desired probeServerBinding) bool {
	if current == nil {
		return true
	}
	if !current.Ready || current.Conn == nil {
		return true
	}
	return current.Binding.Interface != desired.Interface || current.Binding.IfIndex != desired.IfIndex
}

func (manager *probeServerManager) markListenerExited(transport string, conn net.PacketConn, err error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	current := manager.listeners[transport]
	if current == nil || current.Conn != conn {
		return
	}
	current.Ready = false
	current.Conn = nil
	current.UpdatedAt = time.Now()
	if err != nil {
		current.LastError = err.Error()
	}
}

func (manager *probeServerManager) bindState(transport string) string {
	manager.mu.RLock()
	listener := manager.listeners[transport]
	manager.mu.RUnlock()
	if listener == nil {
		return "unavailable"
	}
	if listener.Ready && listener.Conn != nil {
		return "ready"
	}
	return "unavailable"
}

func probeServerBindings() []probeServerBinding {
	candidates := make([]probeServerBinding, 0, 2)
	if publicInterface, err := defaultRouteInterface(); err == nil && publicInterface != "" {
		if ifIndex, err := interfaceIndex(publicInterface); err == nil {
			candidates = append(candidates, probeServerBinding{Transport: "public", Interface: publicInterface, IfIndex: ifIndex})
		}
	}
	if linkState("doublezero0") != "missing" {
		if ifIndex, err := interfaceIndex("doublezero0"); err == nil {
			candidates = append(candidates, probeServerBinding{Transport: "doublezero", Interface: "doublezero0", IfIndex: ifIndex})
		}
	}
	return dedupeProbeServerBindings(candidates)
}

func dedupeProbeServerBindings(candidates []probeServerBinding) []probeServerBinding {
	seen := map[string]bool{}
	bindings := make([]probeServerBinding, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Interface == "" || seen[candidate.Interface] {
			continue
		}
		seen[candidate.Interface] = true
		bindings = append(bindings, candidate)
	}
	return bindings
}

func startProbeServerLoop(cfg config, conn net.PacketConn, binding probeServerBinding, onExit func(error)) {
	go func() {
		defer conn.Close()
		logJSON("probe_server_started", map[string]any{
			"listenAddress": cfg.ProbeListenAddress,
			"port":          cfg.ProbePort,
			"transport":     binding.Transport,
			"interface":     binding.Interface,
			"ifIndex":       binding.IfIndex,
			"hmac":          hmacState(cfg),
		})
		buffer := make([]byte, 4096)
		for {
			n, remote, err := conn.ReadFrom(buffer)
			if err != nil {
				if !errors.Is(err, net.ErrClosed) && !strings.Contains(err.Error(), "use of closed network connection") {
					logJSON("probe_server_read_failed", map[string]any{
						"transport": binding.Transport,
						"interface": binding.Interface,
						"ifIndex":   binding.IfIndex,
						"error":     err.Error(),
					})
				}
				if onExit != nil {
					onExit(err)
				}
				return
			}
			serverRx := time.Now()
			var request probePacket
			if err := json.Unmarshal(buffer[:n], &request); err != nil {
				continue
			}
			if request.Magic != probeMagic {
				continue
			}
			if !verifyProbePacket(request, cfg.ProbeSharedSecret) {
				continue
			}
			clockSyncOK, clockErrorMs := cachedClockSyncState()
			response := probePacket{
				Magic:                probeMagic,
				SourceGate:           request.SourceGate,
				TargetGate:           cfg.GateName,
				Nonce:                request.Nonce,
				Seq:                  request.Seq,
				ClientTxWallUnixNano: request.ClientTxWallUnixNano,
				ServerRxWallUnixNano: serverRx.UnixNano(),
				ServerObservedRemote: formatProbeObservedRemote(remote.String(), clockSyncOK, clockErrorMs),
			}
			response.ServerTxWallUnixNano = time.Now().UnixNano()
			signProbePacket(&response, cfg.ProbeSharedSecret)
			encoded, err := json.Marshal(response)
			if err != nil {
				continue
			}
			_, _ = conn.WriteTo(encoded, remote)
		}
	}()
}

func formatProbeObservedRemote(remote string, clockSyncOK bool, clockErrorMs *float64) string {
	if !clockSyncOK {
		return remote
	}
	parts := []string{remote, "clockSync=ok"}
	if clockErrorMs != nil {
		parts = append(parts, fmt.Sprintf("clockErrorMs=%.3f", *clockErrorMs))
	}
	return strings.Join(parts, ";")
}

func probeObservedRemoteClockSyncOK(value string) bool {
	for _, part := range strings.Split(value, ";") {
		if strings.TrimSpace(part) == "clockSync=ok" {
			return true
		}
	}
	return false
}

func probeObservedRemoteClockErrorMs(value string) (float64, bool) {
	for _, part := range strings.Split(value, ";") {
		text := strings.TrimSpace(part)
		if !strings.HasPrefix(text, "clockErrorMs=") {
			continue
		}
		parsed, err := strconv.ParseFloat(strings.TrimPrefix(text, "clockErrorMs="), 64)
		if err != nil || !isFiniteFloat(parsed) || parsed < 0 {
			return 0, false
		}
		return compactFloat(parsed), true
	}
	return 0, false
}

func signProbePacket(packet *probePacket, secret string) {
	if secret == "" {
		return
	}
	packet.HMAC = ""
	packet.HMAC = probePacketHMAC(*packet, secret)
}

func verifyProbePacket(packet probePacket, secret string) bool {
	if secret == "" {
		return true
	}
	if packet.HMAC == "" {
		return false
	}
	expected := probePacketHMAC(packet, secret)
	return hmac.Equal([]byte(packet.HMAC), []byte(expected))
}

func probePacketHMAC(packet probePacket, secret string) string {
	packet.HMAC = ""
	encoded, _ := json.Marshal(packet)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil))
}

func randomHex(byteCount int) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func summarizeProbeSamples(samples []probeSample, selectValue func(probeSample) float64) probeMetricSummary {
	values := make([]float64, 0, len(samples))
	for _, sample := range samples {
		value := selectValue(sample)
		if !isFiniteFloat(value) {
			continue
		}
		values = append(values, value)
	}
	if len(values) == 0 {
		return probeMetricSummary{}
	}
	sort.Float64s(values)
	return probeMetricSummary{
		Min: compactFloat(values[0]),
		P50: compactFloat(percentile(values, 50)),
		P95: compactFloat(percentile(values, 95)),
		Max: compactFloat(values[len(values)-1]),
	}
}

func percentile(sorted []float64, pct float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if len(sorted) == 1 {
		return sorted[0]
	}
	position := (pct / 100) * float64(len(sorted)-1)
	lower := int(position)
	upper := lower + 1
	if upper >= len(sorted) {
		return sorted[len(sorted)-1]
	}
	weight := position - float64(lower)
	return sorted[lower]*(1-weight) + sorted[upper]*weight
}

func nsToMs(ns int64) float64 {
	return float64(ns) / 1_000_000
}

func compactFloat(value float64) float64 {
	if !isFiniteFloat(value) {
		return 0
	}
	return math.Round(value*1000) / 1000
}

func isFiniteFloat(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func optionalFloat64(value *float64) float64 {
	if value == nil {
		return math.NaN()
	}
	return *value
}

func float64Ptr(value float64) *float64 {
	return &value
}

func probeState(cfg config) string {
	if cfg.ProbePort <= 0 {
		return "disabled"
	}
	return "enabled"
}

func probeBindState(cfg config, manager *probeServerManager, transport string) string {
	if cfg.ProbePort <= 0 {
		return "disabled"
	}
	if manager == nil {
		return "unavailable"
	}
	return manager.bindState(transport)
}

func hmacState(cfg config) string {
	if cfg.ProbeSharedSecret == "" {
		return "disabled"
	}
	return "enabled"
}

func chronyState() string {
	output := commandOutput("chronyc", "tracking")
	if output == "" {
		return "unknown"
	}
	if strings.Contains(output, "Leap status") && strings.Contains(output, "Normal") {
		return "sync"
	}
	return "reported"
}

func ntpDiscoveryState() string {
	if commandState("chronyc") != "present" {
		return "disabled"
	}
	return "enabled"
}

func chronyTrackingSummary() map[string]any {
	output, err := commandOutputTimeout(2*time.Second, "chronyc", "tracking")
	if err != nil {
		return map[string]any{"status": "unavailable", "error": err.Error()}
	}
	summary := map[string]any{"status": "reported"}
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		switch key {
		case "Leap status":
			summary["leapStatus"] = value
			if value == "Normal" {
				summary["status"] = "sync"
			}
		case "System time":
			summary["systemTime"] = value
		case "Last offset":
			summary["lastOffset"] = value
		case "RMS offset":
			summary["rmsOffset"] = value
		case "Root delay":
			summary["rootDelay"] = value
		case "Root dispersion":
			summary["rootDispersion"] = value
		}
	}
	return summary
}

func cachedClockSyncState() (bool, *float64) {
	clockSyncCache.mu.Lock()
	defer clockSyncCache.mu.Unlock()
	if !clockSyncCache.checkedAt.IsZero() && time.Since(clockSyncCache.checkedAt) < clockSyncCacheTTL {
		if clockSyncCache.clockErrorOK {
			return clockSyncCache.reliable, float64Ptr(clockSyncCache.clockErrorMs)
		}
		return clockSyncCache.reliable, nil
	}
	summary := chronyTrackingSummary()
	clockSyncCache.reliable = chronySummaryReliable(summary)
	clockSyncCache.clockErrorMs, clockSyncCache.clockErrorOK = chronyClockErrorMs(summary)
	clockSyncCache.checkedAt = time.Now()
	if clockSyncCache.clockErrorOK {
		return clockSyncCache.reliable, float64Ptr(clockSyncCache.clockErrorMs)
	}
	return clockSyncCache.reliable, nil
}

func chronySummaryReliable(summary map[string]any) bool {
	if summary == nil {
		return false
	}
	status, _ := summary["status"].(string)
	if status != "sync" {
		return false
	}
	lastOffset, ok := chronyOffsetSeconds(summary["lastOffset"])
	if !ok || math.Abs(lastOffset) > oneWayClockSyncMaxOffsetSeconds {
		return false
	}
	rmsOffset, ok := chronyOffsetSeconds(summary["rmsOffset"])
	if !ok || math.Abs(rmsOffset) > oneWayClockSyncMaxOffsetSeconds {
		return false
	}
	return true
}

func chronyClockErrorMs(summary map[string]any) (float64, bool) {
	if summary == nil {
		return 0, false
	}
	if status, _ := summary["status"].(string); status != "sync" {
		return 0, false
	}
	lastOffset, ok := chronyOffsetSeconds(summary["lastOffset"])
	if !ok {
		return 0, false
	}
	rmsOffset, ok := chronyOffsetSeconds(summary["rmsOffset"])
	if !ok {
		return 0, false
	}
	clockErrorSeconds := math.Abs(lastOffset) + math.Abs(rmsOffset)
	if rootDelay, ok := chronyOffsetSeconds(summary["rootDelay"]); ok {
		clockErrorSeconds += math.Abs(rootDelay) / 2
	}
	if rootDispersion, ok := chronyOffsetSeconds(summary["rootDispersion"]); ok {
		clockErrorSeconds += math.Abs(rootDispersion)
	}
	return compactFloat(clockErrorSeconds * 1000), true
}

func chronyOffsetSeconds(value any) (float64, bool) {
	text, ok := value.(string)
	if !ok {
		return 0, false
	}
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) == 0 {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func doubleZeroRouteState() string {
	if linkState("doublezero0") != "up" {
		return "unavailable"
	}
	output := commandOutput("ip", "route", "show", "dev", "doublezero0", "proto", "bgp")
	if output == "" {
		return "empty"
	}
	count := 0
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	if count == 0 {
		return "empty"
	}
	if count < 2 {
		return "sparse"
	}
	return "ready"
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

func sendHeartbeat(client *http.Client, cfg config, probeManager *probeServerManager) error {
	doubleZero := doubleZeroStatus()
	chronySummary := chronyTrackingSummary()
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
			"doublezero-routes:" + doubleZeroRouteState(),
			"udp-probe:" + probeState(cfg),
			"udp-probe-public-bind:" + probeBindState(cfg, probeManager, "public"),
			"udp-probe-doublezero-bind:" + probeBindState(cfg, probeManager, "doublezero"),
			"udp-probe-hmac:" + hmacState(cfg),
			"chrony:" + chronyState(),
			"ntp-discovery:" + ntpDiscoveryState(),
		},
		"reportedAt": time.Now().UTC().Format(time.RFC3339),
	}
	if clockErrorMs, ok := chronyClockErrorMs(chronySummary); ok {
		body["clockErrorMs"] = clockErrorMs
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
		ControlPlaneURL:    controlPlaneURL,
		GateName:           gateName,
		GateToken:          gateToken,
		PollInterval:       durationEnv("POLL_INTERVAL", 2*time.Second),
		HeartbeatInterval:  durationEnv("HEARTBEAT_INTERVAL", 10*time.Second),
		ExecutionMode:      stringEnv("GATE_AGENT_EXECUTION_MODE", "observe"),
		StateDir:           stringEnv("GATE_AGENT_STATE_DIR", "/var/lib/hyperspace-gate"),
		ProbeListenAddress: stringEnv("GATE_PROBE_LISTEN_ADDRESS", "0.0.0.0"),
		ProbePort:          intEnv("GATE_PROBE_PORT", 19192),
		ProbeSharedSecret:  os.Getenv("GATE_PROBE_SHARED_SECRET"),
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

func intEnv(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
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
	addDoubleZeroEdgeRTT(parsed, now)
	return parsed
}

func addDoubleZeroEdgeRTT(status map[string]any, measuredAt string) {
	target := readMapString(status, "tunnelDst")
	if target == "" || net.ParseIP(target) == nil {
		return
	}
	status["edgeRttTarget"] = target

	interfaceName, err := defaultRouteInterface()
	if err != nil {
		status["edgeRttError"] = err.Error()
		return
	}
	status["edgeRttInterface"] = interfaceName

	rttMs, err := pingAverageRTT(interfaceName, target)
	if err != nil {
		status["edgeRttError"] = err.Error()
		return
	}
	status["edgeRttMs"] = compactFloat(rttMs)
	status["edgeRttMeasuredAt"] = measuredAt
}

func pingAverageRTT(interfaceName string, target string) (float64, error) {
	output, err := commandOutputTimeout(4*time.Second, "ping", "-n", "-I", interfaceName, "-c", "3", "-i", "0.2", "-W", "1", target)
	if err != nil {
		return 0, fmt.Errorf("ping %s via %s failed: %w", target, interfaceName, err)
	}
	return parsePingAverageRTT(output)
}

func parsePingAverageRTT(output string) (float64, error) {
	matches := regexp.MustCompile(`(?m)(?:rtt|round-trip)[^=]*=\s*([0-9.]+)/([0-9.]+)/`).FindStringSubmatch(output)
	if len(matches) < 3 {
		return 0, errors.New("ping output did not include an RTT summary")
	}
	avg, err := strconv.ParseFloat(matches[2], 64)
	if err != nil {
		return 0, fmt.Errorf("parse ping average RTT: %w", err)
	}
	return avg, nil
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

func interfaceIndex(name string) (int, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return 0, err
	}
	return iface.Index, nil
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
