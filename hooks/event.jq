# Turns a Claude Code hook payload into one short line. Long fields are cut so a
# line stays well under 4 KB, which keeps appends from parallel sessions whole.

def cut($n): if type == "string" then (gsub("\\s+"; " ") | .[0:$n]) else null end;

(.tool_input // {}) as $i
| {
    t: (now * 1000 | floor),
    pid: $pid,
    ev: .hook_event_name,
    sid: .session_id,
    cwd: .cwd,
    tp: .transcript_path,
    pm: .permission_mode,
    agent: .agent_id,
    tool: .tool_name,
    d: (($i.description // $i.file_path // $i.command // $i.path // $i.pattern
         // $i.url // $i.query // $i.skill // $i.title // null) | cut(160)),
    nt: .notification_type,
    msg: (.message | cut(200)),
    src: .source,
    why: .reason,
    prompt: (.prompt | cut(200)),
    x: (
      if .hook_event_name != "PreToolUse" then null
      elif .tool_name == "mcp__ccd_turn__update_plan" then {
        items: (if ($i.items | type) == "array"
                then [$i.items[] | {c: (.content | cut(90)), s: .status}]
                else null end),
        advance: $i.advance,
        done: $i.done,
        start: $i.start
      }
      elif .tool_name == "mcp__ccd_turn__wrap_up" then
        {recap: ($i.recap | cut(300)), ask: ($i.ask | cut(140))}
      elif .tool_name == "AskUserQuestion" then
        {q: ($i.questions[0].question | cut(160))}
      else null end
    )
  }
| with_entries(select(.value != null))
