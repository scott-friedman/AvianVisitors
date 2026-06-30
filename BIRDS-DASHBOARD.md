# Barry's Birds — HA admin dashboard (PLAN — DONE, fully deployed)

> **State (2026-06-30): FULLY DEPLOYED & LIVE.** The Home Assistant "Birds" page + sensors +
> alerts are live, **and** the bird-repo half shipped: `GET /api/coverage` (`worker/src/index.js`,
> + `PAGES_BASE` in `wrangler.toml`) and the `art-manifest.json` emit (`avian/build-site.sh`)
> are deployed (Worker `wrangler deploy` + Pages `barrysbirds` production). Live coverage: 46
> detected · 283 with art · 37 signatures · **art gap 0 · 10 addable signature gaps.**
> The as-built doc is the canonical one in the **HA repo** at `barrys-birds/BARRYS-BIRDS.md`.
> Everything below is the original Option-A proposal, kept for history.

---

## ⛑ Cold-start resume — read this first

You are a fresh session picking up this plan. Here's everything you need:

**What this is:** add a private "Barry's Birds" *admin* page to Scott's Home Assistant (analytics +
"something's broken" push alerts). NOT a clone of the public collage. Sits next to his Tesla /
Starshit HA pages.

**Two repos are involved:**
- **bird repo** = `/Users/scott/bird` (this file lives here). Owns the Cloudflare Worker
  (`worker/src/index.js`) + Pages build (`avian/build-site.sh`). Worker base URL:
  `https://avian-worker.s-friedman.workers.dev`. Read its `CLAUDE.md` for deploy conventions.
- **HA repo** = `/Users/scott/homeassistant`. Owns the dashboard YAML + sensors + automations.
  Read its `CLAUDE.md` for the access model: edits go in `config/` (git-tracked), pushed via
  `cat file | ssh ha-green 'cat > /config/file'`, validated with `ssh ha-green 'ha core check'`,
  applied with `ha core restart`. REST CLI: `./scripts/ha.py`. iPhone push target:
  `notify.mobile_app_linguine_pro_2`.

> ⚠️ **HOLD:** as of 2026-06-30 Scott put the **HA repo + live HA instance on a no-touch hold**
> ("purely research"). Before you write/push *anything* to `/homeassistant` or call HA services,
> **confirm with Scott that the hold is lifted.** Bird-repo work (the `/api/coverage` endpoint) was
> not under the hold, but confirm anyway. Until then this stays research/code-only-in-bird-repo.

**Decisions still open (ask Scott if unanswered):** see "Open questions" at the bottom — Option A
vs B (A chosen), whether HA also owns liveness (UptimeRobot already does), mic-quiet threshold,
notification cadence.

**First concrete step (Option A):** implement `GET /api/coverage` in `worker/src/index.js` (see
"where the gap logic lives" below), plus the one-line `art-manifest.json` emit in
`avian/build-site.sh`. Then the HA package + dashboard (once the hold lifts).

**Re-verify the live data before coding** (read-only; `curl` needs a non-default User-Agent or
Cloudflare 403s it):
```bash
B=https://avian-worker.s-friedman.workers.dev; UA="Mozilla/5.0 (avian-admin-probe)"
curl -s -A "$UA" "$B/api/status"
curl -s -A "$UA" "$B/api/birdnet-api.php?action=stats"
curl -s -A "$UA" "$B/api/birdnet-api.php?action=lifelist"
curl -s -A "$UA" "https://barrysbirds.pages.dev/assets/signatures.json"   # song-signature set
```

