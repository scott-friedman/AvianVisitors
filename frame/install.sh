#!/usr/bin/env bash
# Install the AvianVisitors e-ink frame (display side) on a Raspberry Pi.
# Enables SPI + I2C, installs deps, makes a venv, installs the systemd timer.
set -euo pipefail
cd "$(dirname "$0")"
FRAME="$(pwd)"

CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt

echo "1/5  Enabling SPI + I2C (Inky needs both; SPI with no chip-select)..."
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
grep -q "^dtoverlay=spi0-0cs" "$CONFIG_TXT" || echo "dtoverlay=spi0-0cs" | sudo tee -a "$CONFIG_TXT" >/dev/null

echo "2/5  Installing system packages (build tools to compile spidev, libatlas3-base for numpy)..."
sudo apt-get update -qq
sudo apt-get install -y python3-venv python3-dev build-essential libatlas3-base

echo "3/5  Creating venv and installing Python deps..."
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements-frame.txt

echo "4/5  Setting up config..."
# config.toml holds FRAME_KEY — keep the dir and file private (not default umask).
mkdir -p "$HOME/.birdframe"
chmod 700 "$HOME/.birdframe"
[ -f "$HOME/.birdframe/config.toml" ] || install -m 600 config.example.toml "$HOME/.birdframe/config.toml"

echo "5/5  Installing systemd timer..."
sed "s|/home/monalisa/AvianVisitors/frame|$FRAME|g; s|/home/monalisa|$HOME|g; s|User=monalisa|User=$USER|" \
  systemd/birdframe.service | sudo tee /etc/systemd/system/birdframe.service >/dev/null
sudo cp systemd/birdframe.timer /etc/systemd/system/birdframe.timer
sudo systemctl daemon-reload
# --now: also START the timer, so the no-reboot path (SPI already up) doesn't
# leave the frame armed-but-idle until the next reboot.
sudo systemctl enable --now birdframe.timer

cat <<DONE

Installed. Set your image source in ~/.birdframe/config.toml (your /frame.png
key, or shoot = true); the panel fills itself in and refreshes every 5 min,
only when the birds change.
DONE

# SPI only takes effect on a reboot, so do it for the user. Skip if SPI is
# already up (e.g. a re-run) so we don't bounce a working frame.
if [ -e /dev/spidev0.0 ]; then
  echo "SPI already active, no reboot needed."
else
  echo "Rebooting to bring SPI up (back on its own in ~1 min)..."
  sleep 4
  sudo reboot
fi
