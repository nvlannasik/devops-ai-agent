# C16 — what grew on a host

A standalone VM (`bench-vm-01`, invented by the case's `hosts` fixture — no setup, nothing in the
cluster) whose `billing-sync.service` grew from 180 to 1150Mi over 24 h while everything else held.
One snapshot shows a large service; only the history says it GREW. The answer must name
`billing-sync` with the history's numbers (start/end/change, computed by `node_host_history`).
A proposal is not required — the question is what grew — but restarting the leaking unit is an
acceptable one (`alternatives`); the fixture host is never registered, so nothing is queued.
