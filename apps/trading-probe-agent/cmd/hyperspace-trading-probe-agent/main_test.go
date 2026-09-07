package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
)

// Explicit opt-in only: ordinary unit tests never contact a trading venue.
func TestPublicPerpDEXAPIs(t *testing.T) {
	if os.Getenv("HYPERSPACE_TRADING_LIVE_SMOKE") != "1" {
		t.Skip("set HYPERSPACE_TRADING_LIVE_SMOKE=1 to probe public read-only APIs")
	}
	cfg := config{AllowedHosts: map[string]struct{}{}}
	for _, host := range defaultAllowedHosts {
		cfg.AllowedHosts[host] = struct{}{}
	}
	for _, fixture := range []struct{ name, host, path, marker string }{
		{"variational", "omni-client-api.prod.ap-northeast-1.variational.io", "/metadata/stats", `"listings"`},
		{"extended", "api.starknet.extended.exchange", "/api/v1/info/markets?market=BTC-USD", `"BTC-USD"`},
		{"rise", "api.rise.trade", "/v1/markets", `"markets"`},
		{"lighter", "mainnet.zklighter.elliot.ai", "/api/v1/orderBookDetails?market_id=1", `"order_book_details"`},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			result := execute(cfg, target{
				Protocol: "http_json", Scheme: "https", Hostname: fixture.host, Port: 443,
				Path: fixture.path, Method: "GET", TimeoutMS: 5000, SampleCount: 1,
				Headers:        map[string]string{"accept": "application/json", "cache-control": "no-cache"},
				ExpectedStatus: 200, ExpectedBodyContains: fixture.marker, ResponseKind: "json_object",
			})
			if result.Status != "succeeded" || result.FailureCount != 0 {
				t.Fatalf("public API probe failed: status=%s code=%s http=%d message=%s", result.Status, result.ErrorCode, result.HTTPStatus, result.ErrorMessage)
			}
		})
	}
}

func TestDefaultAllowlistContainsPerpDEXCatalog(t *testing.T) {
	for _, host := range []string{
		"omni-client-api.prod.ap-northeast-1.variational.io",
		"api.starknet.extended.exchange",
		"api.rise.trade",
		"mainnet.zklighter.elliot.ai",
	} {
		if !slices.Contains(defaultAllowedHosts, host) {
			t.Fatalf("missing perpDEX host %s from the default allowlist", host)
		}
	}
}

func TestUnknownNetworkProfileNeverFallsBackToDirect(t *testing.T) {
	result := executeJob(config{}, job{NetworkProfile: "doublezero", Target: target{SampleCount: 3}})
	if result.Status != "failed" || result.ErrorCode != "network_profile_unavailable" {
		t.Fatalf("unexpected profile result: %+v", result)
	}
}

func TestHTTPResponseBudget(t *testing.T) {
	for _, size := range []int{65536, 300000, maxHTTPResponseBytes, maxHTTPResponseBytes + 1, maxHTTPResponseBytes * 2} {
		body, err := readHTTPResponse(strings.NewReader(strings.Repeat("x", size)))
		if err != nil {
			t.Fatal(err)
		}
		if len(body) != min(size, maxHTTPResponseBytes+1) {
			t.Fatalf("size %d: read %d bytes", size, len(body))
		}
		if (len(body) > maxHTTPResponseBytes) != (size > maxHTTPResponseBytes) {
			t.Fatalf("size %d: incorrect oversize classification", size)
		}
	}
}

func TestLargePublicMarketCatalogCanBeValidated(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{"listings": strings.Repeat("x", 300000)})
	if err != nil {
		t.Fatal(err)
	}
	body, err := readHTTPResponse(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateResponse(body, target{ResponseKind: "json_object", ExpectedBodyContains: `"listings"`}); err != nil {
		t.Fatal(err)
	}
}

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

func TestDefaultAllowlistContainsCompleteCEXCatalog(t *testing.T) {
	for _, host := range []string{
		"api.binance.com",
		"api.bitget.com",
		"www.bitstamp.net",
		"api.exchange.bullish.com",
		"api.bybit.com",
		"api.coinbase.com",
		"www.deribit.com",
		"api.kraken.com",
		"www.okx.com",
		"sg-api.upbit.com",
	} {
		if !slices.Contains(defaultAllowedHosts, host) {
			t.Fatalf("missing CEX host %s from the default allowlist", host)
		}
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
