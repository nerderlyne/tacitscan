#!/bin/sh
set -eu
# Render mounts its disk at runtime, after image ownership was established.
# Initialize only our data directory, then run the verifier as an ordinary user.
pool_dir=$(dirname "${BTC_POOL_DB:-/data/pool.db}")
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$pool_dir"
  chown node:node "$pool_dir"
  exec gosu node "$@"
fi
exec "$@"
