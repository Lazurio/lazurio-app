#!/bin/sh
# Lazurio App (Alpha): the network of your Organization, for your own Mac account only.
# It writes the key Tailnets of io.lazurio.app in your defaults and needs no administrator.
if /usr/bin/defaults write io.lazurio.app Tailnets -string '[{"tailnet":"<tailnet>","controlUrl":"https://<control-server>","domains":["<domain>"]}]'; then
  echo "Done. The network setting is saved for this Mac account."
else
  echo "The network setting was not saved."
fi
