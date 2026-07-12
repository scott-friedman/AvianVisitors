#!/usr/bin/env python3
# UNUSED in the Cloudflare deployment (avian-worker's /frame.png renders the screenshot off-Pi; this still targets the old 13.3" geometry) — kept for upstream reference.
"""Screenshot the live AvianVisitors collage for the e-ink frame.

Loads the real site (the LAN default http://birdnet.local, or a forwarded
public URL) at a portrait viewport, hides the controls, sets the frame
titles, and rewrites a few of the page's own apt.js tunables at capture time
(cluster bias, count-to-size exponent, a rare-bird floor). The result is the
actual website, framed for the wall, with no changes to AvianVisitors.

Needs a real headless browser, so it runs on any 64-bit capable machine, NOT
the Pi Zero W driving the panel. Writes a 1200x1600 PNG; display.py turns it
into panel pixels.

  pip install playwright && playwright install chromium
  python3 shoot.py --url https://bird.onethreenine.net \
      --title "onethreenine birds" --subtitle "heard today" --out frame.png
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

# Hide the controls and the other views, freeze animations. Titles + collage
# stay. Injected before first paint.
HIDE_CSS = """
  .top, .slider, .return-to-atlas, #menu-dd, #detail-modal, #about-modal,
  .admin-screen, #collageTip, .modal-backdrop, #v1, #v2 { display: none !important; }
  .views { transform: none !important; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
  html, body { background: var(--paper, #efece0) !important; }
"""


def _frame_css(headline_px, eyebrow_px, lowercase, pad_top, pad_side, pad_bottom, collage_vh):
    css = (
        f".stage {{ padding: {pad_top}px {pad_side}px {pad_bottom}px !important;"
        f" box-sizing: border-box !important; justify-content: center !important; }}"
        f".views {{ flex: 0 0 auto !important; height: {collage_vh}vh !important; }}"
        f".view#v0 {{ height: 100% !important; flex: 1 1 100% !important; padding: 6px 0 !important; }}"
        f".gcollage {{ max-width: none !important; }}"
        f".static-head {{ padding: 0 8px 14px !important; }}"
        f".static-head .pre {{ font-size: {eyebrow_px}px !important; }}"
        f".static-head h1 {{ font-size: {headline_px}px !important; }}"
    )
    if lowercase:
        css += ".static-head h1 { text-transform: none !important; }"
    return css


def _safe_continue(route):
    try:
        route.continue_()
    except Exception:
        pass


def _make_api_handler(floor_frac, window_hours, auth):
    """Re-window action=recent (to preview busy days) and floor the rarest
    counts so the packer draws them a little larger."""
    def handler(route):
        req = route.request
        if "action=recent" not in req.url:
            return route.continue_()
        try:
            url = re.sub(r"hours=\d+", f"hours={int(window_hours)}", req.url) if window_hours else req.url
            kw = {"url": url}
            if auth:
                kw["headers"] = {**req.headers, "authorization": auth}
            data = route.fetch(**kw).json()
            sp = data.get("species", [])
            if sp and floor_frac > 0:
                floor = max((s.get("n") or 1) for s in sp) * floor_frac
                for s in sp:
                    if (s.get("n") or 1) < floor:
                        s["n"] = max(1, round(floor))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        except Exception as e:
            print(f"recent-API rewrite skipped: {e}", file=sys.stderr)
            _safe_continue(route)
    return handler


def _make_js_handler(xbias, ybias, count_exp, pad, auth, misses):
    """Rewrite the collage tunables inside the page's apt.js at capture time."""
    def handler(route):
        try:
            kw = {"headers": {**route.request.headers, "authorization": auth}} if auth else {}
            js = route.fetch(**kw).text()
            for pat, repl in ((r"var xBias = narrow \? 1 : T\.ellipseAspectBias;", f"var xBias = {xbias};"),
                              (r"var yBias = narrow \? 1\.7 : 1;", f"var yBias = {ybias};"),
                              (r"countExp:\s*[\d.]+,", f"countExp: {count_exp},"),
                              (r"var pad = narrow \? Math\.max\(1, COLLAGE_PAD - 1\) : COLLAGE_PAD;", f"var pad = {pad};")):
                js, n = re.subn(pat, repl, js)
                if not n:
                    misses.append(pat)
            route.fulfill(status=200, content_type="application/javascript; charset=utf-8", body=js)
        except Exception as e:
            print(f"apt.js rewrite skipped: {e}", file=sys.stderr)
            _safe_continue(route)
    return handler


def shoot(url, out, *, title=None, subtitle=None, vw=600, vh=800, dsf=2,
          headline_px=42, eyebrow_px=18, lowercase=False,
          mat=0.04, collage_vh=52, cluster_xbias=1.0, cluster_ybias=1.2,
          count_exp=0.4, cluster_pad=1, small_floor=0.04, window_hours=None,
          timeout_ms=45000, user=None, password=None):
    pad_side, pad_top, pad_bottom = int(vw * mat), int(vh * mat * 0.92), int(vh * mat)
    auth = "Basic " + base64.b64encode(f"{user}:{password or ''}".encode()).decode() if user else None

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb"])
        try:
            ctx_kw = {"viewport": {"width": vw, "height": vh}, "device_scale_factor": dsf}
            if user:
                ctx_kw["http_credentials"] = {"username": user, "password": password or ""}
            page = browser.new_context(**ctx_kw).new_page()
            misses = []
            page.route("**/birdnet-api.php**", _make_api_handler(small_floor, window_hours, auth))
            page.route("**/apt.js*", _make_js_handler(cluster_xbias, cluster_ybias, count_exp, cluster_pad, auth, misses))

            css = HIDE_CSS + _frame_css(headline_px, eyebrow_px, lowercase, pad_top, pad_side, pad_bottom, collage_vh)
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded',function(){"
                "var s=document.createElement('style');s.textContent=" + json.dumps(css) +
                ";document.head.appendChild(s);});")

            resp = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            if resp is None or not resp.ok:
                raise RuntimeError(f"site returned {resp.status if resp else 'no response'}")
            page.wait_for_selector(".gtile", timeout=timeout_ms)  # no collage -> fatal, keep the last frame
            try:
                page.wait_for_function(
                    "() => { const t=[...document.querySelectorAll('.gtile img')];"
                    " return t.length>0 && t.every(i=>i.complete && i.naturalWidth>0); }",
                    timeout=timeout_ms)
            except PWTimeout:
                print("some illustrations did not finish loading; capturing anyway", file=sys.stderr)
            if misses:
                raise RuntimeError(f"apt.js tunables not found ({len(misses)}); refusing to ship a half-tuned frame")

            if title is not None:
                page.evaluate("t=>{const e=document.querySelector('.static-head .pre'); if(e)e.textContent=t;}", title)
            if subtitle is not None:
                page.evaluate("s=>{const e=document.querySelector('.static-head h1'); if(e)e.textContent=s;}", subtitle)
            page.wait_for_timeout(250)
            # clip is CSS px; device_scale_factor scales the PNG to vw*dsf by vh*dsf = 1200x1600
            page.screenshot(path=out, clip={"x": 0, "y": 0, "width": vw, "height": vh})
        finally:
            browser.close()
    return out


def main():
    ap = argparse.ArgumentParser(description="Screenshot the AvianVisitors collage for the e-ink frame.")
    ap.add_argument("--url", default="http://birdnet.local")
    ap.add_argument("--out", default="frame.png")
    ap.add_argument("--title")
    ap.add_argument("--subtitle")
    ap.add_argument("--lowercase", action="store_true")
    ap.add_argument("--headline-px", type=int, default=42)
    ap.add_argument("--eyebrow-px", type=int, default=18)
    ap.add_argument("--mat", type=float, default=0.04)
    ap.add_argument("--collage-vh", type=float, default=52)
    ap.add_argument("--cluster-xbias", type=float, default=1.0)
    ap.add_argument("--cluster-ybias", type=float, default=1.2)
    ap.add_argument("--count-exp", type=float, default=0.4)
    ap.add_argument("--cluster-pad", type=int, default=1)
    ap.add_argument("--small-floor", type=float, default=0.04)
    ap.add_argument("--window-hours", type=int)
    ap.add_argument("--width", type=int, default=600)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--dsf", type=int, default=2)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--timeout", type=int, default=45000)
    a = ap.parse_args()
    try:
        shoot(a.url, a.out, title=a.title, subtitle=a.subtitle, vw=a.width, vh=a.height, dsf=a.dsf,
              headline_px=a.headline_px, eyebrow_px=a.eyebrow_px, lowercase=a.lowercase,
              mat=a.mat, collage_vh=a.collage_vh, cluster_xbias=a.cluster_xbias,
              cluster_ybias=a.cluster_ybias, count_exp=a.count_exp, cluster_pad=a.cluster_pad,
              small_floor=a.small_floor,
              window_hours=a.window_hours, timeout_ms=a.timeout, user=a.user, password=a.password)
    except Exception as e:
        print(f"shoot failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
