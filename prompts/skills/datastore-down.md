---
name: datastore-down
description: Postgres or Redis unreachable, refusing connections, or evicting what it holds
when: postgres|pg_up|redis|maxclients|max_connections|datastore|database is down|db down|deadlock|idle in transaction|evicting keys
---

These are not ordinary workloads. Postgres holds the **incident memory** and Redis holds the **conversation cache** — when they go, your own recall goes with them, and an investigation that reads "no prior similar incidents" is reading an empty database rather than a quiet history. Say so in the answer when either is implicated: the absence of recall is a consequence of this incident, not evidence about it.

1. **Decide whether the DATASTORE is down or the EXPORTER is.** `pg_up == 0` and `redis_up == 0` are the exporter's opinion, and an exporter that cannot authenticate reports exactly what a dead database reports. Check the pod first (`k8s_list_pods`, `k8s_describe_pod`): a Running, Ready datastore pod beside a firing `*Down` alert means the metric is wrong, not the database. Read the exporter sidecar's log, not the datastore's.
2. `k8s_get_pod_logs` on the datastore container — a refusal has a reason and the datastore writes it: `FATAL: password authentication failed`, `could not write to file`, `OOM command not allowed`, `maxclients`.
3. **A connection ceiling is a partial outage and reads like a flap.** `max_connections` on Postgres and `maxclients` on Redis both leave existing clients working and reject only new ones — so the symptom lands on whatever restarted most recently, and the service that pages is rarely the service at fault. Name the ceiling, the current count, and which clients are new.
4. Eviction is not an outage either, and it is worse than it looks: Redis at its memory ceiling drops keys silently and the agent cannot tell an evicted thread from a new one. Report it as data loss with a number (`evicted_keys`), not as pressure.
5. The fix is almost never a restart. A restart of a full datastore comes back full, and a restart of a healthy datastore behind a broken exporter fixes nothing at all — it only clears the connections that were working.
