// Plays the plugin's answers side (plugin/) for the tests and the demo: for each session given,
// it asks the server for an answer the way the mod does (GET /api/answer/:sid/next, held up to
// 20 s), and when one comes, writes the UserPromptSubmit line the hook would write for it, so
// the session starts working on your answer.
//
//   const mod = playMod({ port, log, sids: [sid] });  …  mod.stop();

import { appendFileSync } from "node:fs";

export type ModPlayer = {
  answered: { sid: string; text: string }[]; // what it submitted, in order
  stop: () => void;
};

export function playMod(o: {
  port: number;
  log: string; // the events.jsonl the server reads
  sids: string[];
  cwd?: string;
  onAnswer?: (sid: string, text: string) => void; // after the prompt line is written
}): ModPlayer {
  const stop = new AbortController();
  const answered: ModPlayer["answered"] = [];
  const loop = async (sid: string) => {
    while (!stop.signal.aborted) {
      try {
        const r = await fetch(`http://127.0.0.1:${o.port}/api/answer/${sid}/next`, { headers: { "x-csm": "1" }, signal: stop.signal });
        if (r.status === 200) {
          const { text } = (await r.json()) as { text: string };
          answered.push({ sid, text });
          appendFileSync(o.log, JSON.stringify({ t: Date.now(), sid, ev: "UserPromptSubmit", prompt: text, cwd: o.cwd ?? "/tmp/demo" }) + "\n");
          o.onAnswer?.(sid, text);
        } else if (r.status !== 204) await Bun.sleep(1000);
      } catch {
        if (!stop.signal.aborted) await Bun.sleep(1000); // the server isn't up yet
      }
    }
  };
  for (const sid of o.sids) void loop(sid);
  return { answered, stop: () => stop.abort() };
}
