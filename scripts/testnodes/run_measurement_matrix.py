#!/usr/bin/env python3
"""Run public and Hyperspace testnode latency matrices.

The script intentionally keeps WireGuard client configs out of stdout/stderr.
Temporary configs are copied to source testnodes over SSH, used for one probe
run, then removed after wg-quick down.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_API_BASE = "https://app.example.net/api"
DEFAULT_SSH_KEY = "~/.ssh/id_ed25519"
DEFAULT_PROBE_PATH = "/opt/hyperspace-testnodes/one_way_probe.py"
DEFAULT_PROBE_PORT = 19191


@dataclass(frozen=True)
class TestNode:
    key: str
    host: str
    public_ip: str


@dataclass(frozen=True)
class Gate:
    name: str
    public_ip: str


TESTNODES: list[TestNode] = []
GATES: list[Gate] = []


class ApiError(RuntimeError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def load_inventory(path: Path) -> tuple[list[TestNode], list[Gate]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    nodes = [
        TestNode(
            key=str(item["key"]),
            host=str(item["host"]),
            public_ip=str(item.get("publicIp") or item.get("public_ip")),
        )
        for item in data.get("testnodes", [])
    ]
    gates = [
        Gate(
            name=str(item["name"]),
            public_ip=str(item.get("publicIp") or item.get("public_ip") or item.get("publicEndpoint")),
        )
        for item in data.get("gates", [])
    ]
    if len(nodes) < 2:
        raise ValueError("inventory must contain at least two testnodes")
    if len(gates) < 2:
        raise ValueError("inventory must contain at least two gates")
    return nodes, gates


def ssh_command(host: str, ssh_key: str, command: str, *, input_text: str | None = None, timeout: int = 120) -> str:
    args = [
        "ssh",
        "-i",
        ssh_key,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        f"root@{host}",
        command,
    ]
    completed = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"ssh command failed on {host}: rc={completed.returncode}\n"
            f"command={command}\nstdout={completed.stdout}\nstderr={completed.stderr}"
        )
    return completed.stdout


def api_request(api_base: str, path_or_url: str, *, method: str = "GET", token: str | None = None, body: Any = None) -> Any:
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        url = path_or_url
    else:
        url = urllib.parse.urljoin(api_base.rstrip("/") + "/", path_or_url.lstrip("/"))
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            parsed = {"raw": payload}
        raise ApiError(f"{method} {url} failed: {error.code} {parsed}") from error


def ensure_api_token(api_base: str, email: str, password: str) -> str:
    try:
        response = api_request(
            api_base,
            "/v1/public/auth/register",
            method="POST",
            body={"email": email, "password": password, "displayName": "Testnode Matrix"},
        )
        return str(response["accessToken"])
    except ApiError as error:
        if "email_already_registered" not in str(error):
            raise
    response = api_request(
        api_base,
        "/v1/public/auth/login",
        method="POST",
        body={"email": email, "password": password},
    )
    return str(response["accessToken"])


def run_probe(
    source: TestNode,
    destination_ip: str,
    ssh_key: str,
    probe_path: str,
    probe_port: int,
    count: int,
    interval: float,
    timeout: float,
) -> dict[str, Any]:
    command = (
        f"{probe_path} client {destination_ip} "
        f"--port {probe_port} --count {count} --interval {interval} --timeout {timeout}"
    )
    stdout = ssh_command(source.host, ssh_key, command, timeout=max(60, int(count * (interval + timeout)) + 30))
    return json.loads(stdout)


def run_public_matrix(args: argparse.Namespace, output_dir: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for source in TESTNODES:
        for destination in TESTNODES:
            if source.key == destination.key:
                continue
            started = time.monotonic()
            result = run_probe(
                source,
                destination.public_ip,
                args.ssh_key,
                args.probe_path,
                args.probe_port,
                args.count,
                args.interval,
                args.timeout,
            )
            elapsed = time.monotonic() - started
            row = {
                "mode": "public",
                "source": node_json(source),
                "destination": node_json(destination),
                "probe": result,
                "elapsed_seconds": elapsed,
            }
            results.append(row)
            log_pair(row)

    write_json(output_dir / "public.json", results)
    return results


def measure_gate_rankings(args: argparse.Namespace, output_dir: Path) -> dict[str, list[dict[str, Any]]]:
    rankings: dict[str, list[dict[str, Any]]] = {}
    raw: list[dict[str, Any]] = []
    for node in TESTNODES:
        node_results: list[dict[str, Any]] = []
        for gate in GATES:
            command = f"ping -n -q -c 5 -W 2 {gate.public_ip}"
            started = time.monotonic()
            stdout = ssh_command(node.host, args.ssh_key, command, timeout=30)
            elapsed = time.monotonic() - started
            avg_ms = parse_ping_avg(stdout)
            result = {
                "node": node.key,
                "gate": gate.name,
                "gateIp": gate.public_ip,
                "avg_ms": avg_ms,
                "elapsed_seconds": elapsed,
            }
            raw.append(result)
            node_results.append(result)
        node_results.sort(key=lambda item: float(item["avg_ms"]))
        rankings[node.key] = node_results

    write_json(output_dir / "gate-ping.json", raw)
    return rankings


def parse_ping_avg(stdout: str) -> float:
    for line in stdout.splitlines():
        if "rtt min/avg/max" in line or "round-trip min/avg/max" in line:
            value = line.split("=", 1)[1].strip().split()[0].split("/")[1]
            return float(value)
    raise RuntimeError(f"could not parse ping output: {stdout}")


def choose_path(rankings: dict[str, list[dict[str, Any]]], source: TestNode, destination: TestNode) -> tuple[str, str]:
    ingress = str(rankings[source.key][0]["gate"])
    egress = str(rankings[destination.key][0]["gate"])
    if ingress != egress:
        return ingress, egress
    for candidate in rankings[destination.key][1:]:
        candidate_name = str(candidate["gate"])
        if candidate_name != ingress:
            return ingress, candidate_name
    raise RuntimeError(f"could not find distinct egress gate for {source.key}->{destination.key}")


def run_hyperspace_matrix(args: argparse.Namespace, output_dir: Path) -> list[dict[str, Any]]:
    email = args.email or f"measurement-matrix-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}@example.net"
    password = args.password or generate_password()
    token = ensure_api_token(args.api_base, email, password)
    rankings = measure_gate_rankings(args, output_dir)
    results: list[dict[str, Any]] = []

    pair_index = 0
    for source in TESTNODES:
        for destination in TESTNODES:
            if source.key == destination.key:
                continue
            ingress_gate, egress_gate = choose_path(rankings, source, destination)
            pair_index += 1
            interface_name = f"hsow{pair_index:02d}"
            label = f"oneway-{source.key}-to-{destination.key}-{int(time.time())}"
            log(f"{source.key} -> {destination.key}: creating {ingress_gate} -> {egress_gate}")
            session_id: str | None = None
            started = time.monotonic()
            try:
                response = api_request(
                    args.api_base,
                    "/v1/public/sessions",
                    method="POST",
                    token=token,
                    body={
                        "mode": "IpToIp",
                        "label": label,
                        "sourceIp": source.public_ip,
                        "targetIp": destination.public_ip,
                        "ingressGateName": ingress_gate,
                        "egressGateName": egress_gate,
                    },
                )
                session_id = str(response["session"]["id"])
                active_session = wait_for_phase(args.api_base, token, session_id, {"active"}, args.active_timeout)
                artifact = download_client_config(args.api_base, token, session_id)
                config_text = str(artifact["payload"]["configText"])
                route_check, probe = run_hyperspace_probe(
                    source,
                    destination,
                    config_text,
                    interface_name,
                    args,
                )
                row = {
                    "mode": "hyperspace",
                    "source": node_json(source),
                    "destination": node_json(destination),
                    "path": {
                        "ingressGateName": ingress_gate,
                        "egressGateName": egress_gate,
                    },
                    "session": {
                        "id": session_id,
                        "phase": active_session["session"]["phase"],
                        "createdAt": active_session["session"].get("createdAt"),
                    },
                    "routeCheck": route_check,
                    "probe": probe,
                    "elapsed_seconds": time.monotonic() - started,
                }
                results.append(row)
                log_pair(row)
            finally:
                if session_id:
                    revoke_and_delete(args.api_base, token, session_id, args.revoke_timeout)

    write_json(output_dir / "hyperspace.json", results)
    return results


def wait_for_phase(api_base: str, token: str, session_id: str, phases: set[str], timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_response: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        last_response = api_request(api_base, f"/v1/public/sessions/{session_id}", token=token)
        phase = str(last_response["session"]["phase"])
        if phase in phases:
            return last_response
        if phase == "failed":
            raise RuntimeError(f"session {session_id} failed: {last_response}")
        time.sleep(1)
    raise TimeoutError(f"session {session_id} did not reach {sorted(phases)}; last={last_response}")


def download_client_config(api_base: str, token: str, session_id: str) -> dict[str, Any]:
    token_response = api_request(
        api_base,
        f"/v1/public/sessions/{session_id}/artifacts/client-config/download-token",
        method="POST",
        token=token,
        body={},
    )
    return api_request(api_base, str(token_response["downloadUrl"]), token=token)


def run_hyperspace_probe(
    source: TestNode,
    destination: TestNode,
    config_text: str,
    interface_name: str,
    args: argparse.Namespace,
) -> tuple[str, dict[str, Any]]:
    config_path = f"/tmp/{interface_name}.conf"
    ssh_command(
        source.host,
        args.ssh_key,
        f"umask 077; cat > {config_path}",
        input_text=config_text,
        timeout=30,
    )
    command = f"""
