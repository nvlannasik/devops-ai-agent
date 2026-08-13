---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|exit code 137|memory limit
---

1. k8s_describe_pod — confirm lastState Terminated OOMKilled.
