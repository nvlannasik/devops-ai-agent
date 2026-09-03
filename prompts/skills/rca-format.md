---
name: rca-format
description: The exact Slack mrkdwn shape every RCA must take
when: always
---

IMPORTANT: Use Slack mrkdwn syntax — NOT standard Markdown.
- Bold: *text* (single asterisk, not double)
- Italic: _text_ (underscore)
- Inline code: `value`
- Code block: ```
multi-line content
```
- Bullet: • (unicode bullet character)
- No ## headers — use *bold* labels instead

**Always use inline code `...` for:**
- Resource names: pod, deployment, namespace, node, service names
- Label values: `app=nginx`, `severity=critical`, `namespace=production`
- Metric values: `98%`, `512Mi`, `2.3 req/s`, `p99=450ms`
- Timestamps: `2026-06-07T14:32:05Z`
- Error codes or short error messages

**Always use code block ```...``` for:**
- Log excerpts (more than one line)
- Stack traces
- Multi-line error output

**Every `[bracketed]` value below is a placeholder to replace — including the two `[level]`
values. Never emit a bracket in your output.**

- Severity `[level]` is one of *Critical*, *High*, *Medium*, *Low*, chosen from the Severity
  Guidelines by the impact you actually found. It is YOUR judgement, not a copy of the alert's
  own `severity` label: Alertmanager says `critical`/`warning`/`info`, and a `warning` alert
  can still be Critical, just as a `critical` one can turn out to be Low.
- Severity `[emoji]` must match the level you chose: 🔴 Critical, 🟠 High, 🟡 Medium, 🟢 Low.
- Confidence `[level]` is one of *High*, *Medium*, *Low*, from the Confidence Scoring rules.

Output EXACTLY this structure (labels must match precisely for rendering):

*[emoji] Severity:* `[level]`

*⚡ TL;DR*
[Two lines, no more. Line 1: what is broken — named `namespace/workload` — and what it is doing
wrong. Line 2: the one action to take right now. Someone who reads only these two lines must know
whether this needs them out of bed. No evidence, no reasoning, no hedging here — the rest of the
RCA is where those live.]

*⚠️ Impact if Unresolved*
[Who is affected NOW and what breaks next — named from the blast-radius calls, not assumed. Lead
with the dependants you found (`namespace/service`, `n/m ready`, the exposed host), then what fails
next if nobody acts. If the checks showed nothing depends on this workload, say the impact is
contained to it and why.]

*🔧 Recommended Actions*
1. *Immediate:* [Safe to execute now — stops active impact]
2. *Short-term:* [Fix within hours/days]
3. *Long-term:* [Architectural or process change to prevent recurrence]

*📍 Root Cause*
[The causal chain, one numbered step per link — see "Causal Chain" in the system prompt. Step 1 is
the symptom the alert fired on. Each step after it answers *why the step above happened* and ends
with the tool output that proves it. Stop at the first link you cannot support and mark that line
⛔, naming what would extend the chain. Do not invent the next link to make the list longer.]
1. [Symptom] — _tool_name_ `namespace/resource`
2. ← [why step 1 happened] — _tool_name_ `namespace/resource`
3. ← [why step 2 happened] — _tool_name_ `namespace/resource`
4. ⛔ [what you cannot see from here, and what access would show it]

*📊 Evidence*
• [Fact 1] — _tool_name_ `namespace/resource`
• [Fact 2] — _tool_name_ `namespace/resource`

*🚫 Ruled Out*
• [Hypothesis 1] — [specific reason from tool result]

*📈 Confidence:* `[level]` — [one sentence: which evidence supports this and what would raise it]
