#!/usr/bin/env bash
# bird — add or change a wifi network on the Pi (NetworkManager). Idempotent.
#
# Usage:
#   bash set-wifi.sh "<SSID>" "<password>" [priority] [--hidden] [--wpa3]
#
# Examples:
#   bash set-wifi.sh "DadsHouse"  "hunter2"   100      # primary (joins first when in range)
#   bash set-wifi.sh "ScottPhone" "rescue123"  50      # rescue hotspot (lower priority)
#
# Higher priority wins when more than one known network is in range. Re-running
# with the same SSID updates the password/priority. After saving, it auto-joins
# that SSID whenever it's in range; it does NOT switch networks right now unless
# you add `up` (see the last line it prints).
#
# Notes for the Zero 2 W: it is 2.4 GHz ONLY. Use the 2.4 GHz SSID; on an iPhone
# hotspot enable "Maximize Compatibility". Use --wpa3 only for WPA3-personal-ONLY
# networks (WPA2 and WPA2/WPA3-mixed work without it). Use --hidden for a hidden SSID.
set -euo pipefail

SSID="${1:?usage: set-wifi.sh <SSID> <password> [priority] [--hidden] [--wpa3]}"
PSK="${2:?password required}"
PRIO="${3:-50}"
KEYMGMT="wpa-psk"
HIDDEN="no"
for a in "$@"; do
  [ "$a" = "--wpa3" ] && KEYMGMT="sae"
  [ "$a" = "--hidden" ] && HIDDEN="yes"
done
CON="wifi-$(printf '%s' "$SSID" | tr ' /' '__')"

if nmcli -t -f NAME connection show | grep -qx "$CON"; then
  echo "==> updating existing profile '$CON' (SSID '$SSID')"
  sudo nmcli connection modify "$CON" \
    wifi-sec.key-mgmt "$KEYMGMT" wifi-sec.psk "$PSK" \
    wifi.hidden "$HIDDEN" \
    connection.autoconnect yes connection.autoconnect-priority "$PRIO"
else
  echo "==> creating profile '$CON' (SSID '$SSID')"
  sudo nmcli connection add type wifi con-name "$CON" ssid "$SSID" \
    wifi-sec.key-mgmt "$KEYMGMT" wifi-sec.psk "$PSK" \
    wifi.hidden "$HIDDEN" \
    connection.autoconnect yes connection.autoconnect-priority "$PRIO"
fi

echo "==> known wifi profiles now:"
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print "    "$1}'
echo
echo "Saved. It will auto-join '$SSID' when in range. To switch to it right now"
echo "(only works if that network is currently in range):"
echo "    sudo nmcli connection up '$CON'"
