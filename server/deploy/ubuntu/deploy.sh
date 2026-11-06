#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/pi-bot
exec 9>.deploy.lock
flock -n 9 || exit 0
mode=${1:-latest}
if [[ $# -gt 1 || ! "$mode" =~ ^(latest|--if-changed|[0-9a-f]{40})$ ]]; then
  echo 'Usage: deploy.sh [latest|--if-changed|COMMIT_SHA]' >&2
  exit 2
fi
if [[ "$mode" == --if-changed && -e .deployment-failed ]]; then
  echo 'Automatic deployment paused after a failed update. Inspect the service logs and run deploy.sh manually.' >&2
  exit 1
fi
# This root-owned file contains only generated, shell-safe deployment values.
set -a
source .env
set +a
compose=(docker compose --env-file .env)
if [[ -f .release.env ]]; then compose+=(--env-file .release.env); fi
compose+=(-f compose.yml)
api_id=$("${compose[@]}" ps -q api)
if [[ "$mode" == --if-changed && -z "$api_id" ]]; then exit 0; fi
tag=$mode
if [[ "$tag" == --if-changed ]]; then tag=latest; fi
image="$PI_BOT_IMAGE_REPOSITORY:$tag"
docker pull "$image"
candidate=$(docker image inspect "$image" --format '{{.Id}}')
current=''
if [[ -n "$api_id" ]]; then current=$(docker inspect "$api_id" --format '{{.Image}}'); fi
if [[ "$mode" == --if-changed && "$candidate" == "$current" ]]; then exit 0; fi
digest=$(docker image inspect "$image" --format '{{range .RepoDigests}}{{println .}}{{end}}' | awk -v repo="$PI_BOT_IMAGE_REPOSITORY@sha256:" 'index($0,repo)==1 {print; exit}')
if [[ ! "$digest" =~ @sha256:[0-9a-f]{64}$ ]]; then echo 'Missing immutable repository digest' >&2; exit 1; fi
# Retrying the same release after a failure must not overwrite the rollback target.
if [[ -f .release.env ]] && ! grep -qxF "PI_BOT_IMAGE=$digest" .release.env; then cp .release.env .previous-release.env; fi
printf 'PI_BOT_IMAGE=%s\n' "$digest" > .release.env.tmp
mv .release.env.tmp .release.env
compose=(docker compose --env-file .env --env-file .release.env -f compose.yml)
touch .deployment-failed
# A worker must not keep using the previous API/schema during the update.
"${compose[@]}" stop -t 90 worker runner
if ! "${compose[@]}" up -d --remove-orphans --wait --wait-timeout 240; then
  "${compose[@]}" stop -t 90 worker runner
  echo 'Deployment failed. Automatic updates are paused; inspect docker compose logs.' >&2
  exit 1
fi
rm -f .deployment-failed
printf '%s\n' "$digest" > .deployed-image
# Every release leaves a ~1.3 GB image behind; a full disk stopped PostgreSQL. Keep the current and rollback releases.
keep=" $(sed -n 's/^PI_BOT_IMAGE=//p' .release.env .previous-release.env 2>/dev/null | xargs -r docker image inspect --format '{{.Id}}' 2>/dev/null | tr '\n' ' ') "
for id in $({ docker images -q --no-trunc "$PI_BOT_IMAGE_REPOSITORY"; docker images -q --no-trunc -f dangling=true; } | sort -u); do
  [[ "$keep" == *" $id "* ]] || docker rmi "$id" >/dev/null 2>&1 || true
done
"${compose[@]}" ps
echo "Deployed: $digest"
