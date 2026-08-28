package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	version       = "0.1.0"
	buildRevision = "unknown"
	buildTime     = "unknown"
)

var defaultAllowedHosts = []string{
	"api.binance.com",
	"api.kraken.com",
	"api.hyperliquid.xyz",
	"clob.polymarket.com",
	"api.elections.kalshi.com",
	"arb1.arbitrum.io",
}

type config struct {
	ControlPlaneURL string
	NodeName        string
	NodeToken       string
	PollInterval    time.Duration
	Heartbeat       time.Duration
	AllowedHosts    map[string]struct{}
}

type target struct {
	ID                   string            `json:"id"`
	Key                  string            `json:"key"`
	Revision             int               `json:"revision"`
	Category             string            `json:"category"`
	DisplayName          string            `json:"displayName"`
	Product              string            `json:"product"`
	Protocol             string            `json:"protocol"`
	Scheme               string            `json:"scheme"`
	Hostname             string            `json:"hostname"`
	Port                 int               `json:"port"`
	Path                 string            `json:"path"`
	Method               string            `json:"method"`
	Headers              map[string]string `json:"headers"`
	Body                 any               `json:"body,omitempty"`
	ExpectedStatus       int               `json:"expectedStatus"`
	ExpectedBodyContains string            `json:"expectedBodyContains,omitempty"`
	ResponseKind         string            `json:"responseKind"`
	TimeoutMS            int               `json:"timeoutMs"`
	SampleCount          int               `json:"sampleCount"`
}

type job struct {
	ID             string `json:"id"`
	AttemptNumber  int    `json:"attemptNumber"`
	NetworkProfile string `json:"networkProfile"`
	Target         target `json:"target"`
}

type claimResponse struct {
	Job *job `json:"job"`
}

type metricResult struct {
	Status        string   `json:"status"`
	MeasuredAt    string   `json:"measuredAt"`
	DNSMS         *float64 `json:"dnsMs,omitempty"`
	TCPMS         *float64 `json:"tcpMs,omitempty"`
	TLSMS         *float64 `json:"tlsMs,omitempty"`
	TTFBMS        *float64 `json:"ttfbMs,omitempty"`
	TotalP50MS    *float64 `json:"totalP50Ms,omitempty"`
	TotalP95MS    *float64 `json:"totalP95Ms,omitempty"`
	TotalMinMS    *float64 `json:"totalMinMs,omitempty"`
	TotalMaxMS    *float64 `json:"totalMaxMs,omitempty"`
	JitterMS      *float64 `json:"jitterMs,omitempty"`
	SampleCount   int      `json:"sampleCount"`
	FailureCount  int      `json:"failureCount"`
	HTTPStatus    int      `json:"httpStatus,omitempty"`
	ResponseClass string   `json:"responseClass,omitempty"`
	ResolvedIP    string   `json:"resolvedIp,omitempty"`
	ErrorCode     string   `json:"errorCode,omitempty"`
	ErrorMessage  string   `json:"errorMessage,omitempty"`
}

type sample struct {
	dnsMS         float64
	tcpMS         float64
	tlsMS         float64
	ttfbMS        float64
	totalMS       float64
	httpStatus    int
	responseClass string
	resolvedIP    string
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "--build-info":
			printJSON(map[string]any{"version": version, "revision": buildRevision, "builtAt": buildTime})
			return
		case "--self-test":
			if err := selfTest(); err != nil {
				fatal(err)
			}
			printJSON(map[string]any{"ok": true, "checks": []string{"private_ip_rejection", "target_allowlist", "aggregation"}})
			return
		}
	}
	cfg, err := readConfig()
	if err != nil {
		fatal(err)
	}
	if err := selfTest(); err != nil {
		fatal(fmt.Errorf("startup self-test failed: %w", err))
	}
	client := &http.Client{Timeout: 20 * time.Second}
	bootID := strings.TrimSpace(readFile("/proc/sys/kernel/random/boot_id"))
	leaseOwner := cfg.NodeName + ":" + bootID
	go periodic(cfg.Heartbeat, func() error { return sendHeartbeat(client, cfg, bootID) })
	for {
		claimed, err := claim(client, cfg, leaseOwner)
		if err != nil {
			logJSON("claim_failed", map[string]any{"error": err.Error()})
			time.Sleep(cfg.PollInterval)
			continue
		}
		if claimed == nil {
			time.Sleep(cfg.PollInterval)
			continue
		}
		result := execute(cfg, claimed.Target)
		if err := report(client, cfg, *claimed, result); err != nil {
			logJSON("report_failed", map[string]any{"jobId": claimed.ID, "error": err.Error()})
		} else {
			logJSON("probe_completed", map[string]any{
				"jobId": claimed.ID, "target": claimed.Target.Key, "status": result.Status,
				"p50Ms": result.TotalP50MS, "failures": result.FailureCount,
			})
		}
	}
}

