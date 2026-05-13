import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  RefreshControl,
  TouchableOpacity,
  StatusBar,
  Platform,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';

// ── Config ─────────────────────────────────────────────────────────────────────
const MLB_BASE  = 'https://statsapi.mlb.com/api/v1';
const LIVE_BASE = 'https://statsapi.mlb.com/api/v1.1';
const SCHEDULE_TTL  = 60_000;   // 1 min
const FEED_TTL      = 20_000;   // 20 sec
const SPLITS_TTL    = 300_000;  // 5 min
const AUTO_REFRESH  = 30_000;   // 30 sec

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  Accept: 'application/json',
};

// ── HTTP cache ─────────────────────────────────────────────────────────────────
const _cache = new Map(); // key -> { ts, data }

async function apiFetch(url, params = {}, ttl = 300_000) {
  const qs = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  const key = url + qs;
  const now  = Date.now();
  const hit  = _cache.get(key);
  if (hit && now - hit.ts < ttl) return hit.data;
  try {
    const res = await fetch(key, { headers: FETCH_HEADERS });
    if (res.ok) {
      const data = await res.json();
      _cache.set(key, { ts: now, data });
      return data;
    }
  } catch (_) { /* network error – fall through to stale cache */ }
  return hit ? hit.data : null;
}

// ── MLB API helpers ────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function fetchSchedule(day) {
  const d = await apiFetch(`${MLB_BASE}/schedule`, {
    sportId: 1, date: day, hydrate: 'team,linescore',
  }, SCHEDULE_TTL);
  return (d?.dates ?? []).flatMap(dt => dt.games ?? []);
}

async function fetchFeed(pk) {
  return apiFetch(`${LIVE_BASE}/game/${pk}/feed/live`, {}, FEED_TTL);
}

async function fetchSplits(playerId, season) {
  const d = await apiFetch(`${MLB_BASE}/people/${playerId}/stats`, {
    stats: 'statSplits',
    group: 'hitting',
    sitCodes: 'vr,vl,risp,loaded',
    season,
  }, SPLITS_TTL);
  const out = {};
  for (const grp of d?.stats ?? [])
    for (const sp of grp.splits ?? []) {
      const c = sp.split?.code;
      if (c) out[c] = sp.stat;
    }
  return out;
}

async function fetchVsPitcher(batId, pitId) {
  const d = await apiFetch(`${MLB_BASE}/people/${batId}/stats`, {
    stats: 'vsPlayer',
    group: 'hitting',
    opposingPlayerId: pitId,
  }, SPLITS_TTL);
  for (const grp of d?.stats ?? []) {
    if (grp.splits?.length) return grp.splits[0].stat;
  }
  return null;
}

// ── Formatting ─────────────────────────────────────────────────────────────────
const slash = s =>
  s ? `${s.avg ?? '.---'}/${s.obp ?? '.---'}/${s.slg ?? '.---'}` : '.---/.---/.---';

// ── Sub-components ────────────────────────────────────────────────────────────

/** Rotated-diamond runners-on-base graphic */
function BaseDiamond({ on1, on2, on3 }) {
  const Base = ({ filled, label }) => (
    <View style={styles.baseWrap}>
      <View style={[styles.base, filled && styles.baseOn]} />
      <Text style={styles.baseLabel}>{label}</Text>
    </View>
  );
  return (
    <View style={styles.diamond}>
      <Base filled={on2} label="2B" />
      <View style={styles.diamondMiddle}>
        <Base filled={on3} label="3B" />
        <View style={styles.diamondSpacer} />
        <Base filled={on1} label="1B" />
      </View>
      <View style={styles.baseWrap}>
        <View style={[styles.base, styles.baseHome]} />
        <Text style={styles.baseLabel}>H</Text>
      </View>
    </View>
  );
}