**When the HA hold lifts, this doc's home should move to the HA repo** as
`/homeassistant/BIRDS-DASHBOARD.md` + one new row in that repo's `CLAUDE.md` *Reference docs* table
(that's where a cold-start *HA* session looks). It lives in the bird repo for now only because the
HA repo is on hold.

---

## Plain-English summary

Out in Sudbury, a Raspberry Pi listens for birds 24/7 and sends every bird it hears up to a
little server in the cloud (the "Worker"). That server already knows a lot: how many birds were
heard today, which species, when the box last checked in, and so on. It just has no *dashboard* —
you only see the pretty public collage, not the behind-the-scenes health.

This plan adds a **private "Barry's Birds" admin page to your Home Assistant**, next to your Tesla
and Starshit pages. It does two jobs:

1. **Data analysis at a glance** — today/this-week/all-time counts, the species leaderboard, when
   the last bird was heard, and trend graphs that fill in over time.
2. **Tells you when something's broken**, by pushing your iPhone when:
   - the box at Dad's goes silent (mic dead, internet dropped),
   - it's been hours since *any* bird was heard while the box is still online (a mic/listening
     problem, not a network one),
   - a bird gets detected that **has no illustration** — so it's invisible on the collage and the
     picture frame until you draw it,
   - a bird gets detected that **has no "song signature"** — so its tap-to-see sound fingerprint
     is blank.

The nice part: because the cloud server is already a public web API, Home Assistant can read it
**directly**. No new Pi software, no new always-on container on your NAS, no message broker — this
is the *lightest* of your HA subsystems. It's mostly a dashboard page plus a handful of "go read
this web address every few minutes" sensors.

**What you'll notice:** a new "Birds" page in the HA sidebar with the numbers and graphs, and the
occasional push like *"🎨 New bird with no art: Eastern Towhee (heard 4×)"* or *"🔇 Barry's Birds:
box online but no birds heard in 6 h — check the mic."*

