"""Unit tests for the pure transforms in build.py."""
import pathlib
import tempfile
import unittest

from build import (
    MIN_PLAY_MS,
    Interner,
    build_album_lookup,
    build_day_index,
    drop_short,
    parse_ts,
    present_files,
    render_embed,
    render_public,
)


class TestParseTs(unittest.TestCase):
    def test_epoch(self):
        self.assertEqual(parse_ts("1970-01-01 00:00"), 0)

    def test_known_instant(self):
        self.assertEqual(parse_ts("2026-03-03 07:15"), 29542035)

    def test_monotonic(self):
        self.assertLess(parse_ts("2025-09-03 14:32"), parse_ts("2026-09-04 16:07"))

    def test_minute_granularity(self):
        self.assertEqual(
            parse_ts("2026-03-03 07:16") - parse_ts("2026-03-03 07:15"), 1
        )


class TestInterner(unittest.TestCase):
    def test_dedupes_and_preserves_order(self):
        i = Interner()
        self.assertEqual(i.add("a"), 0)
        self.assertEqual(i.add("b"), 1)
        self.assertEqual(i.add("a"), 0)
        self.assertEqual(i.values, ["a", "b"])

    def test_tuple_keys(self):
        i = Interner()
        self.assertEqual(i.add((0, "Seroja")), 0)
        self.assertEqual(i.add((1, "Seroja")), 1)
        self.assertEqual(i.add((0, "Seroja")), 0)


class TestAlbumLookup(unittest.TestCase):
    def test_merges_library_and_playlists(self):
        lib = {"tracks": [{"artist": "LE SSERAFIM", "track": "Smart", "album": "EASY"}]}
        pl = {
            "playlists": [
                {
                    "items": [
                        {
                            "track": {
                                "artistName": "Float",
                                "trackName": "Pulang",
                                "albumName": "No-Dream Land",
                            }
                        }
                    ]
                }
            ]
        }
        m = build_album_lookup(pl, lib)
        self.assertEqual(m[("LE SSERAFIM", "Smart")], "EASY")
        self.assertEqual(m[("Float", "Pulang")], "No-Dream Land")

    def test_library_wins_on_conflict(self):
        lib = {"tracks": [{"artist": "A", "track": "T", "album": "FromLibrary"}]}
        pl = {
            "playlists": [
                {
                    "items": [
                        {
                            "track": {
                                "artistName": "A",
                                "trackName": "T",
                                "albumName": "FromPlaylist",
                            }
                        }
                    ]
                }
            ]
        }
        self.assertEqual(build_album_lookup(pl, lib)[("A", "T")], "FromLibrary")

    def test_skips_items_without_album(self):
        pl = {
            "playlists": [
                {
                    "items": [
                        {"track": None},
                        {"track": {"artistName": "A", "trackName": "T", "albumName": ""}},
                    ]
                }
            ]
        }
        self.assertEqual(build_album_lookup(pl, {"tracks": []}), {})


class TestDayIndex(unittest.TestCase):
    def test_groups_by_local_day_with_offset(self):
        # 2026-03-02 16:00 UTC -> 2026-03-02 23:00 at +420
        # 2026-03-02 17:30 UTC -> 2026-03-03 00:30 at +420
        plays = [
            [parse_ts("2026-03-02 16:00"), 0, 1000],
            [parse_ts("2026-03-02 17:30"), 0, 1000],
        ]
        idx = build_day_index(plays, 420)
        self.assertEqual(idx["2026-03-02"], [0, 1])
        self.assertEqual(idx["2026-03-03"], [1, 2])

    def test_utc_offset_zero_differs_from_jakarta(self):
        plays = [[parse_ts("2026-03-02 17:30"), 0, 1000]]
        self.assertIn("2026-03-02", build_day_index(plays, 0))
        self.assertIn("2026-03-03", build_day_index(plays, 420))

    def test_ranges_partition_the_list(self):
        plays = [[parse_ts("2026-03-02 %02d:00" % h), 0, 1000] for h in range(0, 24, 3)]
        idx = build_day_index(plays, 420)
        covered = sorted(idx.values())
        self.assertEqual(covered[0][0], 0)
        self.assertEqual(covered[-1][1], len(plays))
        for a, b in zip(covered, covered[1:]):
            self.assertEqual(a[1], b[0])

    def test_empty(self):
        self.assertEqual(build_day_index([], 420), {})


class TestDropShort(unittest.TestCase):
    def test_threshold_is_spotifys_own(self):
        self.assertEqual(MIN_PLAY_MS, 30_000)

    def test_drops_below_threshold(self):
        rows = [{"msPlayed": 29_999}, {"msPlayed": 30_000}, {"msPlayed": 30_001}]
        self.assertEqual(drop_short(rows), [{"msPlayed": 30_000}, {"msPlayed": 30_001}])

    def test_keeps_exactly_thirty_seconds(self):
        self.assertEqual(drop_short([{"msPlayed": 30_000}]), [{"msPlayed": 30_000}])

    def test_missing_field_is_dropped(self):
        self.assertEqual(drop_short([{"trackName": "x"}]), [])

    def test_empty(self):
        self.assertEqual(drop_short([]), [])


CSP_REQUIRED = ("default-src 'none'", "script-src 'self'", "connect-src 'none'")


class TestRenderPublic(unittest.TestCase):
    def setUp(self):
        self.html, self.js, self.css = render_public("body{color:red}", "var x=1;")

    def test_links_external_assets(self):
        self.assertIn('<link rel="stylesheet" href="styles.css">', self.html)
        self.assertIn('<script src="app.js"></script>', self.html)

    def test_carries_no_payload(self):
        self.assertNotIn('id="payload"', self.html)

    def test_inlines_no_script_or_style(self):
        self.assertNotIn("var x=1;", self.html)
        self.assertNotIn("body{color:red}", self.html)

    def test_returns_the_assets_separately(self):
        self.assertEqual(self.js, "var x=1;")
        self.assertEqual(self.css, "body{color:red}")

    def test_sets_a_strict_csp(self):
        for directive in CSP_REQUIRED:
            self.assertIn(directive, self.html)


class TestRenderEmbed(unittest.TestCase):
    def setUp(self):
        self.payload = {"meta": {"counts": {"plays": 1}}}
        self.html = render_embed(self.payload, "body{color:red}", "var x=1;")

    def test_is_self_contained(self):
        self.assertIn("var x=1;", self.html)
        self.assertIn("body{color:red}", self.html)
        self.assertIn('id="payload"', self.html)
        self.assertNotIn('href="styles.css"', self.html)

    def test_omits_the_csp(self):
        self.assertNotIn("Content-Security-Policy", self.html)

    def test_escapes_angle_brackets_in_data(self):
        html = render_embed({"meta": {"x": "</script><img src=x>"}}, "", "")
        self.assertNotIn("</script><img", html)
        self.assertIn("\\u003c", html)


class TestPresentFiles(unittest.TestCase):
    def test_lists_basenames_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            export = pathlib.Path(tmp)
            for name in ("YourLibrary.json", "StreamingHistory_music_0.json",
                         "Identity.json", "NotAFile.json"):
                (export / name).write_text("[]", encoding="utf-8")
            present = present_files(export)
        self.assertIn("YourLibrary.json", present)
        self.assertIn("StreamingHistory_music_0.json", present)
        self.assertNotIn("NotAFile.json", present)
        self.assertEqual(present, sorted(present))


if __name__ == "__main__":
    unittest.main()
