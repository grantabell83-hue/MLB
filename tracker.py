#!/usr/bin/env python3
"""MLB Live Game Tracker — real-time in-game state with batter matchup details."""

from __future__ import annotations

import argparse
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import requests
from rich.columns import Columns
from rich.console import Console, Group
from rich.live import Live
from rich.markup import escape
from rich.panel import Panel
from rich.text import Text

# ── Constants ─────────────────────────────────────────────────────────────────
MLB_API  = "https://statsapi.mlb.com/api/v1"
LIVE_URL = "https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

console = Console()

# ── Thread-safe HTTP cache ────────────────────────────────────────────────────
_lock: threading.Lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def _get(url: str, params: dict | None = None, ttl: int = 300) -> dict | None:
    key = f"{url}|{sorted((params or {}).items())}"
    now = time.time()
    with _lock:
        if key in _cache and now - _cache[key][0] < ttl:
            return _cache[key][1]
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=10)
        if r.ok:
            d = r.json()
            with _lock:
                _cache[key] = (now, d)
            return d
    except Exception:
        pass
    with _lock:
        return _cache.get(key, (None, None))[1]


# ── MLB Stats API helpers ─────────────────────────────────────────────────────

def get_schedule(day: str) -> list[dict]:
    d = _get(f"{MLB_API}/schedule", {
        "sportId": 1, "date": day, "hydrate": "team",
    }, ttl=60)
    return [g for dt in (d or {}).get("dates", []) for g in dt.get("games", [])]


def get_feed(pk: int) -> dict | None:
    return _get(LIVE_URL.format(pk=pk), ttl=20)


def get_splits(player_id: int, season: str) -> dict[str, dict]:
    """Return split stats keyed by sitCode (vr, vl, risp, loaded)."""
    d = _get(f"{MLB_API}/people/{player_id}/stats", {
        "stats": "statSplits", "group": "hitting",
        "sitCodes": "vr,vl,risp,loaded", "season": season,
    })
    out: dict[str, dict] = {}
    for grp in (d or {}).get("stats", []):
        for sp in grp.get("splits", []):
            c = sp.get("split", {}).get("code", "")
            if c:
                out[c] = sp.get("stat", {})
    return out


def get_vs_pitcher(bat_id: int, pit_id: int) -> dict:
    d = _get(f"{MLB_API}/people/{bat_id}/stats", {
        "stats": "vsPlayer", "group": "hitting",
        "opposingPlayerId": pit_id,
    })
    for grp in (d or {}).get("stats", []):
        sps = grp.get("splits", [])
        if sps:
            return sps[0].get("stat", {})
    return {}


# ── Formatting helpers ────────────────────────────────────────────────────────

def slash_line(s: dict) -> str:
    return f"{s.get('avg', '.---')}/{s.get('obp', '.---')}/{s.get('slg', '.---')}"


def batter_block(
    label: str,
    style: str,
    name: str,
    pos: str,
    order: int,
    bat_side: str,
    ssn: dict,
    spl: dict[str, dict],
    vs: dict,
    pit_hand: str,
    pit_last: str,
    sit_code: str,
    sit_lbl: str,
) -> list[str]:
    n  = f"#{order}" if order else "#?"
    bs = "R" if bat_side == "R" else "L"
    lines = [f"[{style}]{label}:[/{style}]  {n} {escape(name)} ({escape(pos) or '?'}, {bs}HB)"]

    if ssn:
        hr, rbi = ssn.get("homeRuns", 0), ssn.get("rbi", 0)
        lines.append(f"  [dim]Season:[/dim]   {slash_line(ssn)}  {hr} HR  {rbi} RBI")

    hand_code  = "vr" if pit_hand == "R" else "vl"
    hand_label = "vs RHP" if pit_hand == "R" else "vs LHP"
    hs = spl.get(hand_code, {})
    if hs:
        lines.append(f"  [dim]{hand_label}:[/dim]  {slash_line(hs)}  {hs.get('homeRuns', 0)} HR")

    if sit_code and (sc := spl.get(sit_code)):
        lines.append(f"  [dim]{sit_lbl}:[/dim]  {slash_line(sc)}")

    if vs:
        h   = vs.get("hits", 0)
        ab  = vs.get("atBats", 0)
        hr  = vs.get("homeRuns", 0)
        avg = vs.get("avg", ".---")
        hr_s = f"  {hr} HR" if hr else ""
        lines.append(f"  [dim]vs {escape(pit_last)}:[/dim] {h}-{ab} ({avg}){hr_s}")

    return lines