func readConfig() (config, error) {
	allowed := defaultAllowedHosts
	if raw := strings.TrimSpace(os.Getenv("TRADING_PROBE_ALLOWED_HOSTS")); raw != "" {
		allowed = strings.Split(raw, ",")
	}
	hosts := make(map[string]struct{}, len(allowed))
	for _, host := range allowed {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			hosts[host] = struct{}{}
		}
	}
	cfg := config{
		ControlPlaneURL: strings.TrimRight(strings.TrimSpace(os.Getenv("CONTROL_PLANE_URL")), "/"),
		NodeName:        strings.TrimSpace(os.Getenv("TRADING_PROBE_NODE_NAME")),
		NodeToken:       strings.TrimSpace(os.Getenv("TRADING_PROBE_NODE_TOKEN")),
		PollInterval:    durationEnv("TRADING_PROBE_POLL_INTERVAL", 2*time.Second),
		Heartbeat:       durationEnv("TRADING_PROBE_HEARTBEAT_INTERVAL", 20*time.Second),
		AllowedHosts:    hosts,
	}
	if cfg.ControlPlaneURL == "" || cfg.NodeName == "" || cfg.NodeToken == "" {
		return config{}, errors.New("CONTROL_PLANE_URL, TRADING_PROBE_NODE_NAME and TRADING_PROBE_NODE_TOKEN are required")
	}
	return cfg, nil
}

func sendHeartbeat(client *http.Client, cfg config, bootID string) error {
	payload := map[string]any{
		"bootId": bootID, "agentVersion": version, "agentRevision": buildRevision,
		"capabilities":    []string{"http-json:v1", "json-rpc:v1", "ssrf-guard:v1"},
		"networkProfiles": []string{"direct"}, "spoolDepth": 0,
		"selfTest": map[string]any{"ok": true, "checkedAt": time.Now().UTC().Format(time.RFC3339Nano)},
	}
	return postJSON(client, cfg, "/v1/trading-probe/heartbeat", payload, nil)
}

func claim(client *http.Client, cfg config, leaseOwner string) (*job, error) {
	var response claimResponse
	err := postJSON(client, cfg, "/v1/trading-probe/jobs/claim", map[string]any{"leaseOwner": leaseOwner}, &response)
	return response.Job, err
}

func report(client *http.Client, cfg config, claimed job, result metricResult) error {
	return postJSON(client, cfg, "/v1/trading-probe/jobs/"+claimed.ID+"/report", map[string]any{
		"attemptNumber": claimed.AttemptNumber,
		"result":        result,
	}, nil)
}

func postJSON(client *http.Client, cfg config, path string, payload any, output any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, cfg.ControlPlaneURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-probe-node-name", cfg.NodeName)
	request.Header.Set("x-probe-node-token", cfg.NodeToken)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("control-plane returned %d: %s", response.StatusCode, strings.TrimSpace(string(limited)))
	}
	if output != nil && len(limited) > 0 {
		return json.Unmarshal(limited, output)
	}
	return nil
}

func execute(cfg config, t target) metricResult {
	measuredAt := time.Now().UTC().Format(time.RFC3339Nano)
	if err := validateTarget(cfg, t); err != nil {
		return failedResult(measuredAt, t.SampleCount, "target_rejected", err)
	}
	var successes []sample
	var lastErr error
	errorCode := "probe_failed"
	for index := 0; index < t.SampleCount; index++ {
		entry, code, err := measureHTTP(t)
		if err != nil {
			lastErr = err
			errorCode = code
		} else {
			successes = append(successes, entry)
		}
		if index+1 < t.SampleCount {
			time.Sleep(200 * time.Millisecond)
		}
	}
	if len(successes) == 0 {
		return failedResult(measuredAt, t.SampleCount, errorCode, lastErr)
	}
	return aggregate(measuredAt, t.SampleCount, successes)
}

