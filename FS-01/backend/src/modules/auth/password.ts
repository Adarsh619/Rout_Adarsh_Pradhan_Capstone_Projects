import bcrypt from "bcryptjs";
import { z } from "zod";

// bcrypt only uses the first 72 bytes of a password, so longer ones are rejected instead of silently truncated.
const MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .refine((p) => Buffer.byteLength(p, "utf8") <= MAX_BYTES, "Use at most 72 characters")
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Use at least one letter and one number");

export const hashPassword = (password: string, cost: number): Promise<string> => bcrypt.hash(password, cost);

export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

// Compared against when the email doesn't exist, so a wrong email takes as long as a wrong password
// and response times don't reveal which accounts exist.
let dummyHash: string | undefined;
export async function burnPasswordCheck(password: string, cost: number): Promise<void> {
  dummyHash ??= await bcrypt.hash("not-a-real-password-0", cost);
  await bcrypt.compare(password, dummyHash);
}
