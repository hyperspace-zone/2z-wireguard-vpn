type WorkerRole = "scheduler" | "reconciler" | "expiry";

const roles: WorkerRole[] = ["scheduler", "reconciler", "expiry"];

function logStartup(): void {
  const payload = {
    service: "control-plane-worker",
    roles,
    now: new Date().toISOString()
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

logStartup();
