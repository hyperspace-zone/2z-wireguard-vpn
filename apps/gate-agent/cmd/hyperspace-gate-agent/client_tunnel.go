package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const amneziaWGCapability = "client-tunnel:amneziawg-3.1"

// Only public obfuscation parameters travel in plans/material and job reports.
// HeaderProtectionKey is delivered separately and persisted in root-only state.
type clientTunnel struct {
	Protocol                  string              `json:"protocol"`
	Version                   string              `json:"version,omitempty"`
	HeaderProtectionKeySHA256 string              `json:"headerProtectionKeySha256,omitempty"`
	Parameters                amneziaWGParameters `json:"parameters,omitempty"`
}

type clientTunnelSecret struct {
	HeaderProtectionKey string `json:"headerProtectionKey"`
}

type amneziaWGParameters struct {
	Jc                     int    `json:"Jc"`
	Jmin                   int    `json:"Jmin"`
	Jmax                   int    `json:"Jmax"`
	S1                     int    `json:"S1"`
	S2                     int    `json:"S2"`
	S3                     int    `json:"S3"`
	S4                     int    `json:"S4"`
	H1                     string `json:"H1"`
	H2                     string `json:"H2"`
	H3                     string `json:"H3"`
	H4                     string `json:"H4"`
	ContentPaddingAddition string `json:"ContentPaddingAddition"`
	RekeyAfterTime         string `json:"RekeyAfterTime"`
	RekeyTimeout           string `json:"RekeyTimeout"`
	KeepaliveTimeout       string `json:"KeepaliveTimeout"`
	RandomTrailers         string `json:"RandomTrailers"`
}

func (t *clientTunnel) isAmneziaWG() bool { return t != nil && t.Protocol == "amneziawg" }

func (t *clientTunnel) validate() error {
	// Missing transport identifies persisted WireGuard assignments from before
	// the upgrade; never reinterpret an already issued client configuration.
	if t == nil || t.Protocol == "wireguard" {
		return nil
	}
	if !t.isAmneziaWG() || t.Version != "3.1" {
		return errors.New("unsupported client tunnel protocol/version")
	}
	fingerprint, err := hex.DecodeString(t.HeaderProtectionKeySHA256)
	if err != nil || len(fingerprint) != sha256.Size || strings.ToLower(t.HeaderProtectionKeySHA256) != t.HeaderProtectionKeySHA256 {
		return errors.New("invalid AmneziaWG key fingerprint")
	}
	p := t.Parameters
	if p.Jc < 1 || p.Jc > 128 || p.Jmin < 1 || p.Jmax > 1280 || p.Jmin >= p.Jmax {
		return errors.New("invalid AmneziaWG junk parameters")
	}
	if p.S1 < 12 || p.S1 > 64 || p.S1 != p.S2 || p.S1 != p.S3 || p.S1 != p.S4 {
		return errors.New("AmneziaWG random trailers require equal prefixes between 12 and 64 bytes")
	}
	if p.H1 != "1" || p.H2 != "2" || p.H3 != "3" || p.H4 != "4" || p.RandomTrailers != "on" {
		return errors.New("invalid AmneziaWG header protection profile")
	}
	for _, r := range []struct {
		value    string
		min, max int
	}{
		{p.ContentPaddingAddition, 0, 64}, {p.RekeyAfterTime, 60, 150},
		{p.RekeyTimeout, 1, 15}, {p.KeepaliveTimeout, 1, 30},
	} {
		parts := strings.Split(r.value, "-")
		if len(parts) != 2 {
			return errors.New("invalid AmneziaWG timing/padding range")
		}
		low, lowErr := strconv.Atoi(parts[0])
		high, highErr := strconv.Atoi(parts[1])
		if lowErr != nil || highErr != nil || low < r.min || high > r.max || low > high ||
			strconv.Itoa(low) != parts[0] || strconv.Itoa(high) != parts[1] {
			return errors.New("invalid AmneziaWG timing/padding range")
		}
	}
	return nil
}