# ── Single-game panel ─────────────────────────────────────────────────────────

def game_panel(game: dict) -> Panel:
    pk   = game["gamePk"]
    away = game["teams"]["away"]["team"]["abbreviation"]
    home = game["teams"]["home"]["team"]["abbreviation"]
    title = f"[bold]{away} @ {home}[/bold]"

    feed = get_feed(pk)
    if not feed:
        return Panel("[dim]Loading…[/dim]", title=title, border_style="dim")

    gd = feed.get("gameData", {})
    ld = feed.get("liveData", {})
    ls = ld.get("linescore", {})
    bs = ld.get("boxscore", {})

    abstract = gd.get("status", {}).get("abstractGameState", "Preview")
    detail   = gd.get("status", {}).get("detailedState", "")
    season   = gd.get("game", {}).get("season", str(date.today().year))

    away_r = ls.get("teams", {}).get("away", {}).get("runs", 0)
    home_r = ls.get("teams", {}).get("home", {}).get("runs", 0)
    inning = ls.get("currentInning", 0)
    half   = ls.get("inningHalf", "")
    outs   = ls.get("outs", 0)

    score = f"[bold cyan]{away} {away_r}  –  {home_r} {home}[/bold cyan]"

    # ── Not live ──────────────────────────────────────────────────────────────
    if abstract != "Live":
        if abstract == "Final":
            return Panel(f"{score}  [dim](Final)[/dim]", title=title, border_style="dim")
        dt  = gd.get("datetime", {})
        t   = f"{dt.get('time', '')} {dt.get('ampm', '')}".strip()
        return Panel(f"{score}\n[dim]{detail}  {t}[/dim]", title=title, border_style="dim")

    # ── Live game ─────────────────────────────────────────────────────────────
    cp  = ld.get("plays", {}).get("currentPlay", {})
    mup = cp.get("matchup", {})
    cnt = cp.get("count", {})

    bat_info = mup.get("batter", {})
    pit_info = mup.get("pitcher", {})
    bat_side = mup.get("batSide", {}).get("code", "R")
    pit_hand = mup.get("pitchHand", {}).get("code", "R")

    bat_id   = bat_info.get("id")
    pit_id   = pit_info.get("id")
    pit_name = pit_info.get("fullName", "Unknown Pitcher")
    pit_last = pit_name.split()[-1] if pit_name else "P"

    balls   = cnt.get("balls", 0)
    strikes = cnt.get("strikes", 0)

    is_top = half.lower().startswith("top")
    off_t  = "away" if is_top else "home"
    def_t  = "home" if is_top else "away"

    offense = ls.get("offense", {})
    on1 = "first"  in offense
    on2 = "second" in offense
    on3 = "third"  in offense

    od_info = offense.get("onDeck", {})
    od_id   = od_info.get("id")
    od_name = od_info.get("fullName", "")

    # Current base situation → pick appropriate split
    if on1 and on2 and on3:
        sit_code, sit_lbl = "loaded", "Bases Loaded"
    elif on2 or on3:
        sit_code, sit_lbl = "risp", "RISP"
    else:
        sit_code, sit_lbl = "", ""

    # Box-score player lookup helper
    def plr(pid: int | None, team: str) -> dict:
        if not pid:
            return {}
        return bs.get("teams", {}).get(team, {}).get("players", {}).get(f"ID{pid}", {})

    bat_e = plr(bat_id, off_t)
    od_e  = plr(od_id,  off_t)
    pit_e = plr(pit_id, def_t)

    bat_ord = (bat_e.get("battingOrder") or 0) // 100
    od_ord  = (od_e.get("battingOrder")  or 0) // 100

    bat_ssn = bat_e.get("seasonStats", {}).get("batting", {})
    od_ssn  = od_e.get("seasonStats", {}).get("batting", {})
    pit_ssn = pit_e.get("seasonStats", {}).get("pitching", {})

    bat_pos = bat_e.get("position", {}).get("abbreviation", "")
    od_pos  = od_e.get("position", {}).get("abbreviation", "")
    od_side = od_e.get("person", {}).get("batSide", {}).get("code", "R")

    # Splits and matchup history (cached after first load)
    bat_spl = get_splits(bat_id, season) if bat_id else {}
    bat_vs  = get_vs_pitcher(bat_id, pit_id) if (bat_id and pit_id) else {}
    od_spl  = get_splits(od_id,  season) if od_id  else {}
    od_vs   = get_vs_pitcher(od_id,  pit_id) if (od_id  and pit_id) else {}

    # ── Visual elements ───────────────────────────────────────────────────────
    outs_c = min(outs, 3)
    outs_s = "[bold red]" + "●" * outs_c + "[/bold red]" + "[dim]" + "○" * (3 - outs_c) + "[/dim]"

    dot = lambda on: "[bold yellow]●[/bold yellow]" if on else "[dim]○[/dim]"
    b1, b2, b3 = dot(on1), dot(on2), dot(on3)

    sym      = "▲" if is_top else "▼"
    era      = pit_ssn.get("era", "-.--")
    ip_str   = pit_ssn.get("inningsPitched", "0.0")
    ph_label = "RHP" if pit_hand == "R" else "LHP"
    def_abbr = gd["teams"][def_t]["abbreviation"]

    rows: list[str] = [
        f"{score}  |  {sym}{inning}  |  Outs: {outs_s}  |  Count: {balls}-{strikes}",
        "",
        f"        {b2}    (2B)",
        f"  (3B) {b3}       {b1} (1B)",
        f"        ○    (Home)",
        "",
        f"[bold]Pitcher:[/bold] {escape(pit_name)} ({ph_label}, {def_abbr})  "
        f"ERA {era}  {ip_str} IP",
        "",
    ]

    rows += batter_block(
        "AT BAT", "bold green",
        bat_info.get("fullName", "?"), bat_pos, bat_ord, bat_side,
        bat_ssn, bat_spl, bat_vs,
        pit_hand, pit_last, sit_code, sit_lbl,
    )
    rows.append("")

    if od_id and od_name:
        rows += batter_block(
            "ON DECK", "bold yellow",
            od_name, od_pos, od_ord, od_side,
            od_ssn, od_spl, od_vs,
            pit_hand, pit_last, sit_code, sit_lbl,
        )

    return Panel("\n".join(rows), title=title, border_style="blue")


