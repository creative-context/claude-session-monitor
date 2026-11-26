// The keys the server checks (src/keys.ts), for the tests and the demo.
//
//  - The page key: the app makes one at each launch, puts it in its page as window.__csmKey and gives
//    the server only its SHA-256 (CSM_PAGE_KEY_SHA256). Tests and the demo use this made-up one.
//  - The plugin key: the server writes it to plugin.key in its data folder at each start. The plugin
//    never sends it: it sends a fresh nonce (x-csm-nonce) and x-csm-plugin = HMAC-SHA256(key,
//    "plugin:" + nonce), and trusts a reply only when x-csm-proof = HMAC-SHA256(key, "server:" + nonce).

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Made up for the tests and the demo; it opens nothing real.
export const DEMO_PAGE_KEY = "d3a0c4e81f5b2976a4d8e0c3b71f5a29c6e84d0b3f7a15e92c8b6d4f0a3e7c15";
export const demoKeyHash = (key = DEMO_PAGE_KEY) => createHash("sha256").update(key).digest("hex");

// The page's headers for a route the window may use.
export const pageHeaders = (key = DEMO_PAGE_KEY): Record<string, string> => ({ "x-csm": "1", "x-csm-key": key });

// The plugin key the server at `dir` wrote, once it's there (the server writes it at start).
export async function readPluginKey(dir: string, waitMs = 15_000): Promise<string> {
  const file = join(dir, "plugin.key");
  for (const end = Date.now() + waitMs; ; ) {
    try {
      const key = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(key)) return key;
    } catch {}
    if (Date.now() > end) throw new Error(`no plugin.key in ${dir}`);
    await Bun.sleep(100);
  }
}
export const hasPluginKey = (dir: string) => existsSync(join(dir, "plugin.key"));

export const makeNonce = () => randomBytes(16).toString("hex");
const mac = (key: string, side: "plugin" | "server", nonce: string) => createHmac("sha256", key).update(`${side}:${nonce}`).digest("hex");
export const pluginProofOf = (key: string, nonce: string) => mac(key, "plugin", nonce); // what the plugin sends
export const proofOf = (key: string, nonce: string) => mac(key, "server", nonce); // what the server's reply carries

// The plugin's headers, with a fresh nonce; `nonce` is what to check the reply's proof against.
export function pluginHeaders(key: string, nonce = makeNonce()): { headers: Record<string, string>; nonce: string } {
  return { headers: { "x-csm": "1", "x-csm-plugin": pluginProofOf(key, nonce), "x-csm-nonce": nonce }, nonce };
}

// A fetch to a plugin route as the plugin makes it, and whether the reply's proof is the one for
// that nonce.
export async function pluginFetch(url: string, dir: string, init: RequestInit = {}): Promise<{ res: Response; proven: boolean }> {
  const key = await readPluginKey(dir);
  const { headers, nonce } = pluginHeaders(key);
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...headers } });
  return { res, proven: res.headers.get("x-csm-proof") === proofOf(key, nonce) };
}
