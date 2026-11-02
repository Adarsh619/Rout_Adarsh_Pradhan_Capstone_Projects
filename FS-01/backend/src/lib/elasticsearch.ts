import { Client } from "@elastic/elasticsearch";

export function createElasticsearch(url: string): Client {
  return new Client({ node: url, requestTimeout: 10_000 });
}

export async function pingElasticsearch(es: Client): Promise<void> {
  const health = await es.cluster.health();
  if (health.status === "red") throw new Error("cluster status red");
}
