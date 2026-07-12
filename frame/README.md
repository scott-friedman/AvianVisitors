# AvianVisitors e-ink frame

*The last 24h of birds, framed on the wall by your window.*

> **This deployment (Scott's fork) — supersedes three claims below:**
> - The panel is a **7.3" Inky Impression (800×480, 7-color)**, not the 13.3" Spectra 6; `display.py` is ported to it (`PANEL_W/H` + the `INKY7` palette). Only `hardware/` CAD is still 13.3".
> - **The Worker renders the image, not the Pi.** `display.py` never screenshots anything — it fetches the finished PNG from the avian-worker's key-gated `GET /frame.png` (Cloudflare Browser Rendering) and pushes it to the panel. There is no `shoot` config key; set `image_url` (see `config.example.toml` / the `DEFAULTS` in `display.py`).
> - The systemd timer fires every **5 minutes** (`systemd/birdframe.timer`), and the panel redraws only when the detection signature changes.

A [Pimoroni Inky Impression 13.3"](https://amzn.to/4xlAWr3) (Spectra 6) mirroring the live collage. A Pi screenshots the site, mats it onto an A5 opening, and pushes to the panel, refreshing only when the birds change. Build one of your own at [theodore.net/projects/AvianVisitors#frame-ous](https://theodore.net/projects/AvianVisitors/#frame-ous).

![](https://theodore.net/assets/images/AvianVisitors/final.jpg)

---

### BOM

| Qty | Description | Price | Link |
|-----|-------------|-------|------|
| 1 | Raspberry Pi Zero (2) W | ~$35 | [Amazon](https://amzn.to/49Xp58I) |
| 1 | 13.3" E Ink Display     | $299.99 | [Amazon](https://amzn.to/4xlAWr3) |
| 1 | A4 Wood Photo Frame    | $21.99 | [Amazon](https://amzn.to/3RWFbJE) |
| 1 | Long, Flat Micro USB Cable    | $7.99 | [Amazon](https://a.co/d/0a59rKSk) |
| 1 | Flat USB Brick    | $7.59 | [Amazon](https://amzn.to/3S4CtSs) |
| | **Total** | **~$372** | | |

CAD + 3d print files can be found in [`hardware/`](hardware/).

---

## 1. Flash the SD card

Flash an sd card with Raspberry Pi OS Lite (64-bit) via [Raspberry Pi Imager](https://www.raspberrypi.com/software/). In the customisation dialog set:

- Username
- WiFi SSID + password
- Hostname: `birdpic`
- Enable SSH with password auth

Then install in Pi and power up.

## 2. Run the installer

```bash
ssh <your-username>@birdpic.local
git clone https://github.com/Twarner491/AvianVisitors
cd AvianVisitors/frame && ./install.sh
```

Enables SPI + I2C, installs the deps and a 15-minute systemd timer, writes `~/.birdframe/config.toml`, and reboots once to bring SPI up.

---

## 3. Point it at the collage

After it reboots and comes back, set your image source in `~/.birdframe/config.toml`. The Pi is too small to run a browser, so it fetches a ready-made PNG that the aggregator Worker renders at `/frame.png`, gated by a key:

```toml
base_url  = "https://bird.onethreenine.net"
image_url = "https://bird.onethreenine.net/frame.png?k=YOUR_FRAME_KEY"
```

No Worker? Set `shoot = true` to screenshot on any capable host instead. Full options are in [`config.example.toml`](config.example.toml).
