import { PART_STATUS_LABEL, type PartStatus, type TimelineEntry } from "../api/orders";

const STEPS: PartStatus[] = ["placed", "packed", "shipped", "delivered"];

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// The journey of one store's part: the four delivery steps, ticked as they happen, or how it ended if cancelled.
export function OrderTimeline({ status, timeline }: { status: PartStatus; timeline: TimelineEntry[] }) {
  const at = (s: PartStatus) => timeline.find((t) => t.status === s);
  if (status === "cancelled" || status === "awaiting_payment") {
    const last = timeline[timeline.length - 1];
    return (
      <p className="text-sm text-slate-600">
        {PART_STATUS_LABEL[status]}
        {last && ` · ${when(last.at)}`}
        {last?.note && ` · ${last.note}`}
      </p>
    );
  }
  const reached = STEPS.indexOf(status);
  return (
    <ol className="grid grid-cols-4 gap-1 text-xs" aria-label="Delivery progress">
      {STEPS.map((step, i) => {
        const entry = at(step);
        const done = i <= reached;
        return (
          <li key={step} className="space-y-1" aria-current={i === reached ? "step" : undefined}>
            <div className={`h-1.5 rounded-full ${done ? "bg-emerald-600" : "bg-slate-200"}`} />
            <p className={done ? "font-medium text-slate-900" : "text-slate-400"}>
              {PART_STATUS_LABEL[step]}
              <span className="sr-only">{done ? " (done)" : " (not yet)"}</span>
            </p>
            {entry && <p className="text-slate-500">{when(entry.at)}</p>}
          </li>
        );
      })}
    </ol>
  );
}
