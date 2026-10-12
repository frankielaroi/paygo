#!/bin/sh
# One run of the demo fleet simulator, started by paygo-fleet-sim.timer.
#
# It runs in the app's own image, which already has Node and the pg driver, so nothing extra
# is installed on the host. Host networking reaches the device listener on 127.0.0.1:5027 the
# way a tracker would, and the database through the host's route to it.
set -eu

image="$(docker inspect -f '{{.Config.Image}}' paygo-app-1)"

exec docker run --rm --name paygo-fleet-sim \
  --network host --memory 192m --cpus 0.5 \
  --env-file /opt/paygo/.env \
  -e NODE_PATH=/app/node_modules \
  -v /opt/paygo/fleet-sim:/sim:ro \
  "$image" node /sim/fleet-sim.cjs --duration 270