# ── Demo mode (no internet required) ─────────────────────────────────────────

def _demo_panel(
    away: str, home: str, away_r: int, home_r: int,
    inning: int, is_top: bool, outs: int, balls: int, strikes: int,
    on1: bool, on2: bool, on3: bool,
    pit_name: str, pit_hand: str, era: str, ip_str: str,
    bat_name: str, bat_pos: str, bat_ord: int, bat_side: str,
    bat_ssn: dict, bat_spl: dict, bat_vs: dict,
    od_name: str, od_pos: str, od_ord: int, od_side: str,
    od_ssn: dict, od_spl: dict, od_vs: dict,
) -> Panel:
    title = f"[bold]{away} @ {home}[/bold]"
    score = f"[bold cyan]{away} {away_r}  –  {home_r} {home}[/bold cyan]"

    if on1 and on2 and on3:
        sit_code, sit_lbl = "loaded", "Bases Loaded"
    elif on2 or on3:
        sit_code, sit_lbl = "risp", "RISP"
    else:
        sit_code, sit_lbl = "", ""

    outs_c = min(outs, 3)
    outs_s = "[bold red]" + "●" * outs_c + "[/bold red]" + "[dim]" + "○" * (3 - outs_c) + "[/dim]"
    dot = lambda on: "[bold yellow]●[/bold yellow]" if on else "[dim]○[/dim]"
    b1, b2, b3 = dot(on1), dot(on2), dot(on3)
    sym      = "▲" if is_top else "▼"
    ph_label = "RHP" if pit_hand == "R" else "LHP"
    pit_last = pit_name.split()[-1]

    rows: list[str] = [
        f"{score}  |  {sym}{inning}  |  Outs: {outs_s}  |  Count: {balls}-{strikes}",
        "",
        f"        {b2}    (2B)",
        f"  (3B) {b3}       {b1} (1B)",
        f"        ○    (Home)",
        "",
        f"[bold]Pitcher:[/bold] {escape(pit_name)} ({ph_label}, {home})  ERA {era}  {ip_str} IP",
        "",
    ]
    rows += batter_block(
        "AT BAT", "bold green",
        bat_name, bat_pos, bat_ord, bat_side,
        bat_ssn, bat_spl, bat_vs,
        pit_hand, pit_last, sit_code, sit_lbl,
    )
    rows.append("")
    rows += batter_block(
        "ON DECK", "bold yellow",
        od_name, od_pos, od_ord, od_side,
        od_ssn, od_spl, od_vs,
        pit_hand, pit_last, sit_code, sit_lbl,
    )
    return Panel("\n".join(rows), title=title, border_style="blue")


