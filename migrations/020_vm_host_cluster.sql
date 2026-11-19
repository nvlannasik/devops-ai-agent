-- Hosts across clusters and outside any (vm-agent version 4+): the Kubernetes cluster a host says it
-- is a node of, and its node name there. Both NULL for a standalone host and for an agent older than
-- version 4; the dashboard then places a host by matching its name against each cluster's nodes.
-- `name` stays the key: it is the token's name, the caller's identity (two clusters may both have a
-- node `worker1`, so their tokens are named apart and `node` carries the Kubernetes name).
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS cluster TEXT;
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS node TEXT;
