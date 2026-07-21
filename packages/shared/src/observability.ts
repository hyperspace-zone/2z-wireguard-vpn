export type HealthState = "starting" | "ready" | "degraded" | "failed" | "stopped";

export interface HealthComponentInput {
  state: HealthState;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HealthComponentSnapshot extends HealthComponentInput {
  name: string;
  updatedAt: string;
}

export interface HealthSnapshot {
  ok: boolean;
  service: string;
  state: HealthState;
  now: string;
  uptimeSeconds: number;
  components: HealthComponentSnapshot[];
}

export interface HealthRegistry {
  setComponent(name: string, input: HealthComponentInput): void;
  snapshot(): HealthSnapshot;
}

export type MetricKind = "counter" | "gauge" | "histogram";

export interface RawMetricEvent {
  kind: MetricKind;
  name: string;
  value: number;
  help?: string;
  labels?: Record<string, string | number | boolean>;
  buckets?: number[];
}

export interface RuntimeMetrics {
  record(event: RawMetricEvent): void;
  counter(name: string, value?: number, input?: MetricInput): void;
  gauge(name: string, value: number, input?: MetricInput): void;
  resetGauge(name: string): void;
  histogram(name: string, value: number, input?: MetricInput & { buckets?: number[] }): void;
  renderPrometheus(): string;
  stop(): void;
}

export interface MetricInput {
  help?: string;
  labels?: Record<string, string | number | boolean>;
}

interface RuntimeMetricsConfig {
  service: string;
  queueCapacity?: number;
  flushIntervalMs?: number;
}

interface MetricSeries {
  kind: MetricKind;
  name: string;
  help: string;
  labels: Record<string, string>;
  value: number;
  buckets?: number[];
  bucketCounts?: number[];
  count?: number;
  sum?: number;
}

const defaultHistogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createHealthRegistry(service: string): HealthRegistry {
  const startedAt = Date.now();
  const components = new Map<string, HealthComponentSnapshot>();

  return {
    setComponent(name, input): void {
      components.set(name, {
        name,
        state: input.state,
        ...(input.message ? { message: input.message } : {}),
        ...(input.details ? { details: input.details } : {}),
        updatedAt: new Date().toISOString()
      });
    },
    snapshot(): HealthSnapshot {
      const entries = [...components.values()].sort((left, right) => left.name.localeCompare(right.name));
      const state = overallHealthState(entries);
      return {
        ok: state !== "failed",
        service,
        state,
        now: new Date().toISOString(),
        uptimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
        components: entries
      };
    }
  };
}

export function createRuntimeMetrics(config: RuntimeMetricsConfig): RuntimeMetrics {
  const queueCapacity = config.queueCapacity ?? 10_000;
  const queue: RawMetricEvent[] = [];
  const series = new Map<string, MetricSeries>();
  let droppedEvents = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = setInterval(flush, config.flushIntervalMs ?? 1000);
  timer.unref?.();

  function record(event: RawMetricEvent): void {
    if (stopped || !Number.isFinite(event.value)) {
      return;
    }
    if (queue.length >= queueCapacity) {
      droppedEvents += 1;
      return;
    }
    queue.push(event);
  }

  function flush(): void {
    while (queue.length > 0) {
      const event = queue.shift();
      if (event) {
        applyMetricEvent(event);
      }
    }
    setGauge("runtime_metrics_queue_depth", queue.length, {
      help: "Number of raw metric events waiting to be aggregated.",
      labels: { service: config.service }
    });
    setGauge("runtime_metrics_dropped_events_total", droppedEvents, {
      help: "Number of raw metric events dropped because the non-blocking queue was full.",
      labels: { service: config.service }
    });
  }

  function applyMetricEvent(event: RawMetricEvent): void {
    const name = normalizeMetricName(event.name);
    const labels = normalizeLabels({ service: config.service, ...event.labels });
    const key = seriesKey(name, labels);
    if (event.kind === "histogram") {
      applyHistogramEvent(name, key, event, labels);
      return;
    }
    const existing = series.get(key);
    const metric: MetricSeries = existing ?? {
      kind: event.kind,
      name,
      help: event.help ?? name,
      labels,
      value: 0
    };
    metric.kind = event.kind;
    metric.help = event.help ?? metric.help;
    metric.value = event.kind === "counter" ? metric.value + event.value : event.value;
    series.set(key, metric);
  }

  function applyHistogramEvent(
    name: string,
    key: string,
    event: RawMetricEvent,
    labels: Record<string, string>
  ): void {
    const buckets = [...(event.buckets ?? defaultHistogramBuckets)].sort((left, right) => left - right);
    const existing = series.get(key);
    const metric: MetricSeries = existing ?? {
      kind: "histogram",
      name,
      help: event.help ?? name,
      labels,
      value: 0,
      buckets,
      bucketCounts: buckets.map(() => 0),
      count: 0,
      sum: 0
    };
    metric.help = event.help ?? metric.help;
    metric.count = (metric.count ?? 0) + 1;
    metric.sum = (metric.sum ?? 0) + event.value;
    for (const [index, bucket] of buckets.entries()) {
      if (event.value <= bucket) {
        metric.bucketCounts![index] = (metric.bucketCounts![index] ?? 0) + 1;
      }
    }
    series.set(key, metric);
  }

  function setGauge(name: string, value: number, input: MetricInput): void {
    const metricName = normalizeMetricName(name);
    const labels = normalizeLabels(input.labels ?? {});
    series.set(seriesKey(metricName, labels), {
      kind: "gauge",
      name: metricName,
      help: input.help ?? metricName,
      labels,
      value
    });
  }

  return {
    record,
    counter(name, value = 1, input = {}): void {
      record({ kind: "counter", name, value, ...input });
    },
    gauge(name, value, input = {}): void {
      record({ kind: "gauge", name, value, ...input });
    },
    resetGauge(name): void {
      flush();
      const metricName = normalizeMetricName(name);
      for (const [key, metric] of series.entries()) {
        if (metric.kind === "gauge" && metric.name === metricName) {
          series.delete(key);
        }
      }
    },
    histogram(name, value, input = {}): void {
      record({ kind: "histogram", name, value, ...input });
    },
    renderPrometheus(): string {
      flush();
      recordProcessMetrics(config.service, setGauge);
      return renderPrometheus(series);
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      flush();
    }
  };
}

function overallHealthState(components: HealthComponentSnapshot[]): HealthState {
  if (components.some((component) => component.state === "failed")) {
    return "failed";
  }
  if (components.some((component) => component.state === "degraded")) {
    return "degraded";
  }
  if (components.length === 0 || components.some((component) => component.state === "starting")) {
    return "starting";
  }
  if (components.every((component) => component.state === "stopped")) {
    return "stopped";
  }
  return "ready";
}

function recordProcessMetrics(
  service: string,
  setGauge: (name: string, value: number, input: MetricInput) => void
): void {
  const memory = process.memoryUsage();
  setGauge("process_uptime_seconds", process.uptime(), {
    help: "Process uptime in seconds.",
    labels: { service }
  });
  setGauge("process_heap_used_bytes", memory.heapUsed, {
    help: "Node.js heap bytes currently used.",
    labels: { service }
  });
  setGauge("process_resident_memory_bytes", memory.rss, {
    help: "Resident memory size in bytes.",
    labels: { service }
  });
}

function renderPrometheus(series: Map<string, MetricSeries>): string {
  const byName = new Map<string, MetricSeries[]>();
  for (const metric of series.values()) {
    const metrics = byName.get(metric.name) ?? [];
    metrics.push(metric);
    byName.set(metric.name, metrics);
  }

  const lines: string[] = [];
  for (const [name, metrics] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const first = metrics[0];
    if (!first) {
      continue;
    }
    lines.push(`# HELP ${name} ${escapeHelp(first.help)}`);
    lines.push(`# TYPE ${name} ${first.kind}`);
    for (const metric of metrics.sort((left, right) => labelString(left.labels).localeCompare(labelString(right.labels)))) {
      if (metric.kind === "histogram") {
        lines.push(...renderHistogram(metric));
      } else {
        lines.push(`${metric.name}${formatLabels(metric.labels)} ${formatNumber(metric.value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderHistogram(metric: MetricSeries): string[] {
  const lines: string[] = [];
  const buckets = metric.buckets ?? [];
  const counts = metric.bucketCounts ?? [];
  for (const [index, bucket] of buckets.entries()) {
    lines.push(`${metric.name}_bucket${formatLabels({ ...metric.labels, le: String(bucket) })} ${counts[index] ?? 0}`);
  }
  lines.push(`${metric.name}_bucket${formatLabels({ ...metric.labels, le: "+Inf" })} ${metric.count ?? 0}`);
  lines.push(`${metric.name}_sum${formatLabels(metric.labels)} ${formatNumber(metric.sum ?? 0)}`);
  lines.push(`${metric.name}_count${formatLabels(metric.labels)} ${metric.count ?? 0}`);
  return lines;
}

function normalizeMetricName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_:]/g, "_").replace(/^[^A-Za-z_:]/, "_");
  return normalized.startsWith("hyperspace_") ? normalized : `hyperspace_${normalized}`;
}

function normalizeLabels(input: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])
  );
}

function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}:${labelString(labels)}`;
}

function labelString(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
