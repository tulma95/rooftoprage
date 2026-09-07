#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  cat <<'HELP'
Usage: ./deploy.sh [ghcr.io/owner/image] [tag]

Builds, tests, and pushes the current working tree to GHCR for Linux ARM64.
Requires macOS Keychain and a running Docker engine with Buildx.

Run ./deploy.sh to publish ghcr.io/tulma95/rooftop-rage:latest.
Reads ghcr-pat from macOS Keychain (which may prompt for Touch ID), logs in
as tulma95, and logs out of GHCR on exit. The PAT needs write:packages.

Use lowercase owner/image names. Default tag: latest. A custom tag does not update latest.
  ./deploy.sh ghcr.io/owner/image v1.0.0

Coolify setup:
  Create a Docker Image application using the published image and tag.
  Expose internal port 2567; health check: HTTP GET /health on port 2567.
  Configure domain https://game.example.com:2567; players use https://game.example.com.
  No volumes or browser environment variables are needed. Run one replica.
  Deployments end active matches; avoid overlapping replicas during replacement.
  For private GHCR packages, log in on the server as Coolify's Docker user
  using a classic token with read:packages. Public packages need no login.

Optional environment variables:
  IMAGE             Default: ghcr.io/tulma95/rooftop-rage
  GHCR_USERNAME     Default: tulma95
  PLATFORMS         Default: linux/arm64; use linux/amd64 for an x86 server
  SOURCE_URL        GitHub repository URL when it differs from the image path
  COOLIFY_WEBHOOK   Defaults to Keychain item rooftop-rage-webhook; set empty to skip redeploy
  COOLIFY_TOKEN     Defaults to macOS Keychain item coolify-token; needs Deploy permission

After publishing, the script requests redeployment when a webhook and token are available.
The webhook is read from rooftop-rage-webhook unless COOLIFY_WEBHOOK is explicitly set.
Without a webhook, only the image is published. Use COOLIFY_WEBHOOK='' ./deploy.sh to skip redeploy.
Configure Coolify for the same image/tag. Check Coolify for deployment completion.
HELP
  exit 0
fi
if [[ $# -gt 2 ]]; then
  echo 'Usage: ./deploy.sh [ghcr.io/owner/image] [tag]' >&2
  exit 1
fi

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image="${1:-${IMAGE:-ghcr.io/tulma95/rooftop-rage}}"
tag="${2:-latest}"
if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*$ ]]; then
  echo 'Provide a lowercase GHCR image name: ./deploy.sh ghcr.io/owner/image [tag]' >&2
  exit 1
fi
if [[ ! "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo 'Invalid Docker tag.' >&2
  exit 1
fi
command -v security >/dev/null
if [[ "${COOLIFY_WEBHOOK+x}" != x ]]; then
  echo 'Reading deployment webhook from Keychain; Touch ID may be required...'
  COOLIFY_WEBHOOK=$(security find-generic-password -s rooftop-rage-webhook -w 2>/dev/null) || COOLIFY_WEBHOOK=''
fi
if [[ -n "${COOLIFY_WEBHOOK:-}" ]]; then
  [[ "$COOLIFY_WEBHOOK" == https://* ]] || { echo 'COOLIFY_WEBHOOK must use HTTPS.' >&2; exit 1; }
  command -v curl >/dev/null
fi
command -v docker >/dev/null
docker info >/dev/null
docker buildx version >/dev/null

echo 'Reading GHCR credentials from Keychain; Touch ID may be required...'
# Pipe the PAT directly to Docker; never print or pass it as a command argument.
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
security find-generic-password -s ghcr-pat -w |
  docker login ghcr.io -u "${GHCR_USERNAME:-tulma95}" --password-stdin

# The source label links the package to its repository. Override if image and repo names differ.
source_url="${SOURCE_URL:-https://github.com/${image#ghcr.io/}}"
docker buildx build --platform "${PLATFORMS:-linux/arm64}" \
  --label "org.opencontainers.image.source=$source_url" \
  --tag "$image:$tag" --push .
echo "Published $image:$tag"

if [[ -n "${COOLIFY_WEBHOOK:-}" ]]; then
  if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
    COOLIFY_TOKEN=$(security find-generic-password -s coolify-token -w 2>/dev/null) || COOLIFY_TOKEN=''
  fi
  if [[ -n "${COOLIFY_TOKEN:-}" ]]; then
    echo 'Triggering Coolify redeploy...'
    curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
      --header "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_WEBHOOK" >/dev/null
    echo 'Coolify deployment requested. Check deployment status in Coolify.'
  else
    echo 'Pushed. Hit Redeploy in Coolify (no Coolify token found).'
  fi
else
  echo "Set Coolify's image to $image with tag $tag, expose port 2567, then deploy."
  echo 'Use HTTP GET /health on port 2567 for the health check. See ./deploy.sh --help for setup.'
fi