func (t *clientTunnel) validateSecret(key string) error {
	if err := t.validate(); err != nil {
		return err
	}
	if !t.isAmneziaWG() {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != key {
		return errors.New("missing or invalid AmneziaWG header protection key")
	}
	hash := sha256.Sum256(decoded)
	if hex.EncodeToString(hash[:]) != t.HeaderProtectionKeySHA256 {
		return errors.New("AmneziaWG header protection key does not match plan")
	}
	return nil
}

func sameClientTunnel(left, right *clientTunnel) bool {
	if left.validate() != nil || right.validate() != nil {
		return false
	}
	if !left.isAmneziaWG() && !right.isAmneziaWG() {
		return true
	}
	return reflect.DeepEqual(left, right)
}

func (t *clientTunnel) controlTool() string {
	if t.isAmneziaWG() {
		return "awg"
	}
	return "wg"
}

func (p amneziaWGParameters) args() []string {
	return []string{
		"jc", strconv.Itoa(p.Jc), "jmin", strconv.Itoa(p.Jmin), "jmax", strconv.Itoa(p.Jmax),
		"s1", strconv.Itoa(p.S1), "s2", strconv.Itoa(p.S2), "s3", strconv.Itoa(p.S3), "s4", strconv.Itoa(p.S4),
		"h1", p.H1, "h2", p.H2, "h3", p.H3, "h4", p.H4,
		"content-padding-addition", p.ContentPaddingAddition,
		"rekey-after-time", p.RekeyAfterTime, "rekey-timeout", p.RekeyTimeout,
		"keepalive-timeout", p.KeepaliveTimeout, "random-trailers", p.RandomTrailers,
	}
}

// Never include CLI output: key parsing errors can echo private key material.
func setTunnel(tool string, args ...string) error {
	if err := exec.Command(tool, args...).Run(); err != nil {
		return fmt.Errorf("%s interface configuration failed (check installed tools/module and parameters): %w", tool, err)
	}
	return nil
}

func validateAssignmentClientTunnel(state assignmentState, plan networkPlan) error {
	if state.Role != "Ingress" {
		return nil
	}
	tunnel := plan.PublicMaterial.ClientTunnel
	if !sameClientTunnel(state.Material.ClientTunnel, tunnel) || !sameClientTunnel(plan.Ingress.LocalMaterial.ClientTunnel, tunnel) {
		return errors.New("prepared ingress client tunnel does not match immutable plan")
	}
	return tunnel.validateSecret(state.HeaderProtectionKey)
}

func amneziaWGKernelStatePresent(state assignmentState) bool {
	tunnel := state.Material.ClientTunnel
	if !tunnel.isAmneziaWG() {
		return true
	}
	if tunnel.validateSecret(state.HeaderProtectionKey) != nil {
		return false
	}
	// showconf contains secret material: inspect in memory only, never log it.
	output := commandOutput("awg", "showconf", state.Material.Interfaces.Client)
	values := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == "[Peer]" {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if values["HeaderProtectionKey"] != state.HeaderProtectionKey {
		return false
	}
	p := tunnel.Parameters
	for key, expected := range map[string]string{
		"Jc": strconv.Itoa(p.Jc), "Jmin": strconv.Itoa(p.Jmin), "Jmax": strconv.Itoa(p.Jmax),
		"S1": strconv.Itoa(p.S1), "S2": strconv.Itoa(p.S2), "S3": strconv.Itoa(p.S3), "S4": strconv.Itoa(p.S4),
		"ContentPaddingAddition": p.ContentPaddingAddition, "RekeyAfterTime": p.RekeyAfterTime,
		"RekeyTimeout": p.RekeyTimeout, "KeepaliveTimeout": p.KeepaliveTimeout, "RandomTrailers": p.RandomTrailers,
	} {
		if values[key] != expected {
			return false
		}
	}
	return true
}

// Probe the installed kernel implementation, not just the presence of awg.
// The temporary interface is never brought up and has no UDP listener or peers.
func checkAmneziaWG() error {
	if _, err := exec.LookPath("awg"); err != nil {
		return errors.New("AmneziaWG 3.1 tools are not installed")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	name := "hsawgp" + hex.EncodeToString(random[:4])
	if _, err := commandOutputTimeout(5*time.Second, "ip", "link", "add", "dev", name, "type", "amneziawg"); err != nil {
		return errors.New("AmneziaWG kernel interface is unavailable")
	}
	defer runIgnore("ip", "link", "delete", "dev", name)
	key := base64.StdEncoding.EncodeToString(random[:])
	keyFile, cleanup, err := writeTempPrivateKey(key)
	if err != nil {
		return err
	}
	defer cleanup()
	p := amneziaWGParameters{Jc: 4, Jmin: 40, Jmax: 1000, S1: 24, S2: 24, S3: 24, S4: 24,
		H1: "1", H2: "2", H3: "3", H4: "4", ContentPaddingAddition: "0-64",
		RekeyAfterTime: "100-140", RekeyTimeout: "4-7", KeepaliveTimeout: "8-15", RandomTrailers: "on"}
	args := append([]string{"set", name}, p.args()...)
	args = append(args, "header-protection-key", keyFile)
	if err := setTunnel("awg", args...); err != nil {
		return err
	}
	hash := sha256.Sum256(random[:])
	probe := assignmentState{HeaderProtectionKey: key, Material: localMaterial{
		Interfaces:   materialInterfaces{Client: name},
		ClientTunnel: &clientTunnel{Protocol: "amneziawg", Version: "3.1", HeaderProtectionKeySHA256: hex.EncodeToString(hash[:]), Parameters: p},
	}}
	if !amneziaWGKernelStatePresent(probe) {
		return errors.New("AmneziaWG module/tools do not support the required 3.1 profile")
	}
	return nil
}
