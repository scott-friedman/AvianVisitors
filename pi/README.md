# Pi glue — detection forwarder (Phase 2)

`detection-forwarder.py` is the bridge from **BirdNET-Pi** (detection engine on
the Pi) to **avian-worker** (Cloudflare). It tails `~/BirdNET-Pi/BirdDB.txt` —
one line per detection — and POSTs each new detection to `/api/detection` with
the shared `X-Avian-Secret`. From there the public collage and the e-ink frame
pick it up.

**Why a tail-watcher and not a code hook:** BirdNET-Pi has no per-detection
script hook (only DB insert + BirdWeather + Apprise), and editing its source
would be clobbered on `git pull`. Tailing `BirdDB.txt` is fully decoupled and
survives BirdNET-Pi updates. The Pi stays outbound-only (no ports opened). The
worker dedupes by `(sci, ts)`, so a restart replaying a line is harmless.

## Install (on the Pi, after BirdNET-Pi is installed)

```sh
# 1. script
mkdir -p ~/avian && cp pi/detection-forwarder.py ~/avian/

# 2. shared ingest secret (same value as the worker's AVIAN_INGEST_SECRET)
mkdir -p ~/.avian && umask 077 && printf '%s' '<SECRET>' > ~/.avian/ingest-secret

# 3. systemd service (rewrite User/paths for this Pi)
sed "s|REPLACE_USER|$USER|; s|REPLACE_HOME|$HOME|g" pi/systemd/avian-forwarder.service \
  | sudo tee /etc/systemd/system/avian-forwarder.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now avian-forwarder.service
```

## Test without a mic

`/api/detection` and the whole downstream are live, so you can validate the
plumbing by hand-appending a BirdDB.txt line:

```sh
echo "$(date +%F);$(date +%T);Cardinalis cardinalis;Northern Cardinal;0.95;-1;-1;0.7;25;1.25;0.0" \
  >> ~/BirdNET-Pi/BirdDB.txt
journalctl -u avian-forwarder -n 5 --no-pager     # should show "posted ... -> 204"
curl -s "$AVIAN_WORKER/api/recent?hours=24" | grep -i cardinal
```

Remove test rows from the worker when done:
`wrangler d1 execute avian-detections --remote --command "DELETE FROM detections WHERE com='Northern Cardinal'"`
