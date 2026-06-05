#!/usr/bin/env python3
"""UDP RTT and one-way latency probe for Hyperspace testnodes.

The client sends a timestamped UDP datagram. The server records its receive
timestamp and replies with both receive and transmit timestamps. RTT is measured
with the client monotonic clock. One-way values use CLOCK_REALTIME on both
hosts, so they are meaningful only when chrony/NTP sync quality is good.
"""

from __future__ import annotations

import argparse
import json
import socket
import statistics
import sys
import time
from typing import Any


MAGIC = "hyperspace-one-way-v1"


def now_wall_ns() -> int:
    return time.time_ns()


def now_mono_ns() -> int:
    return time.monotonic_ns()


def ns_to_ms(value: int | float) -> float:
    return float(value) / 1_000_000.0


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * percent
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def summarize(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"min": None, "p50": None, "p95": None, "max": None, "mean": None}
    return {
        "min": min(values),
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values),
        "mean": statistics.fmean(values),
    }


def compact_float(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


def compact_summary(summary: dict[str, float | None]) -> dict[str, float | None]:
    return {key: compact_float(value) for key, value in summary.items()}


def encode(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def decode(data: bytes) -> dict[str, Any]:
    payload = json.loads(data.decode("utf-8"))
    if payload.get("magic") != MAGIC:
        raise ValueError("unexpected probe magic")
    return payload


def run_server(args: argparse.Namespace) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.bind, args.port))
    print(
        json.dumps(
            {
                "event": "server_started",
                "bind": args.bind,
                "port": args.port,
            },
            sort_keys=True,
        ),
        flush=True,
    )

    while True:
        data, addr = sock.recvfrom(args.max_datagram_bytes)
        server_rx_wall_ns = now_wall_ns()
        try:
            request = decode(data)
        except Exception as error:  # noqa: BLE001 - diagnostic server path
            if args.verbose:
                print(json.dumps({"event": "bad_packet", "from": addr[0], "error": str(error)}), flush=True)
            continue

        response = {
            "magic": MAGIC,
            "kind": "response",
            "seq": request.get("seq"),
            "client_tx_wall_ns": request.get("client_tx_wall_ns"),
            "server_rx_wall_ns": server_rx_wall_ns,
            "server_tx_wall_ns": now_wall_ns(),
        }
        sock.sendto(encode(response), addr)


def run_client(args: argparse.Namespace) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(args.timeout)
    target = (args.host, args.port)
    samples: list[dict[str, Any]] = []
    lost = 0

    for seq in range(args.count):
        client_tx_wall_ns = now_wall_ns()
        client_tx_mono_ns = now_mono_ns()
        request = {
            "magic": MAGIC,
            "kind": "request",
            "seq": seq,
            "client_tx_wall_ns": client_tx_wall_ns,
            "pad": "x" * max(0, args.payload_bytes),
        }
        sock.sendto(encode(request), target)
        try:
            data, _addr = sock.recvfrom(args.max_datagram_bytes)
            client_rx_mono_ns = now_mono_ns()
            client_rx_wall_ns = now_wall_ns()
            response = decode(data)
            if response.get("kind") != "response" or response.get("seq") != seq:
                lost += 1
                continue
        except socket.timeout:
            lost += 1
            time.sleep(args.interval)
            continue

        server_rx_wall_ns = int(response["server_rx_wall_ns"])
        server_tx_wall_ns = int(response["server_tx_wall_ns"])
        sample = {
            "seq": seq,
            "rtt_ms": ns_to_ms(client_rx_mono_ns - client_tx_mono_ns),
            "forward_one_way_ms": ns_to_ms(server_rx_wall_ns - client_tx_wall_ns),
            "reverse_one_way_ms": ns_to_ms(client_rx_wall_ns - server_tx_wall_ns),
            "server_turnaround_ms": ns_to_ms(server_tx_wall_ns - server_rx_wall_ns),
        }
        samples.append(sample)
        if args.jsonl:
            print(json.dumps(sample, sort_keys=True), flush=True)
        time.sleep(args.interval)

    rtt = [float(sample["rtt_ms"]) for sample in samples]
    forward = [float(sample["forward_one_way_ms"]) for sample in samples]
    reverse = [float(sample["reverse_one_way_ms"]) for sample in samples]
    result = {
        "target": args.host,
        "port": args.port,
        "sent": args.count,
        "received": len(samples),
        "lost": lost,
        "loss_percent": compact_float((lost / args.count) * 100 if args.count else 0),
        "rtt_ms": compact_summary(summarize(rtt)),
        "forward_one_way_ms": compact_summary(summarize(forward)),
        "reverse_one_way_ms": compact_summary(summarize(reverse)),
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if samples else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hyperspace testnode UDP RTT/one-way probe")
    subparsers = parser.add_subparsers(dest="command", required=True)

    server = subparsers.add_parser("server", help="run a UDP probe receiver")
    server.add_argument("--bind", default="0.0.0.0")
    server.add_argument("--port", type=int, default=19191)
    server.add_argument("--max-datagram-bytes", type=int, default=4096)
    server.add_argument("--verbose", action="store_true")
    server.set_defaults(func=run_server)

    client = subparsers.add_parser("client", help="run UDP probes against a receiver")
    client.add_argument("host")
    client.add_argument("--port", type=int, default=19191)
    client.add_argument("--count", type=int, default=60)
    client.add_argument("--interval", type=float, default=0.05)
    client.add_argument("--timeout", type=float, default=1.0)
    client.add_argument("--payload-bytes", type=int, default=0)
    client.add_argument("--max-datagram-bytes", type=int, default=4096)
    client.add_argument("--jsonl", action="store_true", help="print per-sample JSON lines before summary")
    client.set_defaults(func=run_client)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
