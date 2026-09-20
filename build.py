#!/usr/bin/env python3
"""Build the Spotify listening-history site from src/.

Two outputs from one source tree:

- The public site (default): index.html, app.js and styles.css at the repo
  root, holding no data. Visitors upload their own export in the browser.
- A personal copy (--embed): one self-contained HTML file with an export
  baked in, for offline use. It contains personal data; keep it local.

Usage:
    python3 build.py                                      # public site
    python3 build.py --embed "private/Spotify Account Data"  # personal copy
    python3 build.py --dry-run                            # report only
    python3 build.py --embed DIR --allow-new-dataset      # skip the baseline check
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / "src"

# Minutes, UTC+7. The zone the payload's day index is built in; the page
# re-indexes to the visitor's own zone (or their Settings choice) on load.
DEFAULT_TZ_OFFSET = 420

# Spotify counts a stream at 30 seconds. The page adopts that definition
# literally: shorter plays are dropped at index time so every view agrees on
# what a play is. src/js/loader.js applies the same rule for uploads.
MIN_PLAY_MS = 30_000


def drop_short(rows: list) -> list:
    """Discard plays Spotify would not count as a stream."""
    return [r for r in rows if r.get("msPlayed", 0) >= MIN_PLAY_MS]


# Measured from the reference export on 2026-09-20, after the 30s rule.
BASELINE = {
    "plays": 20_822,
    "tracks": 4_232,
    "artists": 1_198,
    "podcast_plays": 153,
    "hours": 1244.6,
    "range": ("2025-09-03", "2026-09-04"),
}

JS_MODULES = [
    "data.js", "ui.js", "zip.js", "loader.js", "store.js",
    "timeline.js", "charts.js", "history.js", "library.js", "extras.js",
    "settings.js", "welcome.js", "boot.js",
]


# --------------------------------------------------------------------------
# Pure transforms (unit-tested in test_build.py)
# --------------------------------------------------------------------------


def parse_ts(s: str) -> int:
    """'2026-03-03 07:15' (UTC) -> whole minutes since the Unix epoch."""
    dt = datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() // 60)


class Interner:
    """Maps repeated values to stable small integers, preserving first-seen order."""

    def __init__(self) -> None:
        self._index: dict = {}
        self.values: list = []

    def add(self, key):
        got = self._index.get(key)
        if got is None:
            got = len(self.values)
            self._index[key] = got
            self.values.append(key)
        return got

    def __len__(self) -> int:
        return len(self.values)


def build_album_lookup(playlists: dict, library: dict) -> dict:
    """(artist, track) -> album, merged from playlists and saved tracks.

    Playlists go in first so the library — the authoritative saved-track
    record — overwrites them on conflict.
    """
    out: dict = {}
    for pl in playlists.get("playlists", []):
        for item in pl.get("items", []):
            tr = item.get("track")
            if not tr:
                continue
            album = tr.get("albumName")
            if album:
                out[(tr.get("artistName"), tr.get("trackName"))] = album
    for tr in library.get("tracks", []):
        album = tr.get("album")
        if album:
            out[(tr.get("artist"), tr.get("track"))] = album
    return out


def local_date(ts_min: int, tz_offset_min: int) -> str:
    dt = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(
        minutes=ts_min + tz_offset_min
    )
    return dt.strftime("%Y-%m-%d")


def build_day_index(plays: list, tz_offset_min: int) -> dict:
    """date -> [start, end) index range into a time-sorted plays list.

    A constant UTC offset preserves ordering, so one linear pass suffices:
    open a new range whenever the local date string changes.
    """
    index: dict = {}
    current = None
    start = 0
    for i, play in enumerate(plays):
        day = local_date(play[0], tz_offset_min)
        if day != current:
            if current is not None:
                index[current] = [start, i]
            current = day
            start = i
    if current is not None:
        index[current] = [start, len(plays)]
    return index


def quantile_thresholds(values: list, buckets: int = 5) -> list:
    """Thresholds splitting non-zero values into roughly equal-count buckets."""
    vals = sorted(v for v in values if v > 0)
    if not vals:
        return [0] * (buckets - 1)
    return [vals[min(len(vals) - 1, len(vals) * i // buckets)] for i in range(1, buckets)]


# --------------------------------------------------------------------------
# Export reading
# --------------------------------------------------------------------------


def build_uri_names(library: dict, playlists: dict) -> dict:
    """spotify:… URI -> a human label, assembled from saved items and playlists.

    Wrapped stores only opaque URIs. The rest of the export happens to name many
    of the same entities, so this recovers the labels we can and leaves the rest
    to render as plain links.
    """
    names: dict = {}
    for tr in library.get("tracks", []):
        names[tr.get("uri")] = f"{tr.get('track')} - {tr.get('artist')}"
    for al in library.get("albums", []):
        names[al.get("uri")] = f"{al.get('album')} - {al.get('artist')}"
    for group in ("artists", "shows", "bannedArtists"):
        for it in library.get(group, []):
            names[it.get("uri")] = it.get("name")
    for ep in library.get("episodes", []):
        names[ep.get("uri")] = ep.get("name")
    for pl in playlists.get("playlists", []):
        for item in pl.get("items", []):
            tr = item.get("track") or {}
            if tr.get("trackUri"):
                names.setdefault(
                    tr["trackUri"], f"{tr.get('trackName')} - {tr.get('artistName')}"
                )
    names.pop(None, None)
    return names


def uris_in(node, found=None) -> set:
    """Every spotify: URI anywhere inside a nested structure."""
    if found is None:
        found = set()
    if isinstance(node, str):
        if node.startswith("spotify:"):
            found.add(node)
    elif isinstance(node, dict):
        for v in node.values():
            uris_in(v, found)
    elif isinstance(node, list):
        for v in node:
            uris_in(v, found)
    return found


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def collect_music(export_dir: Path) -> list:
    rows = []
    for path in sorted(export_dir.glob("StreamingHistory_music_*.json")):
        rows.extend(read_json(path, []))
    return rows


def collect_podcast(export_dir: Path) -> list:
    rows = []
    for path in sorted(export_dir.glob("StreamingHistory_podcast_*.json")):
        rows.extend(read_json(path, []))
    return rows


def day_rows(plays: list, tz_offset_min: int) -> list:
    """[[date, start, end, totalMs, playCount], ...] ordered by date."""
    index = build_day_index(plays, tz_offset_min)
    rows = []
    for day in sorted(index):
        start, end = index[day]
        total_ms = sum(p[2] for p in plays[start:end])
        rows.append([day, start, end, total_ms, end - start])
    return rows


def build_extras(export_dir: Path) -> dict:
    identity = read_json(export_dir / "Identity.json", {}) or {}
    attrs = read_json(export_dir / "UserAttributes.json", {}) or {}
    payments = read_json(export_dir / "Payments.json", []) or []
    library = read_json(export_dir / "YourLibrary.json", {}) or {}
    playlists = read_json(export_dir / "Playlist1.json", {}) or {}
    follow = read_json(export_dir / "Follow.json", {}) or {}
    messages = read_json(export_dir / "MessageData.json", {}) or {}
    marquee = read_json(export_dir / "Marquee.json", []) or []
    inferences = read_json(export_dir / "Inferences.json", {}) or {}
    searches = read_json(export_dir / "SearchQueries.json", []) or []
    wrapped = read_json(export_dir / "Wrapped2025.json", {}) or {}

    # Only the URIs Wrapped actually references, so the payload stays small.
    all_names = build_uri_names(library, playlists)
    uri_names = {u: all_names[u] for u in uris_in(wrapped) if u in all_names}

    return {
        "uriNames": uri_names,
        "account": {
            "displayName": identity.get("displayName"),
            "imageUrl": identity.get("largeImageUrl") or identity.get("imageUrl"),
            "username": attrs.get("username"),
            "email": attrs.get("email"),
            "country": attrs.get("country"),
            "birthdate": attrs.get("birthdate"),
            "gender": attrs.get("gender"),
            "creationTime": attrs.get("creationTime"),
            "payment": (payments[0] or {}).get("payment_method") if payments else None,
        },
        "wrapped": wrapped,
        "capsule": read_json(export_dir / "YourSoundCapsule.json", {}),
        "searches": [
            [q.get("searchTime", "").replace("[UTC]", ""), q.get("searchQuery", "")]
            for q in searches
        ],
        "playlists": [
            {
                "name": pl.get("name"),
                "description": pl.get("description"),
                "lastModifiedDate": pl.get("lastModifiedDate"),
                "followers": pl.get("numberOfFollowers", 0),
                "items": [
                    {
                        "added": item.get("addedDate"),
                        "track": (item.get("track") or {}).get("trackName"),
                        "artist": (item.get("track") or {}).get("artistName"),
                        "album": (item.get("track") or {}).get("albumName"),
                        "uri": (item.get("track") or {}).get("trackUri"),
                    }
                    for item in pl.get("items", [])
                    if item.get("track")
                ],
            }
            for pl in playlists.get("playlists", [])
        ],
        "library": {
            key: library.get(key, [])
            for key in (
                "tracks",
                "albums",
                "artists",
                "shows",
                "episodes",
                "bannedArtists",
                "bannedTracks",
            )
        },
        "follows": {
            "following": follow.get("userIsFollowing", []),
            "followers": follow.get("userIsFollowedBy", []),
            "blocking": follow.get("userIsBlocking", []),
        },
        "messages": [
            {
                "members": thread.get("members", []),
                "groupName": thread.get("group_name"),
                "messages": [
                    {
                        "time": m.get("time"),
                        "from": m.get("from"),
                        "message": m.get("message"),
                    }
                    for m in thread.get("messages", [])
                ],
            }
            for thread in messages.values()
        ],
        "marquee": [[m.get("artistName"), m.get("segment")] for m in marquee],
        "inferences": inferences.get("inferences", []),
        "podcastInteractions": {
            "comments": (
                read_json(export_dir / "PodcastInteractivityComments.json", {}) or {}
            ).get("comments", []),
            "reactions": (
                read_json(export_dir / "PodcastInteractivityReactions.json", {}) or {}
            ).get("reactions", []),
        },
    }


EXPORT_FILES = (
    "Follow.json", "Identity.json", "Inferences.json", "Marquee.json",
    "MessageData.json", "Payments.json", "Playlist1.json",
    "PodcastInteractivityComments.json", "PodcastInteractivityReactions.json",
    "SearchQueries.json", "UserAttributes.json", "Wrapped2025.json",
    "YourLibrary.json", "YourSoundCapsule.json",
)


def present_files(export_dir: Path) -> list:
    """Basenames of the export files that actually exist, sorted."""
    found = [n for n in EXPORT_FILES if (export_dir / n).exists()]
    found += [p.name for p in export_dir.glob("StreamingHistory_music_*.json")]
    found += [p.name for p in export_dir.glob("StreamingHistory_podcast_*.json")]
    return sorted(found)


def build_payload(export_dir: Path) -> dict:
    music = drop_short(collect_music(export_dir))
    podcast = drop_short(collect_podcast(export_dir))
    if not music:
        raise SystemExit(f"No StreamingHistory_music_*.json found in {export_dir}")

    playlists = read_json(export_dir / "Playlist1.json", {}) or {}
    library = read_json(export_dir / "YourLibrary.json", {}) or {}
    albums_by_track = build_album_lookup(playlists, library)

    artists = Interner()
    albums = Interner()
    tracks = Interner()
    track_rows: list = []
    plays: list = []

    for row in music:
        artist_idx = artists.add(row["artistName"])
        key = (artist_idx, row["trackName"])
        before = len(tracks)
        track_idx = tracks.add(key)
        if track_idx == before:  # first sighting — record its album, if any
            album = albums_by_track.get((row["artistName"], row["trackName"]))
            track_rows.append(
                [artist_idx, row["trackName"], albums.add(album) if album else None]
            )
        plays.append([parse_ts(row["endTime"]), track_idx, row["msPlayed"]])

    plays.sort(key=lambda p: p[0])

    shows = Interner()
    episodes = Interner()
    episode_rows: list = []
    podcast_plays: list = []
    for row in podcast:
        show_idx = shows.add(row["podcastName"])
        key = (show_idx, row["episodeName"])
        before = len(episodes)
        ep_idx = episodes.add(key)
        if ep_idx == before:
            episode_rows.append([show_idx, row["episodeName"]])
        podcast_plays.append([parse_ts(row["endTime"]), ep_idx, row["msPlayed"]])
    podcast_plays.sort(key=lambda p: p[0])

    days = day_rows(plays, DEFAULT_TZ_OFFSET)
    pdays = day_rows(podcast_plays, DEFAULT_TZ_OFFSET)
    total_ms = sum(p[2] for p in plays)
    with_album = sum(1 for p in plays if track_rows[p[1]][2] is not None)
    album_ms = sum(p[2] for p in plays if track_rows[p[1]][2] is not None)

    return {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "tzDefault": DEFAULT_TZ_OFFSET,
            "present": present_files(export_dir),
            "rangeStart": days[0][0],
            "rangeEnd": days[-1][0],
            "counts": {
                "plays": len(plays),
                "tracks": len(tracks),
                "artists": len(artists),
                "albums": len(albums),
                "ms": total_ms,
                "podcastPlays": len(podcast_plays),
                "shows": len(shows),
                "episodes": len(episodes),
            },
            "albumCoverage": {
                "plays": round(with_album / len(plays), 4),
                "ms": round(album_ms / total_ms, 4) if total_ms else 0,
                "tracks": round(
                    sum(1 for t in track_rows if t[2] is not None) / len(track_rows), 4
                ),
            },
            "heatScale": quantile_thresholds([d[3] for d in days]),
        },
        "artists": artists.values,
        "albums": albums.values,
        "tracks": track_rows,
        "plays": plays,
        "days": days,
        "podcast": {
            "shows": shows.values,
            "episodes": episode_rows,
            "plays": podcast_plays,
            "days": pdays,
        },
        "extras": build_extras(export_dir),
    }


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def check_consistency(payload: dict) -> None:
    """Fail loudly if any emitted index is internally inconsistent."""
    plays = payload["plays"]
    tracks = payload["tracks"]
    n_artists = len(payload["artists"])
    n_albums = len(payload["albums"])

    for i, (ts, track_idx, _) in enumerate(plays):
        if not 0 <= track_idx < len(tracks):
            raise SystemExit(f"play {i}: trackIdx {track_idx} out of range")
        if i and plays[i - 1][0] > ts:
            raise SystemExit(f"play {i}: timestamps not sorted ascending")

    for i, (artist_idx, _, album_idx) in enumerate(tracks):
        if not 0 <= artist_idx < n_artists:
            raise SystemExit(f"track {i}: artistIdx {artist_idx} out of range")
        if album_idx is not None and not 0 <= album_idx < n_albums:
            raise SystemExit(f"track {i}: albumIdx {album_idx} out of range")

    for group, rows in (("music", payload["days"]), ("podcast", payload["podcast"]["days"])):
        total = len(payload["plays"] if group == "music" else payload["podcast"]["plays"])
        if not rows:
            continue
        if rows[0][1] != 0 or rows[-1][2] != total:
            raise SystemExit(f"{group} day ranges do not cover the full list")
        for a, b in zip(rows, rows[1:]):
            if a[2] != b[1]:
                raise SystemExit(f"{group} day ranges are not contiguous at {a[0]}")


def check_baseline(payload: dict, allow_new: bool) -> list:
    counts = payload["meta"]["counts"]
    hours = counts["ms"] / 3_600_000
    checks = [
        ("music plays", counts["plays"], BASELINE["plays"]),
        ("unique tracks", counts["tracks"], BASELINE["tracks"]),
        ("unique artists", counts["artists"], BASELINE["artists"]),
        ("podcast plays", counts["podcastPlays"], BASELINE["podcast_plays"]),
        ("listening hours", round(hours, 1), BASELINE["hours"]),
        ("range start", payload["meta"]["rangeStart"], BASELINE["range"][0]),
        ("range end", payload["meta"]["rangeEnd"], BASELINE["range"][1]),
    ]
    failures = [c for c in checks if c[1] != c[2]]
    if failures and not allow_new:
        print("\nBASELINE MISMATCH — the export does not match the one this was built for:")
        for name, actual, expected in failures:
            print(f"  {name:<16} expected {expected!r}, got {actual!r}")
        raise SystemExit(
            "\nIf this is a new export, re-run with --allow-new-dataset "
            "and update BASELINE in build.py."
        )
    return checks


# --------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------


# frame-ancestors is deliberately absent: browsers ignore it in a <meta> tag
# (it only works as an HTTP header) and log an error for every visitor.
CSP = (
    "default-src 'none'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "connect-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'"
)


def read_shell() -> tuple:
    """(template, css, js) read from src/."""
    template = (SRC_DIR / "index.html").read_text(encoding="utf-8")
    css = (SRC_DIR / "styles.css").read_text(encoding="utf-8")
    js = "\n\n".join(
        f"/* ---- {name} ---- */\n" + (SRC_DIR / "js" / name).read_text(encoding="utf-8")
        for name in JS_MODULES
    )
    return template, css, js


def _fill(template: str, head: str, style: str, script: str) -> str:
    for marker, content in (
        ("<!--INJECT:HEAD-->", head),
        ("<!--INJECT:STYLE-->", style),
        ("<!--INJECT:SCRIPT-->", script),
    ):
        if marker not in template:
            raise SystemExit(f"src/index.html is missing the {marker} marker")
        template = template.replace(marker, content)
    return template


def render_public(css: str, js: str) -> tuple:
    """(html, js, css) for the hosted site. No data, external assets, strict CSP."""
    template, _, _ = read_shell()
    html = _fill(
        template,
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">',
        '<link rel="stylesheet" href="styles.css">',
        '<script src="app.js"></script>',
    )
    return html, js, css


def render_embed(payload: dict, css: str, js: str) -> str:
    """One self-contained file with the data inlined. Local use only, no CSP."""
    template, _, _ = read_shell()
    # '<' cannot appear outside a JSON string, so escaping it is enough to make
    # a stray '</script>' in the data impossible.
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).replace(
        "<", "\\u003c"
    )
    return _fill(
        template,
        "",
        f"<style>{css}</style>",
        f'<script type="application/json" id="payload">{data}</script>'
        f"\n<script>{js}</script>",
    )


PRIVACY_WARNING = """
PRIVACY: this file embeds your email, birthdate, username, DM threads naming
real people, and ad-targeting inferences. It is gitignored. Keep it local - do
not share it, publish it, or commit it.
"""


def report(payload: dict, export_dir: Path, checks: list) -> None:
    counts = payload["meta"]["counts"]
    meta = payload["meta"]
    print(f"Spotify export: {export_dir}")
    print(f"  range          {meta['rangeStart']} -> {meta['rangeEnd']} "
          f"({len(payload['days'])} days with plays)")
    for name, actual, expected in checks:
        mark = "ok " if actual == expected else "NEW"
        print(f"  {mark} {name:<16} {actual}")
    print(f"      unique albums    {counts['albums']} "
          f"(covering {meta['albumCoverage']['ms'] * 100:.1f}% of listening time)")
    print(f"      podcast shows    {counts['shows']} / {counts['episodes']} episodes")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument(
        "--embed",
        type=Path,
        default=None,
        metavar="EXPORT_DIR",
        help="bake this export into a single local file instead of building the site",
    )
    ap.add_argument(
        "--allow-new-dataset",
        action="store_true",
        help="skip the measured-baseline check (use for a different export)",
    )
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    _, css, js = read_shell()

    if args.embed is None:
        html, js_out, css_out = render_public(css, js)
        out = args.out or ROOT
        size = (len(html) + len(js_out) + len(css_out)) / 1024
        if args.dry_run:
            print(f"[dry run] would write index.html, app.js, styles.css ({size:.0f} KB)")
            return
        (out / "index.html").write_text(html, encoding="utf-8")
        (out / "app.js").write_text(js_out, encoding="utf-8")
        (out / "styles.css").write_text(css_out, encoding="utf-8")
        print(f"Wrote index.html, app.js, styles.css to {out} ({size:.0f} KB)")
        print("Public build: contains no personal data.")
        return

    payload = build_payload(args.embed)
    check_consistency(payload)
    checks = check_baseline(payload, args.allow_new_dataset)
    report(payload, args.embed, checks)

    html = render_embed(payload, css, js)
    out = args.out or (ROOT / "private" / "spotify-history.html")
    size_mb = len(html.encode("utf-8")) / 1_048_576
    if args.dry_run:
        print(f"\n[dry run] would write {out} ({size_mb:.2f} MB)")
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
        print(f"\nWrote {out} ({size_mb:.2f} MB)")
    print(PRIVACY_WARNING)


if __name__ == "__main__":
    sys.exit(main())
