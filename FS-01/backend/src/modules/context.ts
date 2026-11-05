import type { Client } from "@elastic/elasticsearch";
import type { RequestHandler } from "express";
import type { Redis } from "ioredis";
import type { Storage } from "../lib/s3.js";
import type { SearchSync } from "./search/search-sync.js";

// What every feature router needs, built once in createApp.
export interface RouteContext {
  redis: Redis;
  storage: Storage;
  es: Client;
  // The alias searches read from.
  searchIndex: string;
  // Tells search about changes to products, stores and categories.
  searchSync: SearchSync;
  // requireAuth bound to this app's token signer and session store.
  signedIn: RequestHandler;
}