def make_demo_display(refresh_secs: int) -> Group:
    now_str = datetime.now().strftime("%I:%M:%S %p")
    header = Text(
        f" ⚾  MLB Game Tracker  ·  DEMO  ·  {now_str}  ·  ↻ {refresh_secs}s ",
        style="bold white on dark_blue",
        justify="center",
    )

    live1 = _demo_panel(
        "NYY", "BOS", 3, 2, 6, False, 1, 2, 1,
        True, False, False,
        "Garrett Whitlock", "R", "3.15", "5.1",
        "Aaron Judge",    "RF", 3, "R",
        {"avg": ".287", "obp": ".394", "slg": ".583", "homeRuns": 14, "rbi": 38},
        {"vr": {"avg": ".301", "obp": ".410", "slg": ".612", "homeRuns": 11},
         "vl": {"avg": ".265", "obp": ".371", "slg": ".540", "homeRuns": 3},
         "risp": {"avg": ".323", "obp": ".430", "slg": ".598"}},
        {"hits": 3, "atBats": 12, "avg": ".250", "homeRuns": 1},
        "Giancarlo Stanton", "DH", 4, "R",
        {"avg": ".254", "obp": ".325", "slg": ".512", "homeRuns": 10, "rbi": 29},
        {"vr": {"avg": ".271", "obp": ".340", "slg": ".529", "homeRuns": 8},
         "vl": {"avg": ".228", "obp": ".295", "slg": ".480", "homeRuns": 2}},
        {"hits": 2, "atBats": 8, "avg": ".250", "homeRuns": 0},
    )

    live2 = _demo_panel(
        "LAD", "SF", 1, 4, 7, True, 2, 3, 2,
        True, True, False,
        "Logan Webb", "R", "2.87", "6.2",
        "Mookie Betts",   "RF", 1, "R",
        {"avg": ".301", "obp": ".382", "slg": ".512", "homeRuns": 9, "rbi": 31},
        {"vr": {"avg": ".312", "obp": ".395", "slg": ".528", "homeRuns": 7},
         "vl": {"avg": ".279", "obp": ".358", "slg": ".481", "homeRuns": 2},
         "risp": {"avg": ".345", "obp": ".420", "slg": ".569"}},
        {"hits": 5, "atBats": 15, "avg": ".333", "homeRuns": 1},
        "Freddie Freeman",  "1B", 2, "L",
        {"avg": ".291", "obp": ".371", "slg": ".489", "homeRuns": 8, "rbi": 35},
        {"vr": {"avg": ".305", "obp": ".385", "slg": ".503", "homeRuns": 7},
         "vl": {"avg": ".262", "obp": ".341", "slg": ".445", "homeRuns": 1},
         "risp": {"avg": ".318", "obp": ".408", "slg": ".512"}},
        {"hits": 8, "atBats": 22, "avg": ".364", "homeRuns": 2},
    )

    # Finished / pre-game panels
    final1  = Panel("[bold cyan]CHC 5  –  3 MIL[/bold cyan]  [dim](Final)[/dim]", title="[bold]CHC @ MIL[/bold]", border_style="dim")
    pre1    = Panel("[bold cyan]ATL 0  –  0 PHI[/bold cyan]\n[dim]Scheduled  7:05 PM[/dim]", title="[bold]ATL @ PHI[/bold]", border_style="dim")
    pre2    = Panel("[bold cyan]HOU 0  –  0 TEX[/bold cyan]\n[dim]Scheduled  8:05 PM[/dim]", title="[bold]HOU @ TEX[/bold]", border_style="dim")
    final2  = Panel("[bold cyan]SEA 2  –  7 OAK[/bold cyan]  [dim](Final)[/dim]", title="[bold]SEA @ OAK[/bold]", border_style="dim")

    panels = [live1, live2, final1, pre1, pre2, final2]
    return Group(header, Columns(panels, equal=False, expand=False))


