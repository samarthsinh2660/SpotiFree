import html as htmllib
import json, re

DATA = json.load(open('./tools/candidates.json'))

LABELS = ('t-series','sony music','zee music','saregama','tips','yrf','speed records',
          'vevo','times music','eros now','venus','shemaroo')
# Not the song at all — never acceptable as a match.
DISQUALIFY = ('karaoke','instrumental','reaction','tutorial','ringtone','status',
              'how to','making of','behind the scene','trailer','teaser')
# A real performance of the song, just not the recording we asked for.
VARIANT = ('unplugged','cover','remix','sped up','slowed','reverb','lofi','lo-fi',
           'mashup','medley','live','8d','dance','choreography','revisited','recreated')

norm = lambda s: re.sub(r'[^a-z0-9 ]', ' ', htmllib.unescape(s or '').lower())
toks = lambda s: [t for t in norm(s).split() if len(t) > 1]

def split_title(title):
    """Separate the song name from parenthetical context like (From "Some Film")."""
    core = re.sub(r'[\(\[].*?[\)\]]', ' ', title)
    extra = ' '.join(re.findall(r'[\(\[](.*?)[\)\]]', title))
    extra = re.sub(r'(?i)\bfrom\b', ' ', extra)
    return core, extra

def score(c, track):
    core, extra = split_title(track['title'])
    ctitle = norm(c['title'])
    cchan = (c['channel'] or '').lower()
    s = 0.0

    core_toks = toks(core)
    if core_toks:
        hit = sum(1 for t in core_toks if t in ctitle) / len(core_toks)
        s += 120 * hit
        if hit < 0.5:
            s -= 120                      # probably a different song entirely

    if extra and any(t in ctitle for t in toks(extra)):
        s += 25                           # film/album name corroborates

    artist_toks = [t for t in toks(track['artists']) if len(t) > 3]
    if any(t in ctitle or t in cchan for t in artist_toks):
        s += 20

    if cchan.endswith('- topic'):
        s += 55
    elif any(l in cchan for l in LABELS):
        s += 45
    if 'official' in ctitle:
        s += 15

    want = round(track['durationMs'] / 1000)
    if c['seconds'] and want:
        d = abs(c['seconds'] - want)
        s += 50 if d <= 3 else 25 if d <= 10 else 0
        if d > 45:
            s -= 70

    asked = norm(track['title'] + ' ' + track['artists'])
    s -= 200 * sum(1 for b in DISQUALIFY if b in ctitle and b not in asked)
    s -= 40 * sum(1 for b in VARIANT if b in ctitle and b not in asked)
    return s

for entry in DATA:
    t = entry['track']
    want = round(t['durationMs'] / 1000)
    print(f"\n=== {t['title']}  [{t['artists'][:52]}]  want {want}s")
    for vname, v in entry['variants'].items():
        ranked = sorted(v['candidates'], key=lambda c: -score(c, t))
        top = ranked[0]
        print(f"  {vname:13} -> {top['channel'][:24]:26} | {top['title'][:52]:54} | {top['seconds']}s  ({score(top,t):.0f})")
