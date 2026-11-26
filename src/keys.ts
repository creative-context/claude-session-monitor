// Who may act on a session, beyond the host check and the x-csm header every route has:
//
//  - The app's window: a key the app makes anew at each start of this server and gives its page
//    only when this server (by its pid) answers, never on disk or in a process's environment;
//    the server gets only its SHA-256 (CSM_PAGE_KEY_SHA256). Sending an answer as a session's
//    next prompt and allowing or denying a permission need it. A page in a browser has no key
//    and only looks; so does a session's own shell, which can reach this server and read the
//    data folder. A key a page sent to a program that took the port is worthless to the next start.
//  - The plugin: a key the server writes at each start to plugin.key in the data folder (0600,
//    the folder 0700), never sent over the wire. The plugin's ask for an answer and its hold on
//    a permission carry a fresh x-csm-nonce and x-csm-plugin = HMAC-SHA256(key, "plugin:" +
//    nonce), and every reply to them carries x-csm-proof = HMAC-SHA256(key, "server:" + nonce),
//    so each side proves it knows the key without giving it away. That keeps out programs of
//    other users and a shell sandboxed away from the data folder; a program running as you
//    can read plugin.key, as it can your settings, and the plugin can't tell it from the app.
//
// Neither key can do the other's part. Pinning and opening a session keep the header alone.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, PORT } from "./config.ts";

export const PLUGIN_KEY_FILE = join(DIR, "plugin.key");
const PAGE_KEY_SHA256 = (process.env.CSM_PAGE_KEY_SHA256 ?? "").toLowerCase();
let pluginKey = "";

// At start: the folder only for you, and a new plugin key in it, written whole. Only by the
// server on the plugin's port (4747), or with a folder of its own (CSM_DIR, as tests set): a
// server run by hand on another port must not replace the app's key under its plugins.
export function makePluginKey() {
  try { chmodSync(DIR, 0o700); } catch {}
  if (PORT !== 4747 && !process.env.CSM_DIR) return;
  pluginKey = randomBytes(32).toString("hex");
  const tmp = `${PLUGIN_KEY_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, pluginKey + "\n", { mode: 0o600 });
  renameSync(tmp, PLUGIN_KEY_FILE);
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// The app's window: its key, hashed, matches the one the app gave the server.
export function fromPage(req: Request): boolean {
  const key = req.headers.get("x-csm-key");
  if (!PAGE_KEY_SHA256 || !key || key.length > 200) return false;
  return same(createHash("sha256").update(key).digest("hex"), PAGE_KEY_SHA256);
}

const NONCE = /^[0-9A-Za-z]{8,128}$/;
const mac = (side: "plugin" | "server", nonce: string) => createHmac("sha256", pluginKey).update(`${side}:${nonce}`).digest("hex");

// The plugin: its proof that it knows the key from plugin.key, for this request's nonce.
export function fromPlugin(req: Request): boolean {
  const nonce = req.headers.get("x-csm-nonce") ?? "";
  const proof = req.headers.get("x-csm-plugin") ?? "";
  return !!pluginKey && NONCE.test(nonce) && same(proof.toLowerCase(), mac("plugin", nonce));
}

// A reply to the plugin, with the proof that this server knows the key.
export async function signed(req: Request, reply: Response | Promise<Response>): Promise<Response> {
  const r = await reply;
  const nonce = req.headers.get("x-csm-nonce") ?? "";
  if (!NONCE.test(nonce) || !pluginKey) return r;
  const headers = new Headers(r.headers);
  headers.set("x-csm-proof", mac("server", nonce));
  return new Response(r.body, { status: r.status, headers });
}
