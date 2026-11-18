import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../../config.js";

// Keep outgoing webhooks pointed at the public internet.
//
// Without this, a workspace admin could register http://localhost:8000/…, http://db:5432, a cloud metadata address
// (169.254.169.254) or any other internal service, and the worker would POST to it from inside our network and
// show the response in the delivery log (server-side request forgery, SSRF). Two checks:
// - when a webhook is saved: http(s) only, no credentials in the URL, and no host that is obviously internal
//   (an IP literal in a private range, `localhost`, or a single-label name like `db` or `redis`);
// - right before each delivery: the host name is resolved and every address it resolves to must be public.
// Set WEBHOOK_ALLOW_PRIVATE_URLS=true only to test against a receiver on your own machine.

export class UnsafeURL extends Error {}
// The host couldn't be resolved right now; unlike a private address, this may fix itself.
export class HostLookupFailed extends UnsafeURL {}

// Every address `host` resolves to (tests replace this so they don't need DNS).
export const dns = {
  resolve: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address),
};

const v4 = (ip: string): number => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const inV4 = (ip: number, base: string, bits: number) => bits === 0 || ip >>> (32 - bits) === v4(base) >>> (32 - bits);

const V4_NOT_GLOBAL: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4Tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const n = v4(v4Tail[1]!);
    s = s.slice(0, -v4Tail[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? 8 - a.length - b.length : 0;
  const parts = [...a, ...Array<string>(fill).fill("0"), ...b].map((p) => Number.parseInt(p, 16));
  return parts.length === 8 && parts.every((p) => Number.isFinite(p)) ? parts : null;
}

export function isPublic(address: string): boolean {
  if (isIP(address) === 4) {
    const n = v4(address);
    return !V4_NOT_GLOBAL.some(([base, bits]) => inV4(n, base, bits));
  }
  const p = expandV6(address);
  if (!p) return false;
  // IPv4-mapped (::ffff:a.b.c.d): judge the IPv4 address.
  if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) {
    return isPublic(`${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`);
  }
  // Global unicast is 2000::/3, minus documentation (2001:db8::/32) and IETF special-purpose (2001::/23).
  if (p[0]! < 0x2000 || p[0]! > 0x3fff) return false;
  if (p[0] === 0x2001 && (p[1] === 0x0db8 || p[1]! < 0x200)) return false;
  return true;
}

// Throws UnsafeURL unless `url` is an http(s) URL on the public internet.
export async function checkUrl(url: string, resolveDns = false): Promise<void> {
  if (config.WEBHOOK_ALLOW_PRIVATE_URLS) return;
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    throw new UnsafeURL("Enter a valid URL.");
  }
  if (!["http:", "https:"].includes(parts.protocol)) throw new UnsafeURL("Webhook URLs must start with http:// or https://.");
  if (parts.username || parts.password) throw new UnsafeURL("Put credentials in a header on your side, not in the webhook URL.");
  const host = parts.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new UnsafeURL("The webhook URL has no host name.");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new UnsafeURL("Webhooks can't be sent to internal host names.");
  } else if (resolveDns) {
    try {
      addresses = await dns.resolve(host);
    } catch {
      throw new HostLookupFailed(`Couldn't resolve ${host}.`);
    }
  } else return;
  if (!addresses.every(isPublic)) throw new UnsafeURL("Webhooks can't be sent to private, loopback or link-local addresses.");
}
