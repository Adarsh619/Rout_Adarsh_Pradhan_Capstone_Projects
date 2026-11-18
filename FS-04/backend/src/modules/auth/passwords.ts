import bcrypt from "bcryptjs";

// Password hashing and the strength rules v1 enforced (Django's four default validators, same messages).

// Tests lower the cost (like v1's fast test hasher); 10 rounds is ~60 ms per hash on the live 0.1-CPU container.
export const hashing = { rounds: process.env.VITEST ? 4 : 10 };

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, hashing.rounds);
export const checkPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

// A bcrypt hash of a random string: comparing against it keeps "unknown email" as slow as "wrong password".
let dummyHash: string | undefined;
export const burnTime = (password: string) => {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", hashing.rounds);
  return bcrypt.compare(password, dummyHash);
};

// The most common passwords (a short version of the list Django checks against).
const COMMON = new Set(
  `password password1 password12 password123 passw0rd 12345678 123456789 1234567890 qwerty qwertyuiop qwerty123
  1q2w3e4r 1q2w3e4r5t iloveyou sunshine princess football baseball welcome welcome1 abc12345 admin123 letmein
  letmein1 monkey123 dragon123 trustno1 superman batman123 starwars whatever freedom master123 shadow123 michael
  jennifer jordan23 hunter22 computer internet charlie1 asdfghjk asdfghjkl zxcvbnm1 zaq12wsx 1qaz2wsx changeme
  secret123 test1234 testtest 11111111 00000000 88888888 12341234 87654321 abcd1234 aa123456 qwer1234 google123
  linkedin facebook samsung123 pokemon1 chocolate butterfly whatever1 loveme123 ilovegod hello123 helloworld
  administrator default guest1234 demo1234 summer2024 winter2024 spring2024 autumn2024 password!`.split(/\s+/),
);

// Ratcliff/Obershelp similarity, the same measure as Python's difflib.SequenceMatcher.ratio().
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (x: string, y: string): number => {
    if (!x.length || !y.length) return 0;
    let best = 0;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < y.length; j++) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
        if (k > best) [best, bi, bj] = [k, i, j];
      }
    }
    if (!best) return 0;
    return best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best));
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

const MAX_SIMILARITY = 0.7;

// Every rule the password breaks (empty = strong enough). `email` and `fullName` are compared with it.
export function passwordProblems(password: string, user: { email?: string; fullName?: string }): string[] {
  const problems: string[] = [];
  const lower = password.toLowerCase();
  const attributes: Array<[string, string | undefined]> = [
    ["email address", user.email],
    ["full name", user.fullName],
  ];
  for (const [label, value] of attributes) {
    if (!value) continue;
    const parts = [value, ...value.split(/\W+/)].map((p) => p.toLowerCase()).filter((p) => p.length);
    if (parts.some((part) => similarity(lower, part) >= MAX_SIMILARITY)) {
      problems.push(`The password is too similar to the ${label}.`);
      break;
    }
  }
  if (password.length < 8) problems.push("This password is too short. It must contain at least 8 characters.");
  if (COMMON.has(lower)) problems.push("This password is too common.");
  if (/^\d+$/.test(password)) problems.push("This password is entirely numeric.");
  return problems;
}
