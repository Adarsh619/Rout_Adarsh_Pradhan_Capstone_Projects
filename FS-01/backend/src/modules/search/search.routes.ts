import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { AppError } from "../../middleware/errors.js";
import { parseQuery } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import type { ProductSearchDoc } from "./search-mapping.js";
import { buildSearchRequest, buildSuggestRequest, searchParams, suggestParams, toSearchResponse } from "./search-query.js";

// Elasticsearch being down breaks search only, never the rest of the shop.
const unavailable = (err: unknown) => {
  logger.error({ err }, "search failed");
  return new AppError(503, "search_unavailable", "Search is temporarily unavailable. Please try again shortly.");
};

export function searchRouter(ctx: RouteContext): Router {
  const router = Router();

  router.get("/search", async (req, res) => {
    const params = parseQuery(searchParams, req);
    const run = (relaxed: boolean) =>
      ctx.es.search<ProductSearchDoc>(buildSearchRequest(params, ctx.searchIndex, relaxed)).catch((err: unknown) => {
        throw unavailable(err);
      });
    let result = await run(false);
    let matchedAllWords = true;
    // Nothing has every word: show what has most of them ("red dress" → dresses), and say so.
    const total = (r: typeof result) => (typeof r.hits.total === "number" ? r.hits.total : (r.hits.total?.value ?? 0));
    if (total(result) === 0 && (params.q?.split(/\s+/).length ?? 0) > 1) {
      result = await run(true);
      matchedAllWords = false;
    }
    res.json({ ...toSearchResponse(result, params, ctx.storage), matchedAllWords, tookMs: result.took });
  });

  router.get("/search/suggest", async (req, res) => {
    const { q } = parseQuery(suggestParams, req);
    const result = await ctx.es.search<Pick<ProductSearchDoc, "id" | "title">>(buildSuggestRequest(q, ctx.searchIndex)).catch((err: unknown) => {
      throw unavailable(err);
    });
    res.json({ items: result.hits.hits.map((h) => ({ id: h._source!.id, title: h._source!.title })) });
  });

  return router;
}
