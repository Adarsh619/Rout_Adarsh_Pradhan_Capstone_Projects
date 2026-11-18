import { config } from "../../config.js";
import { isLockedDemoAccount } from "./demo.js";

interface UserLike {
  id: number;
  email: string;
  fullName: string;
}

export const displayName = (u: UserLike): string => u.fullName || u.email.split("@")[0]!;

export const userOut = (u: UserLike) => ({
  id: u.id,
  email: u.email,
  full_name: u.fullName,
  display_name: displayName(u),
});

export const userOrNull = (u: UserLike | null | undefined) => (u ? userOut(u) : null);

// The signed-in user, plus what the app needs to know about the public demo.
export const meOut = (u: UserLike) => ({
  ...userOut(u),
  demo_mode: config.DEMO_MODE,
  is_demo_account: isLockedDemoAccount(u),
});
