"""Owl watch — keep the box's "maybe an owl" moments (AvianVisitors addition).

BirdNET only keeps a sound when it is at least CONFIDENCE (0.7) sure AND its
location map says the bird belongs here this week. Owls lose on both counts: a
far-off hoot scores low, and the map (built from birdwatchers' checklists, which
rarely include owls because owling happens at night) calls even Barred and Great
Horned Owls "not expected in Sudbury". Checked on the box 2026-11-25: in 4 days
it dropped 6 Barred Owl calls up to 0.96 and 3 Great Horned Owl calls up to 0.83.

So, for every 30-s recording, this module looks through BirdNET's top guesses
for anything owl-like that was NOT kept, and saves a short clip plus one line
in RECS_DIR/owl_watch.txt (~/BirdSongs/owl_watch.txt):

    date;time;sci;com;conf;clip_path

pi/detection-forwarder.py sends those to the worker (/api/owlwatch), and the
site lists them as "possible owls" to listen to and judge by ear. Nothing here
writes to BirdNET's own database: a possible owl is never counted as a bird.

Owls the box should simply count are listed in ~/BirdNET-Pi/whitelist_species_list.txt
(which skips the location map); this module catches the rest: weaker scores,
and owls BirdNET names as Old World species (it heard our Great Horned Owl as
a "Eurasian Eagle-Owl" in the same minutes).

Settings in /etc/birdnet/birdnet.conf (optional):
    OWLWATCH_MIN=0.3    lowest score kept (0 turns the watch off)
"""
import logging
import os
import subprocess
import time

from .classes import Detection

log = logging.getLogger(__name__)

# Owl genera (Strigidae + Tytonidae) in BirdNET's labels. A common name ending
# in "Owl"/"Owlet" also counts, for anything this list misses.
OWL_GENERA = {
    'Aegolius', 'Asio', 'Athene', 'Bubo', 'Ciccaba', 'Glaucidium', 'Ketupa',
    'Lophostrix', 'Megascops', 'Micrathene', 'Ninox', 'Otus', 'Psiloscops',
    'Pseudoscops', 'Pulsatrix', 'Scotopelia', 'Strix', 'Surnia', 'Tyto',
    'Phodilus', 'Nyctea',
}
DEFAULT_MIN = 0.3
# One clip per species per this many seconds: an owl hooting for ten minutes
# is one moment to listen to, not twenty.
GAP_S = 300
PAD_S = 1.5  # seconds of sound kept either side of the 3-s window

_last_kept = {}  # sci -> unix time of the last clip kept


def is_owl(sci, com):
    genus = sci.split(' ')[0]
    return genus in OWL_GENERA or com.endswith(' Owl') or com.endswith('Owlet') or com == 'Owl'


def min_conf(conf):
    try:
        v = conf.getfloat('OWLWATCH_MIN')
    except Exception:
        v = None
    return DEFAULT_MIN if v is None else v


def candidates(raw_detections, kept, names, threshold):
    """Owl-like guesses worth a listen: the best window per species in this
    recording, at or above ``threshold``, that BirdNET did not keep.

    raw_detections: {"start;end": [(sci_name, score), ...top 10]}
    kept: the Detection list BirdNET kept for this recording
    names: sci -> common name (BirdNET's label language)
    """
    if threshold <= 0:
        return []
    kept_sci = {d.scientific_name for d in kept}
    best = {}
    for slot, entries in raw_detections.items():
        start, end = slot.split(';')
        for sci, score in entries:
            if score < threshold or sci in kept_sci:
                continue
            com = names.get(sci, sci)
            if not is_owl(sci, com):
                continue
            if sci not in best or score > best[sci]['conf']:
                best[sci] = {'sci': sci, 'com': com, 'conf': float(score),
                             'start': float(start), 'end': float(end)}
    return sorted(best.values(), key=lambda c: -c['conf'])


def save(file, conf, now=None):
    """Cut a clip and log a line for each candidate on ``file.owl_watch``.
    Runs in the reporting thread, before the 30-s WAV is deleted. Never raises:
    a problem here must not cost a real detection."""
    cands = getattr(file, 'owl_watch', None) or []
    if not cands:
        return []
    out_txt = os.path.join(conf['RECS_DIR'], 'owl_watch.txt')
    base_dir = os.path.join(conf['RECS_DIR'], 'OwlWatch')
    written = []
    for c in cands:
        try:
            d = Detection(file.file_date, c['start'], c['end'], c['sci'], c['com'], c['conf'])
            at = d.datetime.timestamp()
            last = _last_kept.get(c['sci'])
            if last is not None and abs(at - last) < GAP_S:
                continue
            day_dir = os.path.join(base_dir, d.date)
            os.makedirs(day_dir, exist_ok=True)
            name = f'{d.common_name_safe}-{d.confidence_pct}-{d.date}-owlwatch-{file.RTSP_id}{d.time}.mp3'
            path = os.path.join(day_dir, name)
            if not os.path.isfile(path):
                start = max(0.0, c['start'] - PAD_S)
                stop = c['end'] + PAD_S
                subprocess.run(['sox', '-V1', file.file_name, path, 'trim', f'={start}', f'={stop}'],
                               check=True, capture_output=True, timeout=30)
            with open(out_txt, 'a') as f:
                f.write(f"{d.date};{d.time};{c['sci']};{c['com']};{d.confidence};{path}\n")
            _last_kept[c['sci']] = at
            written.append(path)
            log.info('owl watch: kept %s (%s) %.2f at %s', c['com'], c['sci'], c['conf'], d.time)
        except Exception as e:  # noqa: BLE001 - never break the analysis loop
            log.warning('owl watch: could not save %s: %s', c.get('sci'), e)
    # Forget old entries so the dict can't grow without bound.
    cutoff = (now or time.time()) - 3600
    for k in [k for k, v in _last_kept.items() if v < cutoff]:
        _last_kept.pop(k, None)
    return written
