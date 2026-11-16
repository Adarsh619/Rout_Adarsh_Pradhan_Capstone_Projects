import { loadEnv } from "../config/env.js";
import { createElasticsearch } from "../lib/elasticsearch.js";
import { logger } from "../lib/logger.js";
import { connectDb, disconnectDb } from "../lib/db.js";
import { SearchIndexer } from "../modules/search/search-indexer.js";

// Rebuilds the search index from PostgreSQL with no downtime: a new index is filled, then the alias switches to it.
// Use after changing the mapping, or if the index ever drifts from the database.
//   npm run reindex                                   (local)
//   docker compose exec api node dist/scripts/reindex.js
async function main() {
  const env = loadEnv();
  await connectDb(env.DATABASE_URL);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const started = Date.now();
  const { index, indexed } = await new SearchIndexer(es, env.ES_INDEX).reindexAll();
  logger.info({ index, indexed, ms: Date.now() - started }, "reindex finished");
  await Promise.allSettled([disconnectDb(), es.close()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "reindex failed");
  process.exit(1);
});
