#!/usr/bin/env bash
kubectl delete namespace bench-oom --ignore-not-found --wait=false
