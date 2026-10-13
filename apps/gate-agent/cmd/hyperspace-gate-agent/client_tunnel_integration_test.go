package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Driven by scripts/gates/test-amneziawg-netns.py in isolated network namespaces.
// It exercises production apply/readback/accounting/restore/revoke against real
// upstream extended WireGuard and kernel WireGuard, without requiring any production hosts.
func TestAmneziaWGMixedPathIntegration(t *testing.T) {
	root := os.Getenv("HYPERSPACE_AWG_FIXTURE")
	if root == "" {
		t.Skip("run scripts/gates/test-amneziawg-netns.py")
	}
	var fixture struct {
		Ingress assignmentState `json:"ingress"`
		Egress  assignmentState `json:"egress"`
		Plan    networkPlan     `json:"plan"`
	}
	data, err := os.ReadFile(filepath.Join(root, "fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	role := os.Getenv("HYPERSPACE_AWG_ROLE")
	state := fixture.Ingress
	if role == "Egress" {
		state = fixture.Egress
	}
	cfg := config{StateDir: filepath.Join(root, role), ExecutionMode: "apply", AmneziaWGReady: true}
	payload := assignmentPayload{AssignmentID: state.AssignmentID, Role: state.Role, NetworkPlan: fixture.Plan}
	switch os.Getenv("HYPERSPACE_AWG_ACTION") {
	case "probe":
		if err := checkAmneziaWG(); err != nil {
			t.Fatal(err)
		}
		return
	case "apply":
		if err := writeAssignmentState(cfg, state); err != nil {
			t.Fatal(err)
		}
		if _, err := commitAssignment(cfg, payload); err != nil {
			t.Fatal(err)
		}
	case "restore":
		result := rehydrateAssignments(cfg)
		if result.Rehydrated != 1 || result.Failed != 0 {
			t.Fatalf("restore: %+v", result)
		}
	case "check":
		counters := assignmentCounters(cfg)
		if len(counters) != 1 || counters[0].WireGuardTransitReceiveBytes == 0 || counters[0].WireGuardTransitTransmitBytes == 0 {
			t.Fatal("missing bidirectional transit traffic")
		}
		if role == "Ingress" && (counters[0].WireGuardClientReceiveBytes == 0 || counters[0].WireGuardClientTransmitBytes == 0) {
			t.Fatal("missing bidirectional AmneziaWG traffic")
		}
	case "revoke":
		if err := revokeAssignment(cfg, payload); err != nil {
			t.Fatal(err)
		}
		if len(actualManagedHandles(cfg)) != 0 {
			t.Fatal("revoked assignment is still managed")
		}
		return
	default:
		t.Fatal("unknown integration action")
	}
	if len(actualManagedHandles(cfg)) != 1 {
		t.Fatal("applied tunnel state/readback is incomplete")
	}
}
