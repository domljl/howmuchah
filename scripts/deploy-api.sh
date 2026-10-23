#!/usr/bin/env bash
set -Eeuo pipefail

repo='https://github.com/domljl/howmuchah.git'
branch='main'
root='/opt/howmuchah'
source_dir="$root/deploy-source"
env_file="$root/api.env"
network='howmuchah'
container='howmuchah-api'
image='howmuchah-api:deploy'
lock_file="$root/deploy-api.lock"

exec 9>"$lock_file"
flock -n 9 || { echo 'Another API deployment is running.' >&2; exit 1; }

test -r "$env_file" || { echo "Missing API environment file: $env_file" >&2; exit 1; }
docker network inspect "$network" >/dev/null
[[ "${DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'DEPLOY_SHA must be a full commit SHA.' >&2; exit 1; }

if [ ! -d "$source_dir/.git" ]; then
  git clone --branch "$branch" --single-branch "$repo" "$source_dir"
fi
git -C "$source_dir" fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch"
git -C "$source_dir" cat-file -e "$DEPLOY_SHA^{commit}"
git -C "$source_dir" merge-base --is-ancestor "$DEPLOY_SHA" "origin/$branch" || { echo 'Requested commit is not on origin/main.' >&2; exit 1; }
git -C "$source_dir" reset --hard --quiet "$DEPLOY_SHA"

commit=$(git -C "$source_dir" rev-parse --short=12 HEAD)
new_image="howmuchah-api:$commit"
docker build --pull -t "$new_image" "$source_dir"

old_image=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)
if [ -n "$old_image" ]; then
  docker tag "$old_image" "$image"
fi
docker rm -f "$container" >/dev/null 2>&1 || true

run_api() {
  docker run -d \
    --name "$container" \
    --user node \
    --restart unless-stopped \
    --network "$network" \
    -p 127.0.0.1:8787:8787 \
    --env-file "$env_file" \
    "$1" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 30); do
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    [ "$state" = healthy ] && return 0
    [ "$state" = unhealthy ] && return 1
    sleep 2
  done
  return 1
}

if run_api "$new_image" && wait_healthy; then
  echo "API deployed: $commit"
  exit 0
fi

echo 'New API image failed health check; restoring previous container.' >&2
docker logs --tail 40 "$container" >&2 || true
docker rm -f "$container" >/dev/null 2>&1 || true
if [ -n "$old_image" ]; then
  run_api "$old_image"
  if wait_healthy; then
    echo 'Previous API container restored.' >&2
  else
    echo 'Rollback container failed health check.' >&2
  fi
else
  echo 'No previous API image exists; API remains stopped.' >&2
fi
exit 1
