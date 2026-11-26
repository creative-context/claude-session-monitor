# Turns a Claude Code hook payload into one short line. Every field is cut by its type, and
# the whole line stays under 3,500 bytes: jq writes a line that size in one write, so lines
# from parallel sessions never mix (past about 4 KB they did, and both events were lost).
# When the line would be bigger, the long text is cut harder; an event is never dropped.

def cut($n): if type == "string" then (gsub("\\s+"; " ") | .[0:($n | floor)]) else null end;
# Paths keep their spaces; only the length is capped.
def clip($n): if type == "string" then .[0:$n] else null end;
def num: if type == "number" then . else null end;
def flag: if type == "boolean" then . else null end;
# A step number, or a list of them.
def steps: if type == "number" then . elif type == "array" then [.[0:20][] | numbers] else null end;
def at: if type == "number" then . else cut(40) end;

(if (.tool_input | type) == "object" then .tool_input else {} end) as $i
| (if (.tool_response | type) == "object" then .tool_response else {} end) as $r
| . as $e
# The line, with its long text cut to $k of the usual length.
| def line($k): $e | {
    t: (now * 1000 | floor),
    pid: $pid,
    ev: (.hook_event_name | cut(40)),
    sid: (.session_id | cut(80)),
    cwd: (.cwd | clip(400)),
    tp: (.transcript_path | clip(400)),
    pm: (.permission_mode | cut(30)),
    agent: (.agent_id | cut(80)),
    tool: (.tool_name | cut(120)),
    # A scheduled task's description says what it does, so its title stands in for it.
    d: ((if ((.tool_name | strings | startswith("mcp__scheduled-tasks__")) // false) then ($i.title // $i.taskId)
         else ($i.description // $i.file_path // $i.command // $i.path // $i.pattern
               // $i.url // $i.query // $i.skill // $i.title) end) // null | cut(160 * $k)),
    nt: (.notification_type | cut(60)),
    msg: (.message | cut(200 * $k)),
    src: (.source | cut(40)),
    why: (.reason | cut(80)),
    prompt: (.prompt | cut(200 * $k)),
    x: (
      # Schedules a session sets: when, how often and the ID, never what it will do.
      if .hook_event_name == "PostToolUse" then (
        if .tool_name == "ScheduleWakeup" then
          {at: ($r.scheduledFor | at), delay: ($i.delaySeconds | num), stop: ($i.stop | flag)}
        elif .tool_name == "CronCreate" then
          {id: (($r.id // (.tool_response | tostring | capture("task (?<id>[0-9a-f]{6,})")? | .id) // null) | cut(60)),
           at: ($r.nextFireAt | at), cron: ($i.cron | cut(60)), rec: ($i.recurring != false)}
        elif .tool_name == "CronDelete" then {id: ($i.id | cut(60))}
        elif .tool_name == "mcp__scheduled-tasks__create_scheduled_task" then {task: ($i.taskId | cut(80))}
        else null end
      )
      elif .hook_event_name != "PreToolUse" then null
      elif .tool_name == "mcp__ccd_turn__update_plan" then {
        items: (if ($i.items | type) == "array"
                then [$i.items[0:20][] | objects | {c: (.content | cut(90 * $k)), s: (.status | cut(20))}]
                else null end),
        advance: ($i.advance | if type == "boolean" then . else num end),
        done: ($i.done | steps),
        start: ($i.start | steps)
      }
      elif .tool_name == "mcp__ccd_turn__wrap_up" then
        {recap: ($i.recap | cut(300 * $k)), ask: ($i.ask | cut(140 * $k)),
         # The answer buttons' words (up to 2), and an app action's name, so the card can
         # offer them; nothing else from the buttons.
         acts: (if ($i.actions | type) == "array"
                then [$i.actions[0:2][] | objects | {l: (.label | cut(40)), a: (.action | cut(30))}
                      | with_entries(select(.value != null and .value != "")) | select(length > 0)]
                     | if length > 0 then . else null end
                else null end)}
      elif .tool_name == "AskUserQuestion" then
        {q: ($i.questions | if type == "array" then .[0] else null end | if type == "object" then .question else null end | cut(160 * $k))}
      # Whether a new session is offered to you (the app waits for your choice), nothing else.
      elif .tool_name == "mcp__ccd_session__start_session" then
        (($i.initiation | cut(20)) as $n | if $n then {init: $n} else null end)
      else null end
    )
  } | with_entries(select(.value != null));
# The first that fits: the usual cut, then half, then a quarter, then no long text; then short
# paths and IDs with only the plan's step states; and last, only what names the event, which
# always fits. Never nothing: a Stop or a question must reach the app.
def fits: select(tojson | utf8bytelength <= 3500);
first(
  ((1, 0.5, 0.25, 0) as $k | line($k) | fits),
  (line(0) | .cwd |= clip(100) | .tp |= clip(100) | .sid |= cut(40) | .agent |= cut(40) | .tool |= cut(60)
     | .nt |= cut(40) | .why |= cut(40) | .src |= cut(20) | .pm |= cut(20)
     | if (.x | type) == "object" then .x |= ({items: (.items | if type == "array" then map({s: (.s | cut(12))}) else null end),
         advance, done, start, init} | with_entries(select(.value != null))) else . end
     | with_entries(select(.value != null)) | fits),
  ($e | {t: (now * 1000 | floor), pid: $pid, ev: (.hook_event_name | cut(30)), sid: (.session_id | cut(40)),
         tool: (.tool_name | cut(60)), agent: (.agent_id | cut(40))} | with_entries(select(.value != null)))
)
