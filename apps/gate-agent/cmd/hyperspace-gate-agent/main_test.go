package main

import "testing"

func TestParseDoubleZeroStatus(t *testing.T) {
	output := ` Tunnel Status  | Last Session Update     | Tunnel Name | Tunnel Src   | Tunnel Dst     | Doublezero IP | User Type | Reconciler | Tenant | Current Device | Lowest Latency Device | Metro     | Network | Multicast Groups 
 BGP Session Up | 2026-06-05 12:00:08 UTC | doublezero0 | 85.9.219.252 | 195.219.138.96 | 85.9.219.252  | IBRL      | true       |        | ams-dz001      | ✅ ams-dz001          | Amsterdam | testnet |                  `

	status := parseDoubleZeroStatus(output)

	assertString(t, status, "currentDevice", "ams-dz001")
	assertString(t, status, "lowestLatencyDevice", "ams-dz001")
	assertString(t, status, "metro", "Amsterdam")
	assertString(t, status, "network", "testnet")
	assertString(t, status, "tunnelStatus", "BGP Session Up")
}

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
