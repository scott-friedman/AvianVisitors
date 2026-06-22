# FRAME-MATTING-PLAN.md — size the display to the matted frame opening

> **Cold-start runbook.** Self-contained: a fresh session needs only this file +
> `CLAUDE.md`. The measurement card and its generator are already built (see
> *Status*). The on-site steps (push, read, apply) are done **with the human in
> front of the panel** — they are the eyes.

## Plain English Summary

We mounted the bird picture-frame's screen behind a paper **mat** (the cardboard
border inside a picture frame). The mat overlaps the screen's outer edge, so a
thin strip all the way around the picture is **hidden behind the mat**. Today the
software draws the bird collage as if the *whole* screen shows, so a bird or a
label near the edge can vanish under the mat.

This plan measures **exactly how wide that hidden strip is on each side**, then
tells the software to keep the picture inside the part you can actually see — so
nothing important gets cut off and the collage fills the opening cleanly.

How we measure it: we put a **ruler on the screen**, look at which numbers the
mat covers on each edge, and do a little arithmetic. That's the whole trick.

What you'll notice afterward: the collage sits neatly inside the frame opening,
with no birds or text disappearing under the cardboard.

---

## Status (what's already prepared)

- **`frame/calibrate.py`** — generates the ruler test card (+ a `--window L,T,R,B`
  green verify card). ✅ written + committed. Run `python3 frame/calibrate.py` →
  writes `~/Downloads/calib-matting.png` (800×480). Pure 7-colour ACeP inks so the
  panel renders it crisp, no dither.
- **The card** was generated once already; regenerate anytime with the command above.
- **Done 2026-06-21:** pushed on-site → read the visible window → applied per-edge
  insets **and** a fine tilt correction → verified by eye. Final values in *Result* below.

## Background (the facts that make this work)

- Panel: **Inky Impression 7.3", 800×480 landscape, 7-colour**. ~5 px/mm
  (127.8 px/in), so a typical ~3 mm mat overlap ≈ **~15 px/side**; expect insets
  roughly in the **10–30 px** range.
- Production frame settings: **`rotate = 0`, `border = 0`** (landscape, full-bleed)
  — see `frame/config.example.toml:20-21`. The live copy is on the Pi at
  `~/.birdframe/config.toml`.
- `frame/display.py --image <png>` pushes any local PNG straight to the panel
  (it dithers to the 7-colour palette via the Inky lib; pure-palette inks pass
  through clean). `--force --no-signature` bypasses change-detection + quiet hours.
- The Pi is **outbound-only** and the SSH tunnel is **password-gated** (`ssh bird-pi`).
  A headless session may not be able to type that password — see *Gotchas*.

---

## Procedure

### 1. (Re)generate the card — on the Mac
```bash
python3 frame/calibrate.py            # -> ~/Downloads/calib-matting.png (800x480)
```

### 2. Confirm the panel's rotation — so the test matches production
```bash
ssh bird-pi 'grep -E "^rotate" ~/.birdframe/config.toml'   # expect: rotate = 0
```
Use that value for `--rotate` in step 4 (default **0**). If the live config ever
differs from 0, push with the live value so the measured window matches what
real frames will show.

### 3. Copy the card to the Pi — from the Mac
```bash
scp ~/Downloads/calib-matting.png bird-pi:~/calib-matting.png
```

### 4. Push it — on the Pi (`ssh bird-pi`)
```bash
sudo systemctl stop birdframe.timer        # stop the 5-min auto-refresh clobbering the test
cd "$(systemctl show -p WorkingDirectory --value birdframe.service)"   # real frame dir, no guessing
.venv/bin/python display.py --image ~/calib-matting.png --border 0 --rotate 0 --force --no-signature
```
**Push with `--border 0`** — we are measuring the *raw* panel-vs-mat geometry.
(Applying a border now would measure the wrong thing.)

### 5. Read the panel — the human reports these five things
The card has a **horizontal ruler = X axis** (0 left → 800 right) and a
**vertical ruler = Y axis** (0 top → 480 bottom). Each ruler sits in the safe
zone for the *other* axis, so matting on one pair of edges can't hide the other
ruler's read.

1. **Horizontal ruler** — smallest number visible at the **left**, largest at the **right**.
2. **Vertical ruler** — smallest visible at the **top**, largest at the **bottom**.
3. **Red edge** — visible on each side? (top / bottom / left / right). Visible red = ~0 crop there.
4. **Blue corner tags** (TL/TR/BL/BR) — can you read all four? A hidden tag = that corner's mat eats >34 px.
5. Anything **rotated/mirrored** vs. the generated card.

### 6. Restore normal operation — on the Pi
```bash
sudo systemctl start birdframe.timer
```

---

## Compute the visible window

```
left   = smallest visible X
right  = 800 − largest visible X
top    = smallest visible Y
bottom = 480 − largest visible Y

visible window = (left, top) .. (800 − right, 480 − bottom)
visible size   = (800 − left − right) × (480 − top − bottom)
```

**Worked example** — reads X: 20…780, Y: 20…460:
`left=20, right=20, top=20, bottom=20` → visible **760×440**, centred, symmetric.

