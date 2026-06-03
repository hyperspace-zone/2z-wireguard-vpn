package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
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
	case "apply_assignment", "revoke_assignment":
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
		return jobResult{
			Status:    "retryable_failed",
			ErrorCode: "host_mutation_not_enabled",
			ResultSummary: map[string]any{
				"executionMode": cfg.ExecutionMode,
				"note":          "set GATE_AGENT_EXECUTION_MODE=ack only for control-plane integration tests",
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

func sendHeartbeat(client *http.Client, cfg config) error {
	body := map[string]any{
		"gateId":           cfg.GateName,
		"agentVersion":     version,
		"bootId":           bootID(),
		"observedEndpoint": hostname(),
		"capabilities": []string{
			"heartbeat",
			"job-claim",
			"actual-state-report",
			"wireguard-tools:" + commandState("wg"),
			"iproute2:" + commandState("ip"),
			"nft:" + commandState("nft"),
		},
		"reportedAt": time.Now().UTC().Format(time.RFC3339),
	}
	return postJSON(client, cfg, "/v1/gate/heartbeat", body, nil)
}

func sendActualState(client *http.Client, cfg config) error {
	body := map[string]any{
		"gateId":       cfg.GateName,
		"bootId":       bootID(),
		"agentVersion": version,
		"stateHash":    actualStateHash(),
		"capabilities": []string{
			"actual-state-report",
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
