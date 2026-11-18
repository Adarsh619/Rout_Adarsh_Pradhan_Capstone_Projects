import { config } from "../../config.js";

// Shared demo accounts on the public live site (DEMO_MODE=true).
// The seed creates two companies whose logins are published on the sign-in page. On a public deployment anyone can
// use them, so they can't change their password or profile (one visitor could lock everyone else out), and a
// nightly job rebuilds the demo data (src/modules/demo).

export const DEMO_WORKSPACES = ["acme", "globex"] as const;
export const DEMO_EMAIL_DOMAINS = DEMO_WORKSPACES.map((slug) => `${slug}.test`);
export const DEMO_PASSWORD = "demo12345";

export const DEMO_ACCOUNT_MESSAGE =
  "This is a shared demo account, so its password and profile can't be changed. " +
  "Create your own account to try these settings.";

// True for the published demo logins (owner@acme.test, member2@globex.test, ...).
export function isDemoAccount(user: { email: string } | null | undefined): boolean {
  const email = (user?.email ?? "").toLowerCase();
  return DEMO_EMAIL_DOMAINS.includes(email.slice(email.lastIndexOf("@") + 1));
}

// Demo accounts are only locked on a public demo deployment; locally they behave like any other account.
export function isLockedDemoAccount(user: { email: string } | null | undefined): boolean {
  return config.DEMO_MODE && isDemoAccount(user);
}
