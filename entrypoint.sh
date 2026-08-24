#!/bin/sh
# entrypoint.sh
# AWS_AUTH_MODE controls credential setup:
#   iam-anywhere (default) — configure aws_signing_helper via cert + private key
#   irsa                   — no setup needed, IRSA injects credentials automatically
#   env                    — no setup needed, AWS_ACCESS_KEY_ID/SECRET already set
#   instance-profile       — no setup needed, EC2 instance profile used
set -e

AWS_AUTH_MODE="${AWS_AUTH_MODE:-iam-anywhere}"

if [ "$AWS_AUTH_MODE" = "iam-anywhere" ]; then
  : "${AWS_TRUST_ANCHOR_ARN:?Required for iam-anywhere: AWS_TRUST_ANCHOR_ARN}"
  : "${AWS_ROLESANYWHERE_PROFILE_ARN:?Required for iam-anywhere: AWS_ROLESANYWHERE_PROFILE_ARN}"
  : "${AWS_ROLE_ARN:?Required for iam-anywhere: AWS_ROLE_ARN}"

  CERT_PATH="${CERT_PATH:-/certs/tls.crt}"
  CERT_KEY_PATH="${CERT_KEY_PATH:-/certs/tls.key}"
  AWS_REGION="${AWS_REGION:-ap-southeast-1}"

  if [ ! -f "$CERT_PATH" ]; then
    echo "[entrypoint] ERROR: Certificate not found at $CERT_PATH" >&2
    exit 1
  fi

  if [ ! -f "$CERT_KEY_PATH" ]; then
    echo "[entrypoint] ERROR: Private key not found at $CERT_KEY_PATH" >&2
    exit 1
  fi

  # Not ~/.aws/config: the container runs as uid 1001 with a read-only root
  # filesystem, so $HOME (/root, from the base image) is not writable and never
  # will be. AWS_CONFIG_FILE is the first thing the SDK checks before falling back
  # to ~/.aws/config, so point it at the writable emptyDir the chart mounts at
  # /tmp. Exported below so `exec "$@"` passes it to the node process.
  AWS_CONFIG_FILE="${AWS_CONFIG_FILE:-/tmp/aws/config}"
  mkdir -p "$(dirname "$AWS_CONFIG_FILE")"
  cat > "$AWS_CONFIG_FILE" <<EOF
[default]
credential_process = /usr/local/bin/aws_signing_helper credential-process \
  --certificate ${CERT_PATH} \
  --private-key ${CERT_KEY_PATH} \
  --trust-anchor-arn ${AWS_TRUST_ANCHOR_ARN} \
  --profile-arn ${AWS_ROLESANYWHERE_PROFILE_ARN} \
  --role-arn ${AWS_ROLE_ARN}
region = ${AWS_REGION}
EOF
  export AWS_CONFIG_FILE

  echo "[entrypoint] AWS auth mode: iam-anywhere, config: $AWS_CONFIG_FILE, cert expires: $(openssl x509 -enddate -noout -in $CERT_PATH 2>/dev/null || echo 'unknown')"

else
  echo "[entrypoint] AWS auth mode: ${AWS_AUTH_MODE} — skipping credential setup"
fi

exec "$@"