func validateTarget(cfg config, t target) error {
	if t.Protocol != "http_json" && t.Protocol != "json_rpc" {
		return fmt.Errorf("unsupported protocol %q", t.Protocol)
	}
	if t.Scheme != "https" || t.Port != 443 {
		return errors.New("only HTTPS port 443 is enabled in the MVP")
	}
	host := strings.ToLower(strings.TrimSuffix(t.Hostname, "."))
	if _, ok := cfg.AllowedHosts[host]; !ok {
		return fmt.Errorf("host %q is not in TRADING_PROBE_ALLOWED_HOSTS", host)
	}
	if !strings.HasPrefix(t.Path, "/") || strings.ContainsAny(t.Path, "\r\n") {
		return errors.New("invalid target path")
	}
	if t.Method != http.MethodGet && t.Method != http.MethodPost {
		return errors.New("unsupported HTTP method")
	}
	if t.TimeoutMS < 250 || t.TimeoutMS > 30000 || t.SampleCount < 1 || t.SampleCount > 20 {
		return errors.New("target budget is outside safe bounds")
	}
	return nil
}

func measureHTTP(t target) (sample, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(t.TimeoutMS)*time.Millisecond)
	defer cancel()
	dnsStarted := time.Now()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, t.Hostname)
	if err != nil {
		return sample{}, "dns_failed", err
	}
	dnsMS := milliseconds(time.Since(dnsStarted))
	resolved, err := choosePublicIP(addresses)
	if err != nil {
		return sample{}, "address_rejected", err
	}
	var tcpMS, tlsMS, ttfbMS float64
	dialer := &net.Dialer{Timeout: time.Duration(t.TimeoutMS) * time.Millisecond}
	transport := &http.Transport{
		Proxy:             nil,
		ForceAttemptHTTP2: true,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12, ServerName: t.Hostname},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			started := time.Now()
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.String(), strconv.Itoa(t.Port)))
			tcpMS = milliseconds(time.Since(started))
			return connection, err
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Duration(t.TimeoutMS) * time.Millisecond}
	var encodedBody []byte
	if t.Body != nil {
		encodedBody, err = json.Marshal(t.Body)
		if err != nil {
			return sample{}, "request_invalid", err
		}
	}
	started := time.Now()
	request, err := http.NewRequestWithContext(ctx, t.Method, "https://"+t.Hostname+t.Path, bytes.NewReader(encodedBody))
	if err != nil {
		return sample{}, "request_invalid", err
	}
	request.Host = t.Hostname
	request.Header.Set("user-agent", "HyperspaceTradingProbe/"+version)
	for key, value := range t.Headers {
		request.Header.Set(key, value)
	}
	var tlsStarted time.Time
	trace := &httptrace.ClientTrace{
		TLSHandshakeStart: func() { tlsStarted = time.Now() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			if !tlsStarted.IsZero() {
				tlsMS = milliseconds(time.Since(tlsStarted))
			}
		},
		GotFirstResponseByte: func() { ttfbMS = milliseconds(time.Since(started)) },
	}
	request = request.WithContext(httptrace.WithClientTrace(request.Context(), trace))
	response, err := client.Do(request)
	if err != nil {
		return sample{}, classifyNetworkError(err), err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return sample{}, "response_read_failed", err
	}
	if len(body) > 65536 {
		return sample{}, "response_too_large", errors.New("response exceeded 64 KiB")
	}
	if response.StatusCode != t.ExpectedStatus {
		if response.StatusCode == http.StatusTooManyRequests {
			return sample{}, "rate_limited", fmt.Errorf("endpoint returned HTTP 429")
		}
		return sample{}, "unexpected_http_status", fmt.Errorf("expected status %d, got %d", t.ExpectedStatus, response.StatusCode)
	}
	responseClass, err := validateResponse(body, t)
	if err != nil {
		return sample{}, "response_validation_failed", err
	}
	return sample{
		dnsMS: dnsMS, tcpMS: tcpMS, tlsMS: tlsMS, ttfbMS: ttfbMS,
		totalMS: milliseconds(time.Since(started)), httpStatus: response.StatusCode,
		responseClass: responseClass, resolvedIP: resolved.String(),
	}, "", nil
}

func validateResponse(body []byte, t target) (string, error) {
	if t.ExpectedBodyContains != "" && !bytes.Contains(body, []byte(t.ExpectedBodyContains)) {
		return "", errors.New("response does not contain expected marker")
	}
	if t.ResponseKind == "any" {
		return "any", nil
	}
	var decoded any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return "", err
	}
	switch t.ResponseKind {
	case "json_object":
		if _, ok := decoded.(map[string]any); !ok {
			return "", errors.New("expected JSON object")
		}
	case "json_array":
		if _, ok := decoded.([]any); !ok {
			return "", errors.New("expected JSON array")
		}
	case "json_number":
		if _, ok := decoded.(float64); !ok {
			return "", errors.New("expected JSON number")
		}
	default:
		return "", errors.New("unsupported response kind")
	}
	return t.ResponseKind, nil
}

