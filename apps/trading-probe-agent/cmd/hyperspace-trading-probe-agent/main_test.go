package main

import (
	"net"
	"net/http"
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

func TestTLSTargetValidation(t *testing.T) {
	cfg := config{AllowedHosts: map[string]struct{}{"pyth-lazer-0.dourolabs.app": {}}}
	target := target{
		Protocol: "tcp_tls", Scheme: "tls", Hostname: "pyth-lazer-0.dourolabs.app", Port: 443,
		Path: "/", Method: "GET", TimeoutMS: 5000, SampleCount: 3,
	}
	if err := validateTarget(cfg, target); err != nil {
		t.Fatal(err)
	}
	target.Scheme = "https"
	if err := validateTarget(cfg, target); err == nil {
		t.Fatal("expected a tcp_tls target with an HTTPS scheme to be rejected")
	}
}

func TestHTTPFailureClassification(t *testing.T) {
	tests := map[int]string{
		http.StatusTooManyRequests:            "rate_limited",
		http.StatusUnavailableForLegalReasons: "geo_blocked",
		http.StatusForbidden:                  "unexpected_http_status",
	}
	for status, expected := range tests {
		if actual := classifyHTTPStatus(status); actual != expected {
			t.Fatalf("status %d: expected %s, got %s", status, expected, actual)
		}
	}
}

func TestFailedResultPreservesObservedHTTPDiagnostics(t *testing.T) {
	result := failedResult("2026-08-28T00:00:00Z", 3, "geo_blocked", nil, sample{
		dnsMS: 1, tcpMS: 2, tlsMS: 3, ttfbMS: 4, totalMS: 5,
		httpStatus: http.StatusUnavailableForLegalReasons, resolvedIP: "192.0.2.1",
	})
	if result.HTTPStatus != http.StatusUnavailableForLegalReasons || result.ResolvedIP != "192.0.2.1" {
		t.Fatalf("HTTP diagnostics were not preserved: %+v", result)
	}
	if result.TotalP50MS == nil || *result.TotalP50MS != 5 {
		t.Fatalf("failure timing was not preserved: %+v", result.TotalP50MS)
	}
}
