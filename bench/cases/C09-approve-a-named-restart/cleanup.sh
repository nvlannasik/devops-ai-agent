#!/usr/bin/env bash
set -euo pipefail
kubectl delete namespace bench-c09 --ignore-not-found --wait=false
