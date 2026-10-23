# Turns a Claude Code hook payload into one short line. Long fields are cut so a
# line stays well under 4 KB, which keeps appends from parallel sessions whole.

def cut($n): if type == "string" then (gsub("\\s+"; " ") | .[0:$n]) else null end;

(if (.tool_input | type) == "object" then .tool_input else {} end) as $i
| (if (.tool_response | type) == "object" then .tool_response else {} end) as $r
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
    # A scheduled task's description says what it does, so its title stands in for it.
    d: ((if ((.tool_name | strings | startswith("mcp__scheduled-tasks__")) // false) then ($i.title // $i.taskId)
         else ($i.description // $i.file_path // $i.command // $i.path // $i.pattern
               // $i.url // $i.query // $i.skill // $i.title) end) // null | cut(160)),
    nt: .notification_type,
    msg: (.message | cut(200)),
    src: .source,
    why: .reason,
    prompt: (.prompt | cut(200)),
    x: (
      # Schedules a session sets: when, how often and the ID, never what it will do.
      if .hook_event_name == "PostToolUse" then (
        if .tool_name == "ScheduleWakeup" then
          {at: $r.scheduledFor, delay: $i.delaySeconds, stop: $i.stop}
        elif .tool_name == "CronCreate" then
          {id: ($r.id // (.tool_response | tostring | capture("task (?<id>[0-9a-f]{6,})")? | .id) // null),
           at: $r.nextFireAt, cron: ($i.cron | cut(60)), rec: ($i.recurring != false)}
        elif .tool_name == "CronDelete" then {id: ($i.id | cut(60))}
        elif .tool_name == "mcp__scheduled-tasks__create_scheduled_task" then {task: ($i.taskId | cut(80))}
        else null end
      )
      elif .hook_event_name != "PreToolUse" then null
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
