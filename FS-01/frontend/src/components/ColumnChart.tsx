import { useId, useState } from "react";

export interface ColumnDatum {
  day: string; // YYYY-MM-DD
  value: number;
  // Extra line shown in the tooltip and table, e.g. "3 orders".
  note?: string;
}

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 24, right: 8, bottom: 28, left: 64 };
const BAR_COLOR = "#4f46e5"; // brand-600; checked for lightness, chroma and 3:1 contrast on the page background

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });

// A "nice" top for the y axis, so gridlines fall on round numbers.
function niceMax(max: number) {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= max) ?? 10 * pow;
  return step * 4;
}

// One value per day as columns: thin bars from a single baseline, a quiet grid, the peak labelled, a tooltip on
// hover or keyboard focus, and the same numbers as a table for anyone who can't (or would rather not) read the chart.
export function ColumnChart({ title, data, format }: { title: string; data: ColumnDatum[]; format: (v: number) => string }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(2, slot * 0.62));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  const labelEvery = Math.ceil(data.length / 6);
  const empty = data.every((d) => d.value === 0);

  // Column with a 4px rounded top and a square base on the baseline.
  const column = (x: number, top: number, w: number) => {
    const h = PAD.top + plotH - top;
    const r = Math.min(4, w / 2, h);
    return `M${x},${PAD.top + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PAD.top + plotH} Z`;
  };

  const tip = active !== null ? data[active] : undefined;

  return (
    <figure className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <figcaption id={`${id}-title`} className="font-semibold">
          {title}
        </figcaption>
        <button type="button" onClick={() => setAsTable((t) => !t)} className="text-sm text-brand-700 underline">
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-1.5 font-medium">Day</th>
                <th className="px-3 py-1.5 text-right font-medium">Value</th>
                {data.some((d) => d.note) && <th className="px-3 py-1.5 text-right font-medium">Orders</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-t border-slate-100">
                  <td className="px-3 py-1">{dayLabel(d.day, { day: "numeric", month: "short", year: "numeric" })}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{format(d.value)}</td>
                  {d.note !== undefined && <td className="px-3 py-1 text-right text-slate-600">{d.note}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="group" aria-labelledby={`${id}-title`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#94a3b8" : "#e2e8f0"} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#64748b">
                  {format(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2;
              return (
                <g key={d.day}>
                  {d.value > 0 && <path d={column(x, y(d.value), barW)} fill={BAR_COLOR} opacity={active === null || active === i ? 1 : 0.55} />}
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill="#64748b">
                      {dayLabel(d.day)}
                    </text>
                  )}
                  {/* The whole column slot is the hover/focus target, bigger than the bar itself. */}
                  <rect
                    x={PAD.left + i * slot}
                    y={PAD.top}
                    width={slot}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={`${dayLabel(d.day, { day: "numeric", month: "long" })}: ${format(d.value)}${d.note ? `, ${d.note}` : ""}`}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className="cursor-default outline-none focus:fill-slate-900/5"
                  />
                </g>
              );
            })}
            {!empty && data[peak] && (
              <text x={PAD.left + peak * slot + slot / 2} y={y(data[peak].value) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="#334155">
                {format(data[peak].value)}
              </text>
            )}
          </svg>
          {empty && <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">Nothing in this period</p>}
          {tip && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-md"
              style={{ left: `${Math.min(80, Math.max(0, ((PAD.left + (active ?? 0) * slot) / WIDTH) * 100))}%` }}
            >
              <p className="font-semibold tabular-nums">{format(tip.value)}</p>
              <p className="text-slate-600">
                {dayLabel(tip.day, { weekday: "short", day: "numeric", month: "short" })}
                {tip.note && ` · ${tip.note}`}
              </p>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

// A headline number with its label and an optional line of context.
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

// Last 7 / 30 / 90 days, in one row above the charts.
export const RANGES = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

export const rangeFor = (days: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to: today };
};

export function RangePicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div role="group" aria-label="Period" className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
      {RANGES.map((r) => (
        <button
          key={r.days}
          type="button"
          aria-pressed={days === r.days}
          onClick={() => onChange(r.days)}
          className={`rounded-md px-3 py-1 ${days === r.days ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-slate-50"}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