func choosePublicIP(addresses []net.IPAddr) (net.IP, error) {
	for _, address := range addresses {
		if isPublicIP(address.IP) {
			return address.IP, nil
		}
	}
	return nil, errors.New("DNS returned no permitted public address")
}

func isPublicIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast()
}

func aggregate(measuredAt string, requested int, samples []sample) metricResult {
	totals := values(samples, func(value sample) float64 { return value.totalMS })
	dns := values(samples, func(value sample) float64 { return value.dnsMS })
	tcp := values(samples, func(value sample) float64 { return value.tcpMS })
	tlsValues := values(samples, func(value sample) float64 { return value.tlsMS })
	ttfb := values(samples, func(value sample) float64 { return value.ttfbMS })
	p50, p95 := percentile(totals, 0.5), percentile(totals, 0.95)
	return metricResult{
		Status: "succeeded", MeasuredAt: measuredAt,
		DNSMS: pointer(percentile(dns, 0.5)), TCPMS: pointer(percentile(tcp, 0.5)),
		TLSMS: pointer(percentile(tlsValues, 0.5)), TTFBMS: pointer(percentile(ttfb, 0.5)),
		TotalP50MS: pointer(p50), TotalP95MS: pointer(p95), TotalMinMS: pointer(totals[0]),
		TotalMaxMS: pointer(totals[len(totals)-1]), JitterMS: pointer(standardDeviation(totals)),
		SampleCount: requested, FailureCount: requested - len(samples), HTTPStatus: samples[len(samples)-1].httpStatus,
		ResponseClass: samples[len(samples)-1].responseClass, ResolvedIP: samples[len(samples)-1].resolvedIP,
	}
}

func failedResult(measuredAt string, samples int, code string, err error) metricResult {
	message := "probe failed"
	if err != nil {
		message = err.Error()
	}
	if len(message) > 300 {
		message = message[:300]
	}
	return metricResult{Status: "failed", MeasuredAt: measuredAt, SampleCount: samples, FailureCount: samples, ErrorCode: code, ErrorMessage: message}
}

func values(samples []sample, selectValue func(sample) float64) []float64 {
	result := make([]float64, 0, len(samples))
	for _, entry := range samples {
		result = append(result, selectValue(entry))
	}
	sort.Float64s(result)
	return result
}

func percentile(sorted []float64, quantile float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	position := quantile * float64(len(sorted)-1)
	lower, upper := int(math.Floor(position)), int(math.Ceil(position))
	if lower == upper {
		return sorted[lower]
	}
	weight := position - float64(lower)
	return sorted[lower]*(1-weight) + sorted[upper]*weight
}

func standardDeviation(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	var mean float64
	for _, value := range values {
		mean += value
	}
	mean /= float64(len(values))
	var variance float64
	for _, value := range values {
		delta := value - mean
		variance += delta * delta
	}
	return math.Sqrt(variance / float64(len(values)))
}

func classifyNetworkError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return "timeout"
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "tls") || strings.Contains(text, "certificate") {
		return "tls_failed"
	}
	return "connect_failed"
}

func selfTest() error {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"} {
		if isPublicIP(net.ParseIP(raw)) {
			return fmt.Errorf("private address accepted: %s", raw)
		}
	}
	if !isPublicIP(net.ParseIP("1.1.1.1")) {
		return errors.New("public address rejected")
	}
	sorted := []float64{1, 2, 3, 4}
	if percentile(sorted, 0.5) != 2.5 {
		return errors.New("aggregation self-test failed")
	}
	return nil
}

func periodic(interval time.Duration, task func() error) {
	for {
		if err := task(); err != nil {
			logJSON("heartbeat_failed", map[string]any{"error": err.Error()})
		}
		time.Sleep(interval)
	}
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func milliseconds(value time.Duration) float64 { return float64(value.Microseconds()) / 1000 }
func pointer(value float64) *float64           { return &value }
func readFile(path string) string              { value, _ := os.ReadFile(path); return string(value) }

var logMu sync.Mutex

func logJSON(event string, fields map[string]any) {
	logMu.Lock()
	defer logMu.Unlock()
	fields["event"] = event
	fields["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	encoded, _ := json.Marshal(fields)
	fmt.Println(string(encoded))
}

func printJSON(value any) { encoded, _ := json.Marshal(value); fmt.Println(string(encoded)) }
func fatal(err error)     { logJSON("fatal", map[string]any{"error": err.Error()}); os.Exit(1) }

func artifactSHA256(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
