# Deploy to Dad's (Sudbury, MA) — checklist & status

**Plain English:** get the bird box working at Dad's house so it (1) **joins his wifi
on power-up**, (2) lets you **change the wifi if that fails**, (3) **hears birds**,
(4) **feeds the website + e-ink frame**, and (5) **stays manageable from home**.
The software is essentially done; the rest is the move. Status as of **2026-06-19**.

**Legend:** ✅ done · ⏳ built, waiting on an input from you · ⬜ to do · 🧰 hardware

---

## A. Do at home, before the box leaves (so it survives the move)

- ✅ **Point at Sudbury** — BirdNET region `42.3834 / -71.4162`; Pi timezone `America/New_York`; Worker `TZ_OFFSET_HOURS=-4` (deployed + verified).
- ✅ **Remote-access tooling** — `cloudflared` on the Pi (2026.6.1) + Mac (2026.5.2); `sshd` enabled at boot; tunnel scripts written.
- ✅ **Wifi — pre-stage Dad's network** — SSID **`MOTU`** staged (WPA2, priority 100, autoconnect) so it self-joins at Sudbury. *(Earlier wrong guesses `Master_of_the_Universe`/`…f` removed 2026-06-19.)* → `pi/set-wifi.sh "MOTU" "<pw>" 100`
- ⏳ **Wifi — rescue network** (your phone hotspot) so a wrong Dad's-password isn't a brick. *Needs hotspot SSID + password.* → `pi/set-wifi.sh "<hotspot>" "<pw>" 50`
- ✅ **Remote tunnel — LIVE** — `avian-admin` routes `bird-ssh.foobos.net` → the Pi's SSH; **`ssh bird-pi`** works from the Mac (boot-persistent). **Password-gated, no Access app** (deliberate — see `pi/README.md`); the gate is a strong, unique `inky` password behind the tunnel. *(Confirm that password is strong before the box ships.)*
- ⬜ **Liveness heartbeat + alert** — install the 15-min heartbeat timer (`pi/README.md` → "Liveness heartbeat") and add an UptimeRobot HTTP monitor on `<worker>/api/status`. It alerts when the box goes silent for ~45 min, so a failure at Dad's reaches *you* instead of him noticing a frozen frame.
- ⬜ **Commit the new `pi/` files** to the `avian-visitors` branch.

## B. Hardware to bring

- 🧰 **USB microphone** (class-compliant) + **micro-USB→USB-A OTG adapter**. The Pi's only data port is micro-USB; **no mic ⇒ no detections** (the #1 failure mode).

## C. On-site at Dad's (the install visit) — verify ALL of this before you leave

1. ⬜ Power on near his router; wait ~1 min.
2. ✅ **Confirmed on `MOTU`** (2026-06-19, on-site): Pi joined Dad's `MOTU` (DHCP `10.10.10.111/24`), internet verified, tunnel back over MOTU — `ssh bird-pi` works. Reachable any time via the tunnel; or laptop-on-his-wifi → `ssh inky@inky.local`.
   - **If it ever drops off:** turn on your phone hotspot (2.4 GHz / iPhone "Maximize Compatibility" ON) → Pi joins the rescue profile (`wifi-Linguine_Pro`, prio 50) → `ssh` in → fix: `bash pi/set-wifi.sh "MOTU" "correct-pw" 100`.
3. ⬜ Plug in the mic → `arecord -l` shows a capture device → set the sound card at `http://inky.local/`.
4. ⬜ **Enable detection at boot:** `sudo systemctl enable --now birdnet_analysis birdnet_recording` (it's off by default until the mic exists).
5. ⬜ Confirm a real bird (or a whistle) lands at `/api/recent` and the panel repaints.
6. ⬜ **Clear the demo birds** (from your Mac): `cd worker && npx wrangler d1 execute avian-detections --remote --command "DELETE FROM detections"`.
7. ⬜ **CRITICAL — do not leave until this passes:** `ssh bird-pi` works from a network that is **not** Dad's (tether to your phone). After you leave, `inky.local` / `192.168.0.29` are gone — the tunnel is your only way back in.

## D. Later / optional

- ⬜ **CI auto-deploy** — add a scoped CF API token as GitHub secrets so future code changes deploy themselves (`.github/workflows/cf-deploy-{pages,worker}.yml` already written).
- ⬜ **Phone-only wifi portal** (AP fallback) — see Wifi plan below.
- ⬜ Custom domain · per-bird audio playback (v2).

---

## Wifi plan — "ready on power-up + changeable"

The Pi uses **NetworkManager**. Strategy = **pre-stage + rescue + easy edit**, no extra
services (fits 512 MB):

1. **Dad's wifi** = high-priority autoconnect profile → joins automatically at his house.
2. **Your phone hotspot** = lower-priority profile → on-site safety net if Dad's details are wrong (Pi joins the hotspot, you SSH in and fix it).
3. **`pi/set-wifi.sh`** changes/adds any wifi in one line; idempotent.

**Gotchas:** the Zero 2 W is **2.4 GHz only** (use Dad's 2.4 GHz SSID; iPhone hotspot → "Maximize Compatibility" ON). WPA2 and WPA2/WPA3-mixed work as-is; a WPA3-*only* network needs `set-wifi.sh ... --wpa3`. Hidden SSID → add `--hidden`.

**Optional upgrade — phone-only portal:** install `comitup` / `wifi-connect` so the Pi
broadcasts its own "BirdPi-Setup" network when it can't connect and you enter wifi from a
phone with no laptop. Costs a little RAM + complexity; skipped by default because the
rescue-hotspot covers the same need with zero added software. Say the word to add it.

## "Ready to run once powered on" — what makes it automatic

After the on-site visit, every service comes up on its own at each power-up:
- ✅ `avian-forwarder` (detections → cloud), `birdframe.timer` (e-ink), `sshd` — already enabled at boot.
- ⬜ `avian-heartbeat.timer` (liveness ping) — comes up at boot once installed at home (section A).
- ✅ `cloudflared` (remote access) — service enabled at boot; `ssh bird-pi` reaches it from anywhere.
- ⬜ `birdnet_analysis` + `birdnet_recording` — enable at boot in step C4 once the mic is in.
- Wifi auto-joins via the pre-staged profile; a hung box auto-reboots (hardware watchdog).

## Quick reference

```sh
# add / change wifi
bash pi/set-wifi.sh "<SSID>" "<password>" [priority] [--hidden] [--wpa3]
# turn detection on at boot (after the mic is in)
sudo systemctl enable --now birdnet_analysis birdnet_recording
# stand up remote access (single-level subdomain; free SSL covers *.zone only)
cloudflared tunnel login && bash pi/tunnel-setup.sh bird-ssh.<zone> avian-admin
# clear demo birds (from the Mac, in worker/)
npx wrangler d1 execute avian-detections --remote --command "DELETE FROM detections"
```
