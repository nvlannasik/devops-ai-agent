---
name: crashloopbackoff
description: First tool calls for a container restarting in a loop
when: crashloop|restarting
---

1. k8s_describe_pod — read lastState and recentEvents.