# ── Full-day display ──────────────────────────────────────────────────────────

def make_display(day: str, refresh_secs: int) -> Group:
    games   = get_schedule(day)
    now_str = datetime.now().strftime("%I:%M:%S %p")
    header  = Text(
        f" ⚾  MLB Game Tracker  ·  {day}  ·  {now_str}  ·  ↻ {refresh_secs}s ",
        style="bold white on dark_blue",
        justify="center",
    )

    if not games:
        return Group(header, Text("\nNo games scheduled.\n", style="dim", justify="center"))

    with ThreadPoolExecutor(max_workers=min(len(games), 12)) as ex:
        panels = list(ex.map(game_panel, games))

    return Group(header, Columns(panels, equal=False, expand=False))


# ── CLI entry point ───────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="MLB Live Game Tracker — shows every game with live matchup details.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Each live game panel shows:
  • Score, inning (▲/▼), outs, and current count
  • Runners-on-base diamond
  • Pitcher: name, handedness, ERA, innings pitched
  • AT BAT / ON DECK: lineup slot, position, batting hand
      – Season slash line (AVG/OBP/SLG), HR, RBI
      – vs RHP or vs LHP splits (whichever is pitching)
      – Situational split: RISP or Bases-Loaded (if applicable)
      – Career stats vs the current pitcher (H-AB, AVG, HR)
        """,
    )
    ap.add_argument(
        "--date",
        default=date.today().isoformat(),
        metavar="YYYY-MM-DD",
        help="Date to track (default: today)",
    )
    ap.add_argument(
        "--refresh",
        type=int,
        default=30,
        metavar="SECS",
        help="Auto-refresh interval in seconds (default: 30)",
    )
    ap.add_argument(
        "--once",
        action="store_true",
        help="Print snapshot once and exit (no live mode)",
    )
    ap.add_argument(
        "--demo",
        action="store_true",
        help="Show a demo display with mock data (no internet required)",
    )
    args = ap.parse_args()

    if args.demo:
        if args.once:
            console.print(make_demo_display(args.refresh))
        else:
            with Live(make_demo_display(args.refresh), console=console, screen=True, refresh_per_second=2) as live:
                while True:
                    time.sleep(args.refresh)
                    live.update(make_demo_display(args.refresh))
        return

    if args.once:
        console.print(make_display(args.date, args.refresh))
        return

    with Live(
        make_display(args.date, args.refresh),
        console=console,
        screen=True,
        refresh_per_second=2,
    ) as live:
        while True:
            time.sleep(args.refresh)
            live.update(make_display(args.date, args.refresh))


if __name__ == "__main__":
    main()
