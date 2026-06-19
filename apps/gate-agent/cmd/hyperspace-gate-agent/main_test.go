package main

import (
	"encoding/json"
	"net"
	"testing"
	"time"
)

func TestParseDoubleZeroStatus(t *testing.T) {
	output := " Tunnel Status  | Last Session Update     | Tunnel Name | Tunnel Src   | Tunnel Dst     | Doublezero IP | User Type | Reconciler | Tenant | Current Device | Lowest Latency Device | Metro     | Network | Multicast Groups\n" +
		" BGP Session Up | 2026-06-05 12:00:08 UTC | doublezero0 | 85.9.219.252 | 195.219.138.96 | 85.9.219.252  | IBRL      | true       |        | ams-dz001      | ✅ ams-dz001          | Amsterdam | testnet |"

	status := parseDoubleZeroStatus(output)

	assertString(t, status, "currentDevice", "ams-dz001")
	assertString(t, status, "lowestLatencyDevice", "ams-dz001")
	assertBool(t, status, "lowestLatencyDeviceWarning", false)
	assertString(t, status, "metro", "Amsterdam")
	assertString(t, status, "network", "testnet")
	assertString(t, status, "tunnelStatus", "BGP Session Up")
}

func TestParseDoubleZeroStatusParsesLatencyDeviceStatus(t *testing.T) {
	tests := []struct {
		name       string
		cell       string
		expected   string
		warning    bool
		hasWarning bool
	}{
		{
			name:       "current device is lowest latency",
			cell:       "✅ dz-ch2-sw01",
			expected:   "dz-ch2-sw01",
			warning:    false,
			hasWarning: true,
		},
		{
			name:       "current device differs from lowest latency",
			cell:       "⚠️ dz-ch2-sw01",
			expected:   "dz-ch2-sw01",
			warning:    true,
			hasWarning: true,
		},
		{
			name:       "warning glyph without variation selector",
			cell:       "⚠ dz-ch2-sw01",
			expected:   "dz-ch2-sw01",
			warning:    true,
			hasWarning: true,
		},
		{
			name:       "doublezero output without status glyph",
			cell:       "N/A",
			expected:   "N/A",
			hasWarning: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			output := " Tunnel Status  | Last Session Update     | Tunnel Name | Tunnel Src    | Tunnel Dst     | Doublezero IP  | User Type | Reconciler | Tenant | Current Device | Lowest Latency Device | Metro   | Network      | Multicast Groups\n" +
				" BGP Session Up | 2026-06-05 12:00:08 UTC | doublezero0 | 152.44.43.130 | 195.219.138.96 | 152.44.43.130  | IBRL      | true       |        | chi001-dz002   | " + tt.cell + "        | Chicago | mainnet-beta |"

			status := parseDoubleZeroStatus(output)

			assertString(t, status, "currentDevice", "chi001-dz002")
			assertString(t, status, "lowestLatencyDevice", tt.expected)
			if tt.hasWarning {
				assertBool(t, status, "lowestLatencyDeviceWarning", tt.warning)
			} else {
				assertMissing(t, status, "lowestLatencyDeviceWarning")
			}
		})
	}
}

func TestParsePingAverageRTT(t *testing.T) {
	tests := []struct {
		name     string
		output   string
		expected float64
	}{
		{
			name:     "linux iputils",
			output:   "rtt min/avg/max/mdev = 0.566/0.575/0.590/0.009 ms",
			expected: 0.575,
		},
		{
			name:     "bsd ping",
			output:   "round-trip min/avg/max/stddev = 1.720/1.744/1.764/0.016 ms",
			expected: 1.744,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual, err := parsePingAverageRTT(tt.output)
			if err != nil {
				t.Fatal(err)
			}
			if actual != tt.expected {
				t.Fatalf("average RTT = %v, expected %v", actual, tt.expected)
			}
		})
	}
}

