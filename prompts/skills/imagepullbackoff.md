---
name: imagepullbackoff
description: Why the event message alone is usually the root cause
when: imagepull|errimagepull|pull.?back.?off
---

Events contain the full error message — it already tells you the root cause (wrong tag, missing secret, registry unreachable). Read the event message, no further tool calls needed to confirm.