**One honest caveat:** your UptimeRobot monitor *already* watches the box's liveness. So the
genuinely *new* value HA adds is the **analytics page + the art/signature gap alerts**. Liveness
is included as a bonus card (and a nicer push than UptimeRobot's email) — but it's not the reason
to build this.

---

## What it is / isn't

- **IS:** an admin/ops view — numbers, lists, health, alerts. Read-only against the public Worker.
- **ISN'T:** a second copy of the public collage. No bird illustrations rendered in HA, no e-ink
  preview. If you want to *see* the birds you open `barrysbirds.pages.dev`; this page is for
  *running* the thing.

---

## Architecture (the lightest subsystem you have)

```
  Cloudflare Worker (already public, JSON)            Home Assistant Green
  https://avian-worker.s-friedman.workers.dev         (config-as-code, this repo)
  ┌───────────────────────────────────┐               ┌──────────────────────────────┐
  │ /api/status        (liveness)      │  HTTPS poll   │ rest: sensors  (every 5–30m)  │
  │ /api/birdnet-api.php?action=stats  │ ────────────► │   ↓                            │
  │   …=lifelist  …=hourly  …=rhythm   │  (read-only)  │ birds-dashboard.yaml (page)    │
  │ /api/coverage  (NEW, optional)     │               │ automations → iPhone push      │
  └───────────────────────────────────┘               └──────────────────────────────┘
```

Contrast with Tesla/Street-cleaning, which need a NAS publisher container + the MQTT broker. This
needs **neither** — the Worker *is* the publisher. HA's built-in `rest` integration polls it.

**Gotcha to bake in:** Cloudflare **403s the default Python-urllib User-Agent** (documented in the
bird repo's CLAUDE.md — it cost a debug cycle there). HA's `rest` uses aiohttp, not urllib, but to
be safe every `rest:` resource below sets an explicit `User-Agent` header. (`curl` is unaffected,
which is why the probes worked.)

---

## Data model — what each endpoint returns (verified live 2026-06-30)

| Purpose | URL (relative to the Worker base) | Shape (real sample) |
|---|---|---|
| **Liveness** | `/api/status` | `{alive:true, last_heartbeat:"…Z", heartbeat_age_seconds:92, max_age_seconds:2700, last_detection:"…Z", last_detection_age_seconds:11066}` — HTTP **200 fresh / 503 stale** |
| **Headline stats** | `/api/birdnet-api.php?action=stats` | `{totals:{detections:11747,species:46}, today:{detections:1124,species:27}, week:{detections:7241,species:43}, last_hour:{detections:0}, started:"2026-06-19"}` |
| **Per-species (life list)** | `…?action=lifelist` | `{species:[{sci,com,first_seen,last_seen,n,best_conf}, …]}` — the master list of every species ever detected, keyed by scientific name |
| **Hour-of-day** | `…?action=hourly` | activity by clock hour (for a chart) |
| **Coverage gaps** | `/api/coverage` **(does not exist yet — see decision)** | proposed: `{art_missing:[…], signature_missing:[…], signature_addable:[…]}` |
| **Song-signature set** | `https://barrysbirds.pages.dev/assets/signatures.json` | `{version, generated, species:{<sci>:{…}}}` — `species` keys = the 37 species that currently have a signature |

The base URL lives in `secrets.yaml` (it's not really secret, but it keeps the dashboard YAML
portable): `barrys_birds_base: https://avian-worker.s-friedman.workers.dev`.

---

## The one real decision: where the gap logic lives

The liveness + stats cards are trivial. The **gap detection** (art / signatures) is the wrinkle,
because answering "which detected birds have no picture?" means comparing three lists:

1. **Detected species** — from `/api/lifelist` (easy, one fetch). *46 species today.*
2. **Species with art** — the set of illustration files (`avian/assets/illustrations/<slug>.png`,
   slug = `lower(sci)` with non-alphanumerics → `-`; flight pose is `<slug>-2.png`; *283 perched
   today*). **Not a clean endpoint** — it's embedded in the 560 k-line `apt.js`, and **Pages
   serves a fake `200 OK` HTML page for a missing image** (documented gotcha), so HA *cannot* just
   probe image URLs and trust the status code.
3. **Species with a song signature** — from `/assets/signatures.json` (`species` is a dict keyed by
   scientific name). *37 species today.*

Two ways to resolve the art-list problem:

### Option A — add one Worker endpoint `/api/coverage` *(CHOSEN)*

~30 lines in the **bird repo** (not HA): the Worker already has the life list in D1; give it the
art-slug set (a build-time `art-manifest.json` that `build-site.sh` emits in one line) and the
signatures set, and have it return the gap lists pre-computed. Then HA is dumb: **one** `rest`
sensor with `json_attributes`, and the dashboard + automations just read attributes.

- ✅ Cleanest, least brittle, no Jinja set-math, no scripts on the HA box.
- ✅ Exempt list (species with no song *by design*) lives in one place and is returned as a
  separate `signature_addable` array, so alerts only nag about fixable gaps.
- ➖ Touches the bird repo (a build session). Fits "minimal moving parts" overall.

**Suggested `/api/coverage` response:**
```json
{
  "art_missing":        [{"sci":"…","com":"…","n":4}],
  "signature_missing":  [{"sci":"…","com":"…","n":2}],
  "signature_addable":  [{"sci":"…","com":"…","n":2}],
  "totals": {"detected":46, "with_art":283, "with_signature":37},
  "as_of": "…Z"
}
```
Implementation notes for the Worker: read the life list from D1 (reuse the `lifelist` query);
load `art-manifest.json` (bundle it, or fetch own Pages `…/assets/art-manifest.json`) and
`signatures.json`; `signature_addable = signature_missing − EXEMPT`. **EXEMPT** = species with no
`type:song` clip on xeno-canto by design: Ruby-throated Hummingbird (*Archilochus colubris*),
Hairy Woodpecker (*Dryobates villosus*), Yellow-bellied Sapsucker (*Sphyrapicus varius*). Set
`Cache-Control: no-store` or a short TTL; gate is unnecessary (read-only, no metered work).

### Option B — pure HA, zero bird-repo changes *(not chosen)*

- **Signature gap:** doable in HA alone — fetch `lifelist` + `signatures.json`, diff in a template
  sensor. Slightly fiddly Jinja but fine.
- **Art gap:** still needs an art manifest. Either ugly per-species probing (and you must check
  `content-type`, not status, because of the HTML fallback) or a one-line `build-site.sh` tweak to
  emit `art-manifest.json` — at which point you've touched the bird repo anyway, so Option A is the
  better version of the same change.
- ➖ HA's `command_line` sensor (which would let a small Python script do the cross-ref) is
  **unreliable here** — the HA SSH/OS environment has no guaranteed `python3`/`jq` on PATH (per the
  HA repo's CLAUDE.md). So the pure-HA route leans on Jinja templates — workable but the
  weakest-fit piece.

---

## Sensors (HA `rest:` integration)

Lives in a package: `config/packages/barrys_birds.yaml`.
⚠️ **Package-slug rule** (HA repo gotcha): the filename's `<name>` is the package key and must be a
valid slug — **underscores, no hyphens** → `barrys_birds.yaml`, *not* `barrys-birds.yaml`. A bad
slug is silently skipped and `ha core check` still passes.

```yaml
# config/packages/barrys_birds.yaml   (PROPOSAL — not applied)
rest:
  # ---- liveness (poll ~5 min) ----
  - resource_template: "{{ '%s/api/status' % '<BASE>' }}"   # <BASE> = Worker base URL
    scan_interval: 300
    headers:
      User-Agent: "home-assistant-barrys-birds/1.0"   # avoid the Cloudflare 403
    sensor:
      - name: "Barry's Birds Heartbeat Age"
        unique_id: bb_heartbeat_age
        value_template: "{{ value_json.heartbeat_age_seconds }}"
        unit_of_measurement: s
      - name: "Barry's Birds Last Detection Age"
        unique_id: bb_last_detection_age
        value_template: "{{ value_json.last_detection_age_seconds }}"
        unit_of_measurement: s
    binary_sensor:
      - name: "Barry's Birds Online"
        unique_id: bb_online
        device_class: connectivity
        value_template: "{{ value_json.alive }}"

  # ---- headline stats (poll ~10 min) ----
  - resource_template: "{{ '%s/api/birdnet-api.php?action=stats' % '<BASE>' }}"
    scan_interval: 600
    headers: { User-Agent: "home-assistant-barrys-birds/1.0" }
    sensor:
      - name: "Barry's Birds Today Detections"
        unique_id: bb_today_detections
        value_template: "{{ value_json.today.detections }}"
        state_class: measurement
      - name: "Barry's Birds Today Species"
        unique_id: bb_today_species
        value_template: "{{ value_json.today.species }}"
      - name: "Barry's Birds Total Species"
        unique_id: bb_total_species
        value_template: "{{ value_json.totals.species }}"
      - name: "Barry's Birds Total Detections"
        unique_id: bb_total_detections
        value_template: "{{ value_json.totals.detections }}"

  # ---- coverage gaps (poll ~30 min) — Option A endpoint ----
  - resource_template: "{{ '%s/api/coverage' % '<BASE>' }}"
    scan_interval: 1800
    headers: { User-Agent: "home-assistant-barrys-birds/1.0" }
    sensor:
      - name: "Barry's Birds Art Gap"
        unique_id: bb_art_gap
        value_template: "{{ value_json.art_missing | length }}"
        json_attributes: [art_missing]
      - name: "Barry's Birds Signature Gap"
        unique_id: bb_sig_gap
        value_template: "{{ value_json.signature_addable | length }}"
        json_attributes: [signature_missing, signature_addable]
```

> **Entity-id gotcha** (HA repo): a sensor's `entity_id` is derived from its **`name`**, not
> `unique_id`, and is **sticky once registered** — so `name: "Barry's Birds Today Detections"` ⇒
> `sensor.barry_s_birds_today_detections`. Get the names right the first time; editing `name`
> later won't move the id (you'd fix references instead). New sensors need a full `ha core restart`,
> not a reload.

HA's **recorder** will retain the numeric sensors automatically → you get free trend history.

---

## Dashboard page (`config/birds-dashboard.yaml`)

YAML-mode dashboard registered in `configuration.yaml` under `lovelace: dashboards:` — same pattern
as `tesla-dashboard.yaml` and `starshit-dashboard.yaml`. Built-in cards only (no HACS dependency):

1. **Header / liveness** — a Mushroom/`entity` or `glance` row: 🟢 Online / 🔴 Offline
   (`binary_sensor.barry_s_birds_online`), "last heard N min ago", "last check-in N min ago".
2. **Headline numbers** — `glance` of Today detections / Today species / Week / All-time species.
3. **Trends** — `statistics-graph` (or `history-graph`) of Today-detections and Total-species over
   time. Fills in as the recorder accumulates. *(Optional upgrade: an ApexCharts card hitting
   `?action=hourly`/`rhythm` for the hour-of-day shape the Worker already computes — only if
   `apexcharts-card` is installed in HACS; check first.)*
4. **Species leaderboard** — a `markdown` card rendered from a lifelist sensor's attributes
   (top N by count), or `auto-entities` if available.
5. **🎨 Art gap** — `markdown` listing `sensor.barry_s_birds_art_gap` attributes (species + count),
   or "✅ all detected birds have art" when zero.
6. **🎵 Signature gap** — same, from the signature-gap attributes (the *addable* list).

---

## Alerts (automations → `notify.mobile_app_linguine_pro_2`)

Push target is **`notify.mobile_app_linguine_pro_2`** (the current iPhone reg; plain `linguine_pro`
is stale and drops action buttons — per the HA repo).

1. **Box down** — `binary_sensor.barry_s_birds_online` → `off` for `for: 00:10:00` → push.
   *(Overlaps UptimeRobot; keep one. If HA owns it, you can silence UptimeRobot or leave it as
   belt-and-suspenders.)*
2. **Mic quiet** — `online == on` **and** `sensor.barry_s_birds_last_detection_age > 6 h`
   **and** it's daytime (`sun.sun` above horizon, since quiet nights are normal). This is the
   distinct "box fine, ears broken" case the Worker's `/api/status` comment calls out.
3. **New art gap** — `sensor.barry_s_birds_art_gap` rises above 0 (or its attribute list gains a
   species). Push the new species + count. Throttle so it nags once/day, not per poll (e.g. a
   `notify` with a stable `tag` so it updates in place, or a `condition` against a
   "last-notified" `input_text` helper).
4. **New signature gap** — same, on the **addable** list (so the 3 by-design-empty species —
   RT Hummingbird, Hairy Woodpecker, Y-b Sapsucker — never fire). The exempt list is returned by
   `/api/coverage` (Option A) so it's defined once.

---

## Build runbook (for the build session — only after the HA hold is lifted)

1. *(Option A, bird repo)* Add `/api/coverage` to `worker/src/index.js`; add the one-line
   `art-manifest.json` emit to `avian/build-site.sh`; deploy Worker + Pages. Verify
   `curl -A "Mozilla/5.0" …/api/coverage` returns the gap JSON.
2. *(HA repo — confirm hold lifted first)* Write `config/packages/barrys_birds.yaml` +
   `config/birds-dashboard.yaml`; add `barrys_birds_base` to `secrets.yaml`; register the dashboard
   in `configuration.yaml`.
3. `cat … | ssh ha-green 'cat > /config/…'` to push each file.
4. `ssh ha-green 'ha core check'` → **`ha core restart`** (new sensors + first-time package need a
   full restart, not a reload).
5. Verify sensors populate (`./scripts/ha.py states barry`), confirm the page renders, test each
   automation (temporarily lower thresholds), then commit with a clear message.
6. HA repo `/learn` → add the index row + Status line; move this doc into the HA repo.

---

## Open questions for Scott

1. **Option A (Worker endpoint) or B (pure HA)?** — recommended **A** (assume A unless told).
2. **Liveness alerting:** let HA own it (and retire/keep UptimeRobot), or leave liveness to
   UptimeRobot and have HA do *only* analytics + gap alerts?
3. **Mic-quiet threshold:** 6 h daytime a good "something's wrong with the ears" line, or
   tighter/looser?
4. **Notification noise:** one summary push per day for gaps, vs. immediate-on-new-species?

---

## Appendix — live coverage snapshot (computed 2026-06-30, read-only)

What the gap cards/alerts would show *today*:

- **Birds with no illustration: 0** ✅ (the Sudbury art push closed it; the alert exists to catch
  the *next* new artless species).
- **Birds detected but no song signature: 13** (excluding the 3 by-design-empty → ~10 addable):
  Hairy Woodpecker *(n=1139, by-design empty)*, Indigo Bunting, Rose-breasted Grosbeak,
  Wood Thrush, White-throated Sparrow, E. Wood-Pewee, Red-breasted Nuthatch, Killdeer,
  Yellow-bellied Sapsucker *(by-design)*, Ruby-throated Hummingbird *(by-design)*, Barn Swallow,
  Eastern Kingbird, Swamp Sparrow.
- **Coverage totals:** 46 species detected · 283 with art · 37 with signatures.
