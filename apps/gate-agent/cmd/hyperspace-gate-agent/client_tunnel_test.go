package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testClientTunnel() (*clientTunnel, string) {
	key := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32)))
	hash := sha256.Sum256([]byte(strings.Repeat("x", 32)))
	return &clientTunnel{Protocol: "amneziawg", Version: "3.1", HeaderProtectionKeySHA256: hex.EncodeToString(hash[:]),
		Parameters: amneziaWGParameters{Jc: 5, Jmin: 40, Jmax: 1000, S1: 24, S2: 24, S3: 24, S4: 24,
			H1: "1", H2: "2", H3: "3", H4: "4", ContentPaddingAddition: "0-64",
			RekeyAfterTime: "100-140", RekeyTimeout: "4-7", KeepaliveTimeout: "8-15", RandomTrailers: "on"}}, key
}

// These stand-ins exercise the actual command dispatch without touching host networking.
func fakeTunnelCommands(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "commands")
	t.Setenv("TUNNEL_COMMAND_LOG", log)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	script := `#!/bin/sh
set -eu
name=${0##*/}
printf '%s %s\n' "$name" "$*" >> "$TUNNEL_COMMAND_LOG"
case "$name $*" in
  'ip rule del '*) exit 1 ;;
  'ip link show '*) [ "${MISSING_LINKS:-0}" = 0 ] || exit 1; echo present ;;
  'ip -4 -o addr '*) echo '1: doublezero0 inet 192.0.2.1/32' ;;
  'ip route show default') echo 'default via 192.0.2.254 dev eth0' ;;
  'wg genkey') echo private-key ;;
  'wg pubkey') cat >/dev/null; echo public-key ;;
  'awg set '*)
    if [ "${FAIL_AWG:-0}" = 1 ]; then echo "$SECRET_KEY" >&2; exit 1; fi
    previous=''
    for argument in "$@"; do
      if [ "$previous" = header-protection-key ]; then
        test "$(stat -c %a "$argument")" = 600
        test "$(cat "$argument")" = "$SECRET_KEY"
      fi
      previous=$argument
    done ;;
  'awg showconf '*) cat "$AWG_SHOWCONF" ;;
  'awg show '*transfer) printf 'peer\t101\t202\n' ;;
  'wg show '*transfer) printf 'peer\t303\t404\n' ;;
  'awg show '*|'wg show '*) echo present ;;
  'nft list chain inet hyperspace forward') echo 'comment "hs-assignment-test:accept:to_destination"' ;;
esac
`
	for _, name := range []string{"ip", "wg", "awg", "nft", "sysctl"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return log
}

func TestAmneziaWGIngressAndWireGuardTransitLifecycle(t *testing.T) {
	log := fakeTunnelCommands(t)
	tunnel, secret := testClientTunnel()
	t.Setenv("SECRET_KEY", secret)
	cfg := config{StateDir: t.TempDir(), ExecutionMode: "apply", AmneziaWGReady: true}
	payload := assignmentPayload{AssignmentID: "test", Role: "Ingress", ClientTunnelSecret: clientTunnelSecret{HeaderProtectionKey: secret},
		Plan: preparePlan{PublicMaterial: publicMaterial{SessionID: "session", ClientAddress: "10.42.0.2/32", DestinationCidrs: []string{"0.0.0.0/0"}, ClientTunnel: tunnel}}}
	material, err := prepareAssignment(cfg, payload)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(material)
	if strings.Contains(string(encoded), secret) {
		t.Fatal("secret leaked in public assignment material")
	}
	repeated, err := prepareAssignment(cfg, payload)
	if err != nil || !sameClientTunnel(repeated.ClientTunnel, material.ClientTunnel) {
		t.Fatal("prepare is not idempotent", err)
	}
	payload.NetworkPlan = networkPlan{Generation: 1, PublicMaterial: payload.Plan.PublicMaterial,
		Ingress: assignmentEndpoint{LocalMaterial: material, PublicIPv4: "192.0.2.1"},
		Egress:  assignmentEndpoint{PublicIPv4: "192.0.2.2", LocalMaterial: localMaterial{WireGuard: materialWireGuard{TransitPublicKey: "egress-key", TransitListenPort: 51821}}}}
	payload.NetworkPlan.PublicMaterial.ClientPublicKey = "client-key"
	payload.NetworkPlan.PublicMaterial.MTU = 1280
	state, err := commitAssignment(cfg, payload)
	if err != nil {
		t.Fatal(err)
	}
	commands, _ := os.ReadFile(log)
	for _, expected := range []string{
		"type amneziawg", "type wireguard", "awg set " + material.Interfaces.Client,
		"wg set " + material.Interfaces.Transit, "random-trailers on", "header-protection-key ",
	} {
		if !strings.Contains(string(commands), expected) {
			t.Errorf("missing %q in commands", expected)
		}
	}
	if strings.Contains(string(commands), "awg set "+material.Interfaces.Transit) {
		t.Fatal("transit changed protocol")
	}
	if strings.Contains(string(commands), secret) {
		t.Fatal("key was passed on command line")
	}
	counter := readAssignmentCounter(state)
	if counter.WireGuardClientReceiveBytes != 101 || counter.WireGuardClientTransmitBytes != 202 || counter.WireGuardTransitReceiveBytes != 303 {
		t.Fatalf("incorrect mixed-protocol counters: %+v", counter)
	}
	// Rehydrate from disk without control-plane delivery of the secret.
	t.Setenv("MISSING_LINKS", "1")
	result := rehydrateAssignments(cfg)
	if result.Rehydrated != 1 || result.Failed != 0 {
		t.Fatalf("rehydration failed: %+v", result)
	}
	if err := revokeAssignment(cfg, payload); err != nil {
		t.Fatal(err)
	}
	revoked, err := readAssignmentState(cfg, "test")
	if err != nil || revoked.HeaderProtectionKey != "" || revoked.ClientPrivateKey != "" {
		t.Fatal("revocation retained secret", err)
	}
}