/** One stat row: label + value */
function StatRow({ label, value }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

/** AT BAT or ON DECK batter card */
function BatterCard({
  label, accentColor,
  name, pos, order, batSide,
  ssn, spl, vs,
  pitHand, pitLast, sitCode, sitLbl,
}) {
  const handCode  = pitHand === 'R' ? 'vr' : 'vl';
  const handLabel = pitHand === 'R' ? 'vs RHP' : 'vs LHP';
  const handStats = spl?.[handCode];
  const sitStats  = sitCode ? spl?.[sitCode] : null;

  return (
    <View style={styles.batterCard}>
      {/* Header row */}
      <View style={styles.batterHeader}>
        <Text style={[styles.batterLabel, { color: accentColor }]}>{label}</Text>
        <Text style={styles.batterName} numberOfLines={1}>
          #{order || '?'}  {name}  ({pos || '?'}, {batSide === 'L' ? 'L' : 'R'}HB)
        </Text>
      </View>

      {/* Stats */}
      {ssn && Object.keys(ssn).length > 0 && (
        <StatRow
          label="Season"
          value={`${slash(ssn)}   ${ssn.homeRuns ?? 0} HR  ${ssn.rbi ?? 0} RBI`}
        />
      )}
      {handStats && (
        <StatRow
          label={handLabel}
          value={`${slash(handStats)}   ${handStats.homeRuns ?? 0} HR`}
        />
      )}
      {sitStats && (
        <StatRow label={sitLbl} value={slash(sitStats)} />
      )}
      {vs && (
        <StatRow
          label={`vs ${pitLast}`}
          value={
            `${vs.hits ?? 0}-${vs.atBats ?? 0}` +
            `  (${vs.avg ?? '.---'})` +
            (vs.homeRuns ? `  ${vs.homeRuns} HR` : '')
          }
        />
      )}
    </View>
  );
}

// ── Live game detail ───────────────────────────────────────────────────────────

function LiveGameDetail({ feed }) {
  const gd  = feed?.gameData ?? {};
  const ld  = feed?.liveData  ?? {};
  const ls  = ld.linescore    ?? {};
  const bs  = ld.boxscore     ?? {};
  const cp  = ld.plays?.currentPlay ?? {};
  const mup = cp.matchup      ?? {};
  const cnt = cp.count        ?? {};

  const season  = gd.game?.season ?? todayStr().slice(0, 4);
  const awayAbb = gd.teams?.away?.abbreviation ?? '???';
  const homeAbb = gd.teams?.home?.abbreviation ?? '???';
  const awayR   = ls.teams?.away?.runs ?? 0;
  const homeR   = ls.teams?.home?.runs ?? 0;
  const inning  = ls.currentInning ?? 0;
  const half    = ls.inningHalf ?? '';
  const outs    = Math.min(ls.outs ?? 0, 3);
  const balls   = cnt.balls   ?? 0;
  const strikes = cnt.strikes ?? 0;

  const isTop  = half.toLowerCase().startsWith('top');
  const offT   = isTop ? 'away' : 'home';
  const defT   = isTop ? 'home' : 'away';

  const offense = ls.offense ?? {};
  const on1 = 'first'  in offense;
  const on2 = 'second' in offense;
  const on3 = 'third'  in offense;

  const batInfo = mup.batter   ?? {};
  const pitInfo = mup.pitcher  ?? {};
  const batSide = mup.batSide?.code  ?? 'R';
  const pitHand = mup.pitchHand?.code ?? 'R';
  const pitName = pitInfo.fullName ?? 'Unknown Pitcher';
  const pitLast = pitName.split(' ').slice(-1)[0] ?? 'P';

  const odInfo = offense.onDeck ?? {};
  const odId   = odInfo.id;

  // Situation for split selection
  let sitCode = '', sitLbl = '';
  if (on1 && on2 && on3) { sitCode = 'loaded'; sitLbl = 'Bases Loaded'; }
  else if (on2 || on3)   { sitCode = 'risp';   sitLbl = 'RISP'; }

  // Box-score player lookup
  const plr = (pid, team) =>
    bs.teams?.[team]?.players?.[`ID${pid}`] ?? {};

  const batE = plr(batInfo.id, offT);
  const odE  = plr(odId,       offT);
  const pitE = plr(pitInfo.id, defT);

  const batOrd  = ((batE.battingOrder ?? 0) / 100) | 0;
  const odOrd   = ((odE.battingOrder  ?? 0) / 100) | 0;
  const batSsn  = batE.seasonStats?.batting  ?? {};
  const odSsn   = odE.seasonStats?.batting   ?? {};
  const pitSsn  = pitE.seasonStats?.pitching ?? {};
  const batPos  = batE.position?.abbreviation ?? '';
  const odPos   = odE.position?.abbreviation  ?? '';
  const odSide  = odE.person?.batSide?.code   ?? 'R';

  // Fetch splits + vs-pitcher (cached; useEffect re-runs only if IDs change)
  const [batSpl, setBatSpl] = useState({});
  const [batVs,  setBatVs]  = useState(null);
  const [odSpl,  setOdSpl]  = useState({});
  const [odVs,   setOdVs]   = useState(null);

  useEffect(() => {
    if (!batInfo.id) return;
    fetchSplits(batInfo.id, season).then(setBatSpl);
    if (pitInfo.id) fetchVsPitcher(batInfo.id, pitInfo.id).then(setBatVs);
  }, [batInfo.id, pitInfo.id, season]);

  useEffect(() => {
    if (!odId || !pitInfo.id) return;
    fetchSplits(odId, season).then(setOdSpl);
    fetchVsPitcher(odId, pitInfo.id).then(setOdVs);
  }, [odId, pitInfo.id, season]);

  const symStr   = isTop ? '▲' : '▼';
  const defAbbr  = gd.teams?.[defT]?.abbreviation ?? '???';
  const phLabel  = pitHand === 'R' ? 'RHP' : 'LHP';

  return (
    <View>
      {/* Score + inning */}
      <View style={styles.scoreRow}>
        <Text style={styles.scoreText}>{awayAbb} {awayR}  –  {homeR} {homeAbb}</Text>
        <Text style={styles.inningText}>{symStr}{inning}</Text>
      </View>

      {/* Outs + count */}
      <View style={styles.countsRow}>
        <View style={styles.outsRow}>
          <Text style={styles.dimSmall}>Outs </Text>
          {[0, 1, 2].map(i => (
            <View key={i} style={[styles.outDot, i < outs && styles.outDotFilled]} />
          ))}
        </View>
        <Text style={styles.countText}>Count  {balls}–{strikes}</Text>
      </View>

      {/* Base diamond */}
      <BaseDiamond on1={on1} on2={on2} on3={on3} />

      {/* Pitcher line */}
      <View style={styles.pitcherRow}>
        <Text style={styles.sectionLabel}>Pitcher</Text>
        <Text style={styles.pitcherText} numberOfLines={2}>
          {pitName}  ({phLabel}, {defAbbr})
          {'\n'}ERA {pitSsn.era ?? '-.--'}   {pitSsn.inningsPitched ?? '0.0'} IP
        </Text>
      </View>

      {/* At-bat batter */}
      <BatterCard
        label="AT BAT"     accentColor={C.green}
        name={batInfo.fullName ?? '?'}
        pos={batPos}        order={batOrd}  batSide={batSide}
        ssn={batSsn}        spl={batSpl}    vs={batVs}
        pitHand={pitHand}   pitLast={pitLast}
        sitCode={sitCode}   sitLbl={sitLbl}
      />

      {/* On-deck batter */}
      {odId && odInfo.fullName && (
        <BatterCard
          label="ON DECK"    accentColor={C.yellow}
          name={odInfo.fullName}
          pos={odPos}        order={odOrd}   batSide={odSide}
          ssn={odSsn}        spl={odSpl}     vs={odVs}
          pitHand={pitHand}  pitLast={pitLast}
          sitCode={sitCode}  sitLbl={sitLbl}
        />
      )}
    </View>
  );
}

// ── Game card ──────────────────────────────────────────────────────────────────

function GameCard({ game }) {
  const abstract = game.status?.abstractGameState;
  const detail   = game.status?.detailedState ?? '';
  const away     = game.teams?.away?.team?.abbreviation ?? '???';
  const home     = game.teams?.home?.team?.abbreviation ?? '???';
  const awayR    = game.linescore?.teams?.away?.runs ?? 0;
  const homeR    = game.linescore?.teams?.home?.runs ?? 0;

  const isLive  = abstract === 'Live';
  const isFinal = abstract === 'Final';

  const [feed,     setFeed]     = useState(null);
  const [expanded, setExpanded] = useState(true);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!isLive) return;
    fetchFeed(game.gamePk).then(setFeed);
    intervalRef.current = setInterval(
      () => fetchFeed(game.gamePk).then(setFeed),
      FEED_TTL,
    );
    return () => clearInterval(intervalRef.current);
  }, [game.gamePk, isLive]);

  // Game-time string for scheduled games
  const gameTime = game.gameDate
    ? new Date(game.gameDate).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      })
    : '';

  return (
    <View style={[styles.card, isLive && styles.cardLive]}>
      {/* Card header — tap to collapse/expand live games */}
      <TouchableOpacity
        style={styles.cardHeader}
        onPress={() => isLive && setExpanded(e => !e)}
        activeOpacity={isLive ? 0.7 : 1}
      >
        <Text style={styles.matchupText}>{away} @ {home}</Text>
        <View style={styles.cardHeaderRight}>
          {isLive && (
            <View style={styles.livePill}>
              <Text style={styles.livePillText}>● LIVE</Text>
            </View>
          )}
          {isFinal && <Text style={styles.finalBadge}>Final</Text>}
          {!isLive && !isFinal && (
            <Text style={styles.scheduledTime}>{gameTime}</Text>
          )}
          {isLive && (
            <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
          )}
        </View>
      </TouchableOpacity>

      {/* Compact score for non-live games */}
      {(isFinal || (!isLive && !isFinal)) && (
        <View style={styles.compactScore}>
          <Text style={isFinal ? styles.finalScore : styles.scheduledScore}>
            {away} {awayR}  –  {homeR} {home}
          </Text>
          {!isLive && !isFinal && (
            <Text style={styles.dimSmall}>{detail}</Text>
          )}
        </View>
      )}

      {/* Live game detail */}
      {isLive && expanded && (
        feed
          ? <LiveGameDetail feed={feed} />
          : <ActivityIndicator color={C.blue} style={{ marginTop: 16, marginBottom: 8 }} />
      )}
    </View>
  );
}