func TestDecodeProbePayloadDefaults(t *testing.T) {
	payload := map[string]any{
		"kind":             "gate_benchmark_v1",
		"targetGateId":     "target-1",
		"targetGateName":   "gate-eu-ams-01",
		"targetPublicIpv4": "203.0.113.10",
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	decoded, err := decodeProbePayload(job{Payload: encoded})
	if err != nil {
		t.Fatal(err)
	}
	if decoded.TargetProbePort != 19192 {
		t.Fatalf("TargetProbePort = %d, expected 19192", decoded.TargetProbePort)
	}
	if decoded.Count != 10 {
		t.Fatalf("Count = %d, expected 10", decoded.Count)
	}
	if len(decoded.Transports) != 2 {
		t.Fatalf("Transports = %d, expected 2", len(decoded.Transports))
	}
	if decoded.Transports[0].Name != "public" || decoded.Transports[1].Name != "doublezero" {
		t.Fatalf("unexpected transports: %#v", decoded.Transports)
	}
}

func TestProbePacketHMAC(t *testing.T) {
	packet := probePacket{
		Magic:                probeMagic,
		SourceGate:           "gate-a",
		TargetGate:           "gate-b",
		Nonce:                "nonce",
		Seq:                  1,
		ClientTxWallUnixNano: 100,
	}
	signProbePacket(&packet, "shared-secret")

	if packet.HMAC == "" {
		t.Fatal("expected HMAC")
	}
	if !verifyProbePacket(packet, "shared-secret") {
		t.Fatal("expected HMAC to verify")
	}
	packet.Seq = 2
	if verifyProbePacket(packet, "shared-secret") {
		t.Fatal("tampered packet should not verify")
	}
}

func TestSummarizeProbeSamples(t *testing.T) {
	summary := summarizeProbeSamples([]probeSample{
		{RTTMs: 10},
		{RTTMs: 20},
		{RTTMs: 30},
	}, func(sample probeSample) float64 { return sample.RTTMs })

	if summary.Min != 10 || summary.P50 != 20 || summary.P95 != 29 || summary.Max != 30 {
		t.Fatalf("unexpected summary: %#v", summary)
	}
}

func TestSummarizeProbeSamplesSkipsMissingOneWay(t *testing.T) {
	summary := summarizeProbeSamples([]probeSample{
		{RTTMs: 10},
		{RTTMs: 20},
	}, func(sample probeSample) float64 { return optionalFloat64(sample.ForwardOneWayMs) })

	if summary != (probeMetricSummary{}) {
		t.Fatalf("expected empty summary for missing one-way samples, got %#v", summary)
	}
}

func TestChronySummaryReliable(t *testing.T) {
	if !chronySummaryReliable(map[string]any{
		"status":     "sync",
		"lastOffset": "0.000123 seconds fast of NTP time",
		"rmsOffset":  "0.000456 seconds",
	}) {
		t.Fatal("expected low-offset chrony sync to be reliable")
	}

	if chronySummaryReliable(map[string]any{
		"status":     "sync",
		"lastOffset": "0.044 seconds fast of NTP time",
		"rmsOffset":  "0.001 seconds",
	}) {
		t.Fatal("expected high-offset chrony sync to be unreliable")
	}

	if chronySummaryReliable(map[string]any{"status": "unavailable"}) {
		t.Fatal("expected unavailable chrony to be unreliable")
	}
}

func TestProbeObservedRemoteClockSyncMarker(t *testing.T) {
	plain := formatProbeObservedRemote("203.0.113.10:19192", false)
	if plain != "203.0.113.10:19192" || probeObservedRemoteClockSyncOK(plain) {
		t.Fatalf("unexpected plain observed remote marker: %q", plain)
	}

	marked := formatProbeObservedRemote("203.0.113.10:19192", true)
	if !probeObservedRemoteClockSyncOK(marked) {
		t.Fatalf("expected clock sync marker in %q", marked)
	}
}

func TestDedupeProbeServerBindings(t *testing.T) {
	bindings := dedupeProbeServerBindings([]probeServerBinding{
		{Transport: "public", Interface: "eth0"},
		{Transport: "doublezero", Interface: "doublezero0"},
		{Transport: "duplicate", Interface: "eth0"},
		{Transport: "empty"},
	})

	if len(bindings) != 2 {
		t.Fatalf("bindings = %#v, expected 2 unique interface bindings", bindings)
	}
	if bindings[0].Transport != "public" || bindings[0].Interface != "eth0" {
		t.Fatalf("unexpected first binding: %#v", bindings[0])
	}
	if bindings[1].Transport != "doublezero" || bindings[1].Interface != "doublezero0" {
		t.Fatalf("unexpected second binding: %#v", bindings[1])
	}
}

func TestListenerNeedsRestartOnInterfaceIndexChange(t *testing.T) {
	current := &managedProbeListener{
		Binding: probeServerBinding{Transport: "doublezero", Interface: "doublezero0", IfIndex: 12},
		Conn:    fakePacketConn{},
		Ready:   true,
	}

	if listenerNeedsRestart(current, probeServerBinding{Transport: "doublezero", Interface: "doublezero0", IfIndex: 12}) {
		t.Fatal("listener with same interface index should be reused")
	}
	if !listenerNeedsRestart(current, probeServerBinding{Transport: "doublezero", Interface: "doublezero0", IfIndex: 13}) {
		t.Fatal("listener should restart when interface index changes")
	}
	if !listenerNeedsRestart(current, probeServerBinding{Transport: "doublezero", Interface: "dz-old", IfIndex: 12}) {
		t.Fatal("listener should restart when interface name changes")
	}
}

func TestProbeManagerBindStateReflectsLiveListener(t *testing.T) {
	manager := &probeServerManager{
		listeners: map[string]*managedProbeListener{
			"doublezero": {
				Binding: probeServerBinding{Transport: "doublezero", Interface: "doublezero0", IfIndex: 12},
				Conn:    fakePacketConn{},
				Ready:   true,
			},
			"public": {
				Binding:   probeServerBinding{Transport: "public", Interface: "eth0", IfIndex: 2},
				LastError: "bind failed",
			},
		},
	}

	if got := manager.bindState("doublezero"); got != "ready" {
		t.Fatalf("doublezero bind state = %q, expected ready", got)
	}
	if got := manager.bindState("public"); got != "unavailable" {
		t.Fatalf("public bind state = %q, expected unavailable", got)
	}
	if got := manager.bindState("missing"); got != "unavailable" {
		t.Fatalf("missing bind state = %q, expected unavailable", got)
	}
}

type fakePacketConn struct{}

func (fakePacketConn) ReadFrom([]byte) (int, net.Addr, error) { return 0, nil, nil }
func (fakePacketConn) WriteTo([]byte, net.Addr) (int, error)  { return 0, nil }
func (fakePacketConn) Close() error                           { return nil }
func (fakePacketConn) LocalAddr() net.Addr                    { return nil }
func (fakePacketConn) SetDeadline(time.Time) error            { return nil }
func (fakePacketConn) SetReadDeadline(time.Time) error        { return nil }
func (fakePacketConn) SetWriteDeadline(time.Time) error       { return nil }

func assertString(t *testing.T, values map[string]any, key string, expected string) {
	t.Helper()
	actual, ok := values[key].(string)
	if !ok {
		t.Fatalf("%s missing or not a string: %#v", key, values[key])
	}
	if actual != expected {
		t.Fatalf("%s = %q, expected %q", key, actual, expected)
	}
}

func assertBool(t *testing.T, values map[string]any, key string, expected bool) {
	t.Helper()
	actual, ok := values[key].(bool)
	if !ok {
		t.Fatalf("%s missing or not a bool: %#v", key, values[key])
	}
	if actual != expected {
		t.Fatalf("%s = %t, expected %t", key, actual, expected)
	}
}

func assertMissing(t *testing.T, values map[string]any, key string) {
	t.Helper()
	if _, ok := values[key]; ok {
		t.Fatalf("%s should be missing: %#v", key, values[key])
	}
}
