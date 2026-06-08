package main

import "testing"

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