If reads land between labels (20 px apart), the minor ticks are 10 px; round to
the nearest tick. Want finer than ~10 px? See *Optional refinement*.

---

## Apply the result

**Decide by symmetry:**

- **Roughly symmetric** (all four insets within ~5 px of each other) — set a
  single white margin in `~/.birdframe/config.toml` on the Pi:
  ```toml
  border = 20      # = round(max inset); white margin hides under the mat
  ```
  No code change. The next timer run (≤5 min) picks it up, or force one:
  `cd "$(systemctl show -p WorkingDirectory --value birdframe.service)" && .venv/bin/python display.py --force --no-signature`.
  This is the **expected, likely case** — picture-frame mats are usually cut even.

- **Lopsided** (insets differ by more than ~5 px) — `border` can't express it
  (it's symmetric). Add **per-edge insets**, kept Pi-side (no Worker change),
  by generalising `fit_panel` (`frame/display.py:121`). Sketch:
  ```python
  def fit_window(img, left=0, top=0, right=0, bottom=0):
      box_w = max(1, PANEL_W - left - right)
      box_h = max(1, PANEL_H - top - bottom)
      src, tgt = img.width / img.height, box_w / box_h
      if src > tgt: nw, nh = box_w, max(1, round(box_w / src))
      else:         nh, nw = box_h, max(1, round(box_h * src))
      resized = img.resize((nw, nh), Image.LANCZOS)
      canvas = Image.new("RGB", (PANEL_W, PANEL_H), (255, 255, 255))
      canvas.paste(resized, (left + (box_w - nw)//2, top + (box_h - nh)//2))
      return canvas
  ```
  Wire a config key `inset = [left, top, right, bottom]` (+ matching CLI flags),
  keep `border` as the symmetric shortcut, and call `fit_window` from `run()`
  when `inset` is set. Then set the measured values in `~/.birdframe/config.toml`.

> If every read shows visible red and full corner tags with X≈0…800 / Y≈0…480,
> the mat opening is **bigger than the panel** — no crop, nothing to apply.

## Verify

Re-push the card (or any real `/frame.png`) **with the chosen border/inset** and
confirm by eye: even margins all around, no ruler/content clipped at the opening.
(Optional: extend `calibrate.py` with a `--window L,T,R,B` mode that fills only
the computed window in green — if green reaches all four mat edges evenly, the
window is correct.)

## Result (measured & applied 2026-06-21)

All three live on the Pi in `~/.birdframe/config.toml` (Pi-local, not in-repo); the
code that reads them is in `frame/display.py`.

- **Visible window:** `inset = [8, 40, 44, 37]` (left, top, right, bottom px) →
  visible **748 × 403**. Overrides `border`; applied by `fit_window()`. Horizontal
  was lopsided (panel ~15 px left-of-centre behind the mat), so a symmetric `border`
  couldn't express it.
- **Level fix:** the panel sits ~1.7° CCW in the frame → **`tilt = -1.7`** (deg, +CCW),
  a fine-rotation knob (`img.rotate(tilt, expand=False, fill=white)`); the white corner
  wedges land under the mat.
- **Fill:** the off-Pi `/frame.png` centres a small cluster (~40 % of the panel, 60 %
  blank), so **`fill = true`** (+ `fill_pad = 16`) autocrops the whitespace and scales
  the collage to fill the window — `autocrop()` → `fit_window()`. Adapts as detections
  accumulate (fewer birds → bigger; more → tighter).

## Done when

- [x] Visible window computed: `inset = [8, 40, 44, 37]` → 748 × 403.
- [x] Applied — per-edge `inset` + `fit_window`, plus `tilt` and `fill`, in `~/.birdframe/config.toml`.
- [x] `birdframe.timer` re-enabled.
- [x] Verified by eye: collage fills the opening, sits level, nothing clipped.
- [x] Committed `frame/calibrate.py` + `frame/display.py`; measured values recorded above.

---

## Gotchas

- **Measure with `border 0`.** Pushing the card with the production border would
  measure the wrong geometry.
- **Match `rotate` to the live config** (step 2). The physical mat is fixed; to
  know which *content* pixels are hidden, push through the same rotation production uses.
- **Stop `birdframe.timer` first** (step 4) or the 5-min auto-refresh overwrites
  the test card mid-measurement. Re-enable after (step 6).
- **Pure-palette inks only** if you edit the card — white/black/red/blue/green/
  yellow/orange (see `INKY7` in `frame/display.py`). Gradients or grey would
  dither into noise and misread.
- **Password-gated tunnel.** `ssh bird-pi` / `scp bird-pi:` may prompt for the
  Pi password, which a headless session can't type. If it prompts, **the human
  runs the push commands** and reports the panel; the session computes + applies.
  If SSH is key/agent-authenticated (no prompt), the session can drive it.
- **macOS has no `timeout`.** To bound an SSH probe use `ssh -o ConnectTimeout=8`
  (or `gtimeout` from coreutils) — not `timeout`.
- **Need the venv.** `display.py` imports PIL + inky; always invoke it via the
  frame venv (`.venv/bin/python`, reached by the `WorkingDirectory` cd in step 4),
  not the system python.
