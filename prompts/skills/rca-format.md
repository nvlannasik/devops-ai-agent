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

Output EXACTLY this structure (labels must match precisely for rendering):

*🔴 Severity:* `Critical`

*📍 Root Cause*
[One paragraph: what failed, why it failed, what triggered it — evidence-based only]

*📊 Evidence*
• [Fact 1] — _tool_name_ `namespace/resource`
• [Fact 2] — _tool_name_ `namespace/resource`

*🚫 Ruled Out*
• [Hypothesis 1] — [specific reason from tool result]

*🔧 Recommended Actions*
1. *Immediate:* [Safe to execute now — stops active impact]
2. *Short-term:* [Fix within hours/days]
3. *Long-term:* [Architectural or process change to prevent recurrence]

*⚠️ Impact if Unresolved*
[Who is affected NOW and what breaks next — named from the blast-radius calls, not assumed. Lead with the dependants you found (`namespace/service`, `n/m ready`, the exposed host), then what fails next if nobody acts. If the checks showed nothing depends on this workload, say the impact is contained to it and why.]

