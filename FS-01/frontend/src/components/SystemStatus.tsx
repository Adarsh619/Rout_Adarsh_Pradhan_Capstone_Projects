import { useHealth } from "../api/health";

const LABELS: Record<string, string> = {
  mongo: "Database (MongoDB)",
  redis: "Cache & queues (Redis)",
  elasticsearch: "Search (Elasticsearch)",
  s3: "File storage (S3)",
};

export function SystemStatus() {
  const { data, isPending, isError } = useHealth();

  return (
    <section aria-labelledby="status-heading" className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="status-heading" className="font-semibold">
          System status
        </h2>
        {data && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              data.status === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {data.status === "ok" ? "All systems up" : "Some services down"}
          </span>
        )}
      </div>

      {isPending && <p className="text-sm text-slate-500">Checking services…</p>}
      {isError && <p className="text-sm text-red-700">The API is not reachable right now.</p>}
      {data && (
        <ul className="divide-y divide-slate-100">
          {Object.entries(data.services).map(([name, state]) => (
            <li key={name} className="flex items-center justify-between py-2 text-sm">
              <span>{LABELS[name] ?? name}</span>
              <span className={state === "up" ? "text-emerald-700" : "text-red-700"}>
                <span aria-hidden="true">{state === "up" ? "● " : "○ "}</span>
                {state === "up" ? "Up" : "Down"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
