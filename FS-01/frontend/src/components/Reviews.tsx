import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { postReview, reviewsKey, useReviews, type Review } from "../api/reviews";
import { FormError } from "./Field";
import { Pagination } from "./Catalog";

const Stars = ({ value }: { value: number }) => (
  <span className="text-amber-500" aria-label={`${value} out of 5 stars`}>
    {"★".repeat(value)}
    <span className="text-slate-300">{"★".repeat(5 - value)}</span>
  </span>
);

function ReviewItem({ review }: { review: Review }) {
  return (
    <li className="space-y-1 py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Stars value={review.rating} />
        {review.title && <span className="font-medium">{review.title}</span>}
      </div>
      <p className="text-sm text-slate-700">{review.body}</p>
      <p className="text-xs text-slate-500">
        {review.authorName} · {new Date(review.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
        {review.verified && <span className="ml-2 font-medium text-emerald-700">Verified purchase</span>}
      </p>
    </li>
  );
}

function ReviewForm({ productId, onDone }: { productId: string; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(undefined);
    try {
      await postReview(productId, { rating, title, body });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't post your review. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Write a review" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <p className="font-medium">Write a review</p>
      <FormError message={error} />
      <fieldset>
        <legend className="text-sm text-slate-700">Your rating</legend>
        <div className="mt-1 flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              aria-pressed={rating === n}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              className={`text-2xl leading-none ${n <= rating ? "text-amber-500" : "text-slate-300"} hover:text-amber-400`}
            >
              ★
            </button>
          ))}
        </div>
        {errors.rating && <p className="mt-1 text-xs text-red-700">{errors.rating}</p>}
      </fieldset>
      <label className="block text-sm">
        Title (optional)
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
      </label>
      <label className="block text-sm">
        Your review
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          rows={4}
          aria-invalid={errors.body ? true : undefined}
          className={`mt-1 block w-full rounded-lg border px-3 py-2 ${errors.body ? "border-red-500" : "border-slate-300"}`}
        />
        {errors.body && <span className="mt-1 block text-xs text-red-700">{errors.body}</span>}
      </label>
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? "Posting…" : "Post review"}
      </button>
    </form>
  );
}

// The reviews section of a product page: summary with a star breakdown, the newest reviews, and a form for customers
// whose order with this product was delivered.
export function Reviews({ productId }: { productId: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const { data, isPending, isError } = useReviews(productId, page);

  if (isPending) return <p className="text-sm text-slate-500">Loading reviews…</p>;
  if (isError) return <p className="text-sm text-slate-500">Reviews couldn't be loaded.</p>;

  const { summary, viewer } = data;
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: reviewsKey(productId) });
    await queryClient.invalidateQueries({ queryKey: ["product", productId] });
  };

  return (
    <section id="reviews" aria-labelledby="reviews-title" className="space-y-4">
      <h2 id="reviews-title" className="text-xl font-semibold">
        Customer reviews
      </h2>
      {summary.ratingCount === 0 ? (
        <p className="text-sm text-slate-600">No reviews yet.</p>
      ) : (
        <div className="flex flex-wrap items-start gap-8">
          <div>
            <p className="text-3xl font-semibold">{summary.ratingAvg.toFixed(1)}</p>
            <p className="text-sm text-slate-500">
              {summary.ratingCount} {summary.ratingCount === 1 ? "review" : "reviews"}
            </p>
          </div>
          <ul className="min-w-48 space-y-1 text-sm" aria-label="Ratings breakdown">
            {(["5", "4", "3", "2", "1"] as const).map((s) => (
              <li key={s} className="flex items-center gap-2">
                <span className="w-10">{s} star</span>
                <span className="h-2 w-32 overflow-hidden rounded-full bg-slate-200">
                  <span className="block h-full bg-amber-500" style={{ width: `${(summary.stars[s] / summary.ratingCount) * 100}%` }} />
                </span>
                <span className="text-slate-500">{summary.stars[s]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {viewer?.canReview && <ReviewForm productId={productId} onDone={done} />}
      {viewer?.reason === "already_reviewed" && <p className="text-sm text-slate-600">Thanks, you've reviewed this product.</p>}
      {viewer?.reason === "not_delivered" && <p className="text-sm text-slate-500">You can review this product once an order with it has been delivered to you.</p>}

      {data.items.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {data.items.map((r) => (
            <ReviewItem key={r.id} review={r} />
          ))}
        </ul>
      )}
      <Pagination page={data} onPage={setPage} />
    </section>
  );
}