// ── Root App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [games,      setGames]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('');
  const [gameDate]                  = useState(todayStr());

  const loadGames = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else           setLoading(true);

    const g = await fetchSchedule(gameDate);
    setGames(g);
    setLastUpdate(
      new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    );
    if (isRefresh) setRefreshing(false);
    else           setLoading(false);
  }, [gameDate]);

  // Initial load
  useEffect(() => { loadGames(); }, [loadGames]);

  // Schedule-level auto-refresh
  useEffect(() => {
    const t = setInterval(() => loadGames(true), AUTO_REFRESH);
    return () => clearInterval(t);
  }, [loadGames]);

  const ListHeader = () => (
    <View style={styles.listHeader}>
      <Text style={styles.listHeaderDate}>{gameDate}</Text>
      {lastUpdate ? (
        <Text style={styles.listHeaderUpdate}>Updated {lastUpdate}</Text>
      ) : null}
    </View>
  );

  const ListEmpty = () => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No games scheduled for {gameDate}.</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="light" backgroundColor={C.headerBg} />

      {/* App header */}
      <View style={styles.appHeader}>
        <Text style={styles.appTitle}>⚾  MLB Tracker</Text>
        <TouchableOpacity onPress={() => loadGames(true)} style={styles.refreshBtn}>
          <Text style={styles.refreshBtnText}>↻</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={C.blue} />
          <Text style={styles.loadingText}>Fetching today's games…</Text>
        </View>
      ) : (
        <FlatList
          data={games}
          keyExtractor={g => String(g.gamePk)}
          renderItem={({ item }) => <GameCard game={item} />}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={ListEmpty}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadGames(true)}
              tintColor={C.blue}
              colors={[C.blue]}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  bg:         '#0d0d1a',
  headerBg:   '#090915',
  card:       '#13132a',
  cardLive:   '#0b1f42',
  border:     '#22224a',
  borderLive: '#1a4a9a',
  text:       '#e0e0f0',
  dim:        '#5a5a80',
  green:      '#00d084',
  yellow:     '#ffd166',
  red:        '#e94560',
  blue:       '#4a9eff',
  white:      '#ffffff',
};

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: C.bg,
  },

  // App header
  appHeader: {
    backgroundColor: C.headerBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  appTitle: {
    color: C.white,
    fontSize: 20,
    fontWeight: '700',
  },
  refreshBtn: {
    padding: 6,
  },
  refreshBtnText: {
    color: C.blue,
    fontSize: 22,
    fontWeight: '400',
  },

  // List layout
  listContent: {
    padding: 12,
    paddingBottom: 32,
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  listHeaderDate: {
    color: C.text,
    fontSize: 14,
    fontWeight: '600',
  },
  listHeaderUpdate: {
    color: C.dim,
    fontSize: 12,
  },

  // States
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: C.dim,
    marginTop: 12,
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    color: C.dim,
    fontSize: 15,
  },

  // Game card
  card: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 12,
  },
  cardLive: {
    backgroundColor: C.cardLive,
    borderColor: C.borderLive,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  matchupText: {
    color: C.white,
    fontSize: 16,
    fontWeight: '700',
  },
  livePill: {
    backgroundColor: '#3a0a12',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginRight: 6,
  },
  livePillText: {
    color: C.red,
    fontSize: 11,
    fontWeight: '700',
  },
  finalBadge: {
    color: C.dim,
    fontSize: 13,
  },
  scheduledTime: {
    color: C.dim,
    fontSize: 13,
  },
  chevron: {
    color: C.dim,
    fontSize: 11,
    marginLeft: 8,
  },

  // Compact (non-live) scores
  compactScore: {
    marginTop: 2,
  },
  finalScore: {
    color: C.blue,
    fontSize: 15,
    fontWeight: '600',
  },
  scheduledScore: {
    color: C.dim,
    fontSize: 14,
  },

  // Score / inning row
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 6,
  },
  scoreText: {
    color: C.blue,
    fontSize: 18,
    fontWeight: '700',
  },
  inningText: {
    color: C.text,
    fontSize: 16,
    fontWeight: '600',
  },

  // Outs + count
  countsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  outsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  outDot: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: C.red,
    marginHorizontal: 3,
  },
  outDotFilled: {
    backgroundColor: C.red,
  },
  countText: {
    color: C.text,
    fontSize: 13,
  },
  dimSmall: {
    color: C.dim,
    fontSize: 12,
  },

  // Base diamond
  diamond: {
    alignItems: 'center',
    marginVertical: 4,
    marginBottom: 12,
  },
  diamondMiddle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  diamondSpacer: {
    width: 32,
  },
  baseWrap: {
    alignItems: 'center',
    marginHorizontal: 4,
  },
  base: {
    width: 18,
    height: 18,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: C.dim,
    transform: [{ rotate: '45deg' }],
    marginBottom: 2,
  },
  baseOn: {
    backgroundColor: C.yellow,
    borderColor: C.yellow,
  },
  baseHome: {
    borderRadius: 9,
  },
  baseLabel: {
    color: C.dim,
    fontSize: 9,
  },

  // Pitcher row
  pitcherRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
    marginTop: 4,
    marginBottom: 6,
  },
  sectionLabel: {
    color: C.text,
    fontSize: 13,
    fontWeight: '700',
    width: 60,
    marginTop: 1,
  },
  pitcherText: {
    color: C.text,
    fontSize: 13,
    flex: 1,
    lineHeight: 19,
  },

  // Batter card
  batterCard: {
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
    marginTop: 6,
  },
  batterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  batterLabel: {
    fontSize: 13,
    fontWeight: '800',
    marginRight: 8,
    letterSpacing: 0.5,
  },
  batterName: {
    color: C.white,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },

  // Stat rows
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: 8,
    marginBottom: 3,
  },
  statLabel: {
    color: C.dim,
    fontSize: 12,
    width: 76,
  },
  statValue: {
    color: C.text,
    fontSize: 12,
    flex: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
