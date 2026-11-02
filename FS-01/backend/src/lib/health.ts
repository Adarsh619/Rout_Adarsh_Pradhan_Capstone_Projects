export type HealthCheck = () => Promise<void>;
export type ServiceStatus = "up" | "down";

export interface HealthReport {
  status: "ok" | "degraded";
  services: Record<string, ServiceStatus>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

// Runs every check in parallel; one slow or failing service never hides the others.
export async function runHealthChecks(
  checks: Record<string, HealthCheck>,
  timeoutMs = 2_000,
): Promise<HealthReport> {
  const names = Object.keys(checks);
  const results = await Promise.allSettled(names.map((name) => withTimeout(checks[name]!(), timeoutMs)));
  const services: Record<string, ServiceStatus> = {};
  results.forEach((result, i) => {
    services[names[i]!] = result.status === "fulfilled" ? "up" : "down";
  });
  const allUp = Object.values(services).every((s) => s === "up");
  return { status: allUp ? "ok" : "degraded", services };
}
