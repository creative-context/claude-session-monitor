// Plays the plugin's answers side (plugin/) for the tests and the demo: for each session given,
// it asks the server for an answer the way the mod does (GET /api/answer/:sid/next, held up to
// 20 s), and when one comes, writes the UserPromptSubmit line the hook would write for it, so
// the session starts working on your answer.
//
// It plays the plugin's keys too: it reads plugin.key in the server's data folder (`dir`, which is
// where `log` is), sends it with a nonce, and takes an answer only when the reply's proof matches.
//
//   const mod = playMod({ port, log, dir, sids: [sid] });  …  mod.stop();

import { appendFileSync } from "node:fs";
import { pluginFetch } from "./keys.ts";

export type ModPlayer = {
  answered: { sid: string; text: string }[]; // what it submitted, in order
  stop: () => void;
};

export function playMod(o: {
  port: number;
  log: string; // the events.jsonl the server reads
  dir: string; // the server's data folder, where plugin.key is
  sids: string[];
  cwd?: string;
  delay?: number; // ms between taking an answer and its prompt line, as a session takes a moment to start its turn
  onAnswer?: (sid: string, text: string) => void; // after the prompt line is written
}): ModPlayer {
  const stop = new AbortController();
  const answered: ModPlayer["answered"] = [];
  const loop = async (sid: string) => {
    while (!stop.signal.aborted) {
      try {
        const { res: r, proven } = await pluginFetch(`http://127.0.0.1:${o.port}/api/answer/${sid}/next`, o.dir, { signal: stop.signal });
        if (r.status === 200 && proven) {
          const { text } = (await r.json()) as { text: string };
          answered.push({ sid, text });
          if (o.delay) await Bun.sleep(o.delay);
          appendFileSync(o.log, JSON.stringify({ t: Date.now(), sid, ev: "UserPromptSubmit", prompt: text, cwd: o.cwd ?? "/tmp/demo" }) + "\n");
          o.onAnswer?.(sid, text);
        } else if (r.status !== 204 || !proven) await Bun.sleep(1000);
      } catch {
        if (!stop.signal.aborted) await Bun.sleep(1000); // the server isn't up yet
      }
    }
  };
  for (const sid of o.sids) void loop(sid);
  return { answered, stop: () => stop.abort() };
}
