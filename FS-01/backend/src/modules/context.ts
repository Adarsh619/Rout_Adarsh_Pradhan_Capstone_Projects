import type { Client } from "@elastic/elasticsearch";
import type { RequestHandler } from "express";
import type { Redis } from "ioredis";
import type { Storage } from "../lib/s3.js";
import type { CookieSettings } from "./cart/cart.routes.js";
import type { ReservationScheduler } from "./orders/reservations.js";
import type { PaymentProvider } from "./payments/payment-provider.js";
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
  // Same, but lets guests through (req.auth stays empty); a token that is sent must still be valid.
  maybeSignedIn: RequestHandler;
  // Cookie attributes for this deployment (Secure + SameSite=None on the live site).
  cookies: CookieSettings;
  payments: PaymentProvider;
  // Hands reserved stock back when an order isn't paid in time.
  reservations: ReservationScheduler;
  reservationMinutes: number;
}