func TestTunnelConfigurationRejectsInvalidProfilesBeforeMutation(t *testing.T) {
	for _, name := range []string{"unknown protocol", "wrong key", "oversized prefix", "missing profile", "wrong version"} {
		t.Run(name, func(t *testing.T) {
			log := fakeTunnelCommands(t)
			tunnel, key := testClientTunnel()
			switch name {
			case "unknown protocol":
				tunnel.Protocol = "unknown"
			case "wrong key":
				key = base64.StdEncoding.EncodeToString(make([]byte, 32))
			case "oversized prefix":
				tunnel.Parameters.S4 = 1500
			case "missing profile":
				tunnel.Parameters = amneziaWGParameters{}
			case "wrong version":
				tunnel.Version = "1"
			}
			err := configureWireGuardInterface(wgInterfaceConfig{Name: "hsc-test", PrivateKey: "private", ListenPort: 51820, ClientTunnel: tunnel, HeaderProtectionKey: key})
			if err == nil {
				t.Fatal("invalid profile accepted")
			}
			if data, _ := os.ReadFile(log); len(data) != 0 {
				t.Fatal("invalid input mutated host")
			}
		})
	}
}

func TestAmneziaWGFailureNeverFallsBackAndDoesNotLeakKeys(t *testing.T) {
	log := fakeTunnelCommands(t)
	tunnel, key := testClientTunnel()
	t.Setenv("SECRET_KEY", key)
	t.Setenv("FAIL_AWG", "1")
	err := configureWireGuardInterface(wgInterfaceConfig{Name: "hsc-test", PrivateKey: "private", ListenPort: 51820, ClientTunnel: tunnel, HeaderProtectionKey: key})
	if err == nil || strings.Contains(err.Error(), key) {
		t.Fatal("expected a redacted failure")
	}
	data, _ := os.ReadFile(log)
	if strings.Contains(string(data), "type wireguard") || strings.Contains(string(data), "\nwg set") {
		t.Fatal("silently downgraded to WireGuard")
	}
	if !strings.HasSuffix(string(data), "ip link delete dev hsc-test\n") {
		t.Fatal("partial interface was not removed")
	}
}

func TestLegacyTunnelStillUsesWireGuard(t *testing.T) {
	log := fakeTunnelCommands(t)
	if err := configureWireGuardInterface(wgInterfaceConfig{Name: "legacy", PrivateKey: "private", ListenPort: 51820}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), "type wireguard") || !strings.Contains(string(data), "wg set legacy") || strings.Contains(string(data), "awg ") {
		t.Fatal("legacy configuration changed protocol")
	}
}

func TestIngressRefusesToChangePreparedTransport(t *testing.T) {
	log := fakeTunnelCommands(t)
	tunnel, key := testClientTunnel()
	cfg := config{StateDir: t.TempDir()}
	state := assignmentState{AssignmentID: "test", Role: "Ingress", ClientPrivateKey: "private", TransitPrivateKey: "private", HeaderProtectionKey: key,
		Material: localMaterial{AssignmentID: "test", ClientTunnel: tunnel}}
	if err := writeAssignmentState(cfg, state); err != nil {
		t.Fatal(err)
	}
	_, err := prepareAssignment(cfg, assignmentPayload{AssignmentID: "test", Role: "Ingress"})
	if err == nil {
		t.Fatal("silently downgraded prepared assignment")
	}
	_, err = commitAssignment(cfg, assignmentPayload{AssignmentID: "test", Role: "Ingress"})
	if err == nil {
		t.Fatal("silently downgraded committed assignment")
	}
	if data, _ := os.ReadFile(log); len(data) != 0 {
		t.Fatal("mismatch mutated host")
	}
}

func TestAmneziaWGDetectsObfuscationDrift(t *testing.T) {
	fakeTunnelCommands(t)
	tunnel, key := testClientTunnel()
	state := assignmentState{HeaderProtectionKey: key, Material: localMaterial{ClientTunnel: tunnel, Interfaces: materialInterfaces{Client: "hsc-test"}}}
	showconf := filepath.Join(t.TempDir(), "showconf")
	t.Setenv("AWG_SHOWCONF", showconf)
	values, _ := json.Marshal(tunnel.Parameters)
	var params map[string]any
	if err := json.Unmarshal(values, &params); err != nil {
		t.Fatal(err)
	}
	text := "[Interface]\nHeaderProtectionKey = " + key + "\n"
	for name, value := range params {
		text += fmt.Sprintf("%s = %v\n", name, value)
	}
	if err := os.WriteFile(showconf, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if !amneziaWGKernelStatePresent(state) {
		t.Fatal("matching profile reported as drifted")
	}
	for _, altered := range []string{strings.ReplaceAll(text, "S4 = 24", "S4 = 0"), strings.ReplaceAll(text, key, "wrong-key"), strings.ReplaceAll(text, "RandomTrailers = on", "RandomTrailers = off")} {
		if err := os.WriteFile(showconf, []byte(altered), 0o600); err != nil {
			t.Fatal(err)
		}
		if amneziaWGKernelStatePresent(state) {
			t.Fatal("changed obfuscation reported as healthy")
		}
	}
}
