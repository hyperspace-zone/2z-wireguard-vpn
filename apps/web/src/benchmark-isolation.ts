export const benchmarkRequestTimeoutMs = 10_000;

export function shouldLoadBenchmarkMatrix(view: string): boolean {
  return view === "benchmarks";
}
