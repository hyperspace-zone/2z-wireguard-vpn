package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type startupEvent struct {
	Service string   `json:"service"`
	Version string   `json:"version"`
	Roles   []string `json:"roles"`
	Now     string   `json:"now"`
}

func main() {
	event := startupEvent{
		Service: "hyperspace-gate-agent",
		Version: "0.1.0",
		Roles: []string{
			"heartbeat",
			"job-claim",
			"assignment-apply",
			"assignment-revoke",
			"actual-state-report",
			"startup-recovery",
		},
		Now: time.Now().UTC().Format(time.RFC3339),
	}

	encoded, err := json.Marshal(event)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal startup event: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(encoded))
}
