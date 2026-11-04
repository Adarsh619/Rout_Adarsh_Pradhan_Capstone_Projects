import type { RequestHandler } from "express";
import type { Redis } from "ioredis";
import type { Storage } from "../lib/s3.js";

// What every feature router needs, built once in createApp.
export interface RouteContext {
  redis: Redis;
  storage: Storage;
  // requireAuth bound to this app's token signer and session store.
  signedIn: RequestHandler;
}