set -euo pipefail
wg-quick down {config_path} >/dev/null 2>&1 || true
cleanup() {{
  wg-quick down {config_path} >/dev/null 2>&1 || true
  rm -f {config_path}
}}
trap cleanup EXIT
wg-quick up {config_path} >/tmp/{interface_name}.up.log 2>&1
sleep {args.wg_warmup_seconds}
ip route get {destination.public_ip}
{args.probe_path} client {destination.public_ip} --port {args.probe_port} --count {args.count} --interval {args.interval} --timeout {args.timeout}
"""
    stdout = ssh_command(
        source.host,
        args.ssh_key,
        command,
        timeout=max(90, int(args.count * (args.interval + args.timeout)) + 45),
    )
    lines = stdout.strip().splitlines()
    if len(lines) < 2:
        raise RuntimeError(f"unexpected probe output from {source.key}: {stdout}")
    return lines[0], json.loads(lines[-1])


def revoke_and_delete(api_base: str, token: str, session_id: str, timeout_seconds: int) -> None:
    try:
        api_request(api_base, f"/v1/public/sessions/{session_id}/revoke", method="POST", token=token, body={})
        wait_for_phase(api_base, token, session_id, {"revoked"}, timeout_seconds)
        api_request(api_base, f"/v1/public/sessions/{session_id}", method="DELETE", token=token)
    except Exception as error:  # noqa: BLE001 - cleanup must not hide the measurement error
        print(f"cleanup failed for session {session_id}: {error}", file=sys.stderr, flush=True)


def log_pair(row: dict[str, Any]) -> None:
    source = row["source"]["key"]
    destination = row["destination"]["key"]
    probe = row["probe"]
    rtt = metric_p50(probe, "rtt_ms")
    forward = metric_p50(probe, "forward_one_way_ms")
    reverse = metric_p50(probe, "reverse_one_way_ms")
    loss = float(probe.get("loss_percent", 0))
    path = row.get("path")
    path_text = ""
    if path:
        path_text = f" via {path['ingressGateName']}->{path['egressGateName']}"
    log(
        f"{source}->{destination}{path_text}: "
        f"rtt_p50={rtt:.3f}ms fwd_p50={forward:.3f}ms rev_p50={reverse:.3f}ms loss={loss:.1f}%"
    )


def metric_p50(probe: dict[str, Any], name: str) -> float:
    metric = probe.get(name)
    if isinstance(metric, dict) and isinstance(metric.get("p50"), (int, float)):
        return float(metric["p50"])
    samples = probe.get("samples", [])
    values = [float(sample[name]) for sample in samples if name in sample and isinstance(sample[name], (int, float))]
    if not values:
        return float("nan")
    return float(statistics.median(values))


def node_json(node: TestNode) -> dict[str, str]:
    return {"key": node.key, "host": node.host, "publicIp": node.public_ip}


def generate_password() -> str:
    return "Tn!" + base64.urlsafe_b64encode(secrets.token_bytes(18)).decode("ascii")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"wrote {path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["public", "hyperspace", "all"], default="all")
    parser.add_argument("--inventory", type=Path, required=True, help="JSON file with testnodes and gates")
    parser.add_argument("--api-base", default=os.environ.get("HS_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--email", default=os.environ.get("HS_MATRIX_EMAIL"))
    parser.add_argument("--password", default=os.environ.get("HS_MATRIX_PASSWORD"))
    parser.add_argument("--ssh-key", default=os.environ.get("HS_TESTNODE_SSH_KEY", DEFAULT_SSH_KEY))
    parser.add_argument("--probe-path", default=DEFAULT_PROBE_PATH)
    parser.add_argument("--probe-port", type=int, default=DEFAULT_PROBE_PORT)
    parser.add_argument("--count", type=int, default=80)
    parser.add_argument("--interval", type=float, default=0.04)
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--active-timeout", type=int, default=90)
    parser.add_argument("--revoke-timeout", type=int, default=90)
    parser.add_argument("--wg-warmup-seconds", type=float, default=2.0)
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/hyperspace-measurements"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    global TESTNODES, GATES
    TESTNODES, GATES = load_inventory(args.inventory)
    args.ssh_key = os.path.expanduser(args.ssh_key)
    output_dir = args.output_dir
    if args.mode in {"public", "all"}:
        run_public_matrix(args, output_dir)
    if args.mode in {"hyperspace", "all"}:
        run_hyperspace_matrix(args, output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
