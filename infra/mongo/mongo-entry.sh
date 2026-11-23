#!/bin/sh
# Generates the replica-set keyfile (required with --auth) then hands over to the official entrypoint.
set -e
mkdir -p /etc/mongo
if [ ! -f /etc/mongo/keyfile ]; then
  head -c 756 /dev/urandom | base64 > /etc/mongo/keyfile
  chmod 400 /etc/mongo/keyfile
  chown mongodb:mongodb /etc/mongo/keyfile
fi
exec docker-entrypoint.sh "$@"
