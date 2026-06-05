#!/usr/bin/env python3
"""Compare public and Hyperspace testnode measurement JSON files."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Comparison:
    source: str
    destination: str
    path: str
    public_rtt: float
    hyperspace_rtt: float
    delta_rtt: float
    public_forward: float
    hyperspace_forward: float
    delta_forward: float
    public_reverse: float
    hyperspace_reverse: float
    delta_reverse: float
    public_loss: float
    hyperspace_loss: float


def load_rows(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def pair_key(row: dict[str, Any]) -> tuple[str, str]:
    if "source" in row and "destination" in row:
        return str(row["source"]["key"]), str(row["destination"]["key"])
    return str(row["src"]), str(row["dst"])


def probe(row: dict[str, Any]) -> dict[str, Any]:
    return row["probe"] if "probe" in row else row


def metric(row: dict[str, Any], name: str) -> float:
    value = probe(row).get(name)
    if isinstance(value, dict) and isinstance(value.get("p50"), (int, float)):
        return float(value["p50"])
    raise KeyError(f"{name}.p50 missing from row {pair_key(row)}")


def loss(row: dict[str, Any]) -> float:
    return float(probe(row).get("loss_percent", 0.0))


def path_text(row: dict[str, Any]) -> str:
    path = row.get("path") or {}
    ingress = path.get("ingressGateName")
    egress = path.get("egressGateName")
    if ingress and egress:
        return f"{ingress} -> {egress}"
    return "-"


def compare(public_rows: list[dict[str, Any]], hyperspace_rows: list[dict[str, Any]]) -> list[Comparison]:
    public = {pair_key(row): row for row in public_rows}
    hyperspace = {pair_key(row): row for row in hyperspace_rows}
    missing = sorted(set(public) ^ set(hyperspace))
    if missing:
        raise RuntimeError(f"public/hyperspace pair mismatch: {missing}")

    comparisons: list[Comparison] = []
    for source, destination in sorted(public):
        public_row = public[(source, destination)]
        hyperspace_row = hyperspace[(source, destination)]
        public_rtt = metric(public_row, "rtt_ms")
        hyperspace_rtt = metric(hyperspace_row, "rtt_ms")
        public_forward = metric(public_row, "forward_one_way_ms")
        hyperspace_forward = metric(hyperspace_row, "forward_one_way_ms")
        public_reverse = metric(public_row, "reverse_one_way_ms")
        hyperspace_reverse = metric(hyperspace_row, "reverse_one_way_ms")
        comparisons.append(
            Comparison(
                source=source,
                destination=destination,
                path=path_text(hyperspace_row),
                public_rtt=public_rtt,
                hyperspace_rtt=hyperspace_rtt,
                delta_rtt=public_rtt - hyperspace_rtt,
                public_forward=public_forward,
                hyperspace_forward=hyperspace_forward,
                delta_forward=public_forward - hyperspace_forward,
                public_reverse=public_reverse,
                hyperspace_reverse=hyperspace_reverse,
                delta_reverse=public_reverse - hyperspace_reverse,
                public_loss=loss(public_row),
                hyperspace_loss=loss(hyperspace_row),
            )
        )
    return comparisons


def render_markdown(comparisons: list[Comparison], *, public_file: Path, hyperspace_file: Path) -> str:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    improved = [row for row in comparisons if row.delta_rtt > 0]
    regressed = [row for row in comparisons if row.delta_rtt < 0]
    best = sorted(comparisons, key=lambda row: row.delta_rtt, reverse=True)[:5]
    worst = sorted(comparisons, key=lambda row: row.delta_rtt)[:5]

    lines = [
        "# Testnode Public vs Hyperspace Measurements",
        "",
        f"Generated at: `{generated_at}`.",
        "",
        f"Public source file: `{public_file}`.",
        f"Hyperspace source file: `{hyperspace_file}`.",
        "",
        "RTT is measured with the source node monotonic clock. One-way values use",
        "wall-clock timestamps from both nodes, so they require tight NTP/chrony",
        "synchronization and should be treated as approximate directional diagnostics.",
        "",
        "Positive delta means Hyperspace was faster. Negative delta means public",
        "Internet was faster for that directed pair and sample window.",
        "",
        "## Summary",
        "",
        f"- Directed pairs measured: `{len(comparisons)}`.",
        f"- Hyperspace faster by RTT p50: `{len(improved)}` pairs.",
        f"- Public Internet faster by RTT p50: `{len(regressed)}` pairs.",
        f"- Zero packet loss in public runs: `{all(row.public_loss == 0 for row in comparisons)}`.",
        f"- Zero packet loss in Hyperspace runs: `{all(row.hyperspace_loss == 0 for row in comparisons)}`.",
        "",
        "## Biggest RTT Improvements",
        "",
        comparison_table(best),
        "",
        "## Biggest RTT Regressions",
        "",
        comparison_table(worst),
        "",
        "## Full Directed Matrix",
        "",
        comparison_table(comparisons),
        "",
    ]
    return "\n".join(lines)


def comparison_table(rows: list[Comparison]) -> str:
    header = (
        "| Pair | Hyperspace path | Public RTT p50 | Hyperspace RTT p50 | "
        "Delta RTT | Public fwd | Hyperspace fwd | Delta fwd | Public rev | Hyperspace rev | Delta rev |"
    )
    separator = "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    lines = [header, separator]
    for row in rows:
        lines.append(
            "| "
            f"`{row.source}->{row.destination}` | "
            f"`{row.path}` | "
            f"{row.public_rtt:.1f} ms | "
            f"{row.hyperspace_rtt:.1f} ms | "
            f"{row.delta_rtt:+.1f} ms | "
            f"{row.public_forward:.1f} ms | "
            f"{row.hyperspace_forward:.1f} ms | "
            f"{row.delta_forward:+.1f} ms | "
            f"{row.public_reverse:.1f} ms | "
            f"{row.hyperspace_reverse:.1f} ms | "
            f"{row.delta_reverse:+.1f} ms |"
        )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--hyperspace", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    comparisons = compare(load_rows(args.public), load_rows(args.hyperspace))
    markdown = render_markdown(comparisons, public_file=args.public, hyperspace_file=args.hyperspace)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(markdown + "\n", encoding="utf-8")
        print(f"wrote {args.output}")
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
