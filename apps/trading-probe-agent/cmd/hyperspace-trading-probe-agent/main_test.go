package main

import (
	"net"
	"testing"
)

func TestPrivateAndMetadataAddressesAreRejected(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1"} {
		if isPublicIP(net.ParseIP(raw)) {
			t.Fatalf("accepted private address %s", raw)
		}
	}
}

func TestPercentileInterpolates(t *testing.T) {
	values := []float64{1, 2, 3, 4}
	if value := percentile(values, 0.5); value != 2.5 {
		t.Fatalf("expected p50 2.5, got %f", value)
	}
}

func TestResponseValidation(t *testing.T) {
	target := target{ResponseKind: "json_object", ExpectedBodyContains: "serverTime"}
	if _, err := validateResponse([]byte(`{"serverTime":123}`), target); err != nil {
		t.Fatal(err)
	}
	if _, err := validateResponse([]byte(`{"other":123}`), target); err == nil {
		t.Fatal("expected marker validation failure")
	}
}

func TestTargetAllowlist(t *testing.T) {
	cfg := config{AllowedHosts: map[string]struct{}{"api.binance.com": {}}}
	good := target{
		Protocol: "http_json", Scheme: "https", Hostname: "api.binance.com", Port: 443,
		Path: "/api/v3/time", Method: "GET", TimeoutMS: 5000, SampleCount: 3,
	}
	if err := validateTarget(cfg, good); err != nil {
		t.Fatal(err)
	}
	good.Hostname = "example.com"
	if err := validateTarget(cfg, good); err == nil {
		t.Fatal("expected non-catalog host to be rejected")
	}
}
