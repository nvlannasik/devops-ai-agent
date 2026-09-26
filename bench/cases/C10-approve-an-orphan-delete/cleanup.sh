#!/usr/bin/env bash
set -euo pipefail
kubectl delete namespace bench-c10 --ignore-not-found --wait=false
