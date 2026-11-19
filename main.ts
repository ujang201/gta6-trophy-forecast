// gta6-trophy-rarity-forecast-01: an original forecaster for GTA VI trophy earn
// rates on Exophase at a case's target.
//
// Model, per trophy: rate = earned / players_tracked. The two counts are
// modelled separately and divided at the target, instead of extrapolating
// the rate itself, because the page's counts only move when Exophase
// refreshes: a refresh that syncs many new players at once dilutes every
// rate (players_tracked jumps faster than earned counts grow), while earns
// push rates back up between refreshes. A rate-only trend cannot tell those
// two forces apart; the decomposition can.
//
//   players_tracked: power-law fit of ln P against ln(1 + hours since
//     launch) over the distinct plateaus the page sat at, blended
//     (geometric mean) with an exponential at the recent daily log-growth
//     rate, damped over the horizon. When the history is frozen (no
//     movement at all, as on launch night) a prior stands in: at least one
//     refresh is assumed before the target, with a jump that decays with
//     time since launch, plus slow continuous growth.
//   earned, per trophy: power-law fit of ln E against ln(1 + hours since
//     launch), E recovered as rate x players_tracked per read. When the
//     history is frozen, earned is assumed to grow slowly, faster for
//     popular trophies (new players earn easy trophies quickly) and slower
//     for rare ones. Earned counts never fall; wild extrapolations are
//     capped at an 8x move from the last rate.
//   spread (logit units), per trophy: fit residual, combined with a
//     refresh-jump allowance (a refresh can move every rate at once, and
//     the allowance is large on launch night and small a week in) and a
//     random-walk term over the horizon. Quantiles are the median on the
//     logit scale shifted by the normal quantiles times the spread.
//
// Everything is a pure function of the case file: no randomness, no clock,
// no network, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Launch, the origin for every time in the model (hours since this). */
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
  notes?: unknown;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Hours since launch for a read's timestamp, never negative. */
const hoursSinceLaunch = (iso: string): number =>
  Math.max(0, (Date.parse(iso) - LAUNCH_MS) / 3_600_000);

/** Least squares y = a + b x; null when x carries no variation. */
function linfit(
  xs: number[],
  ys: number[],
): { a: number; b: number; sd: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    ss += r * r;
  }
  return { a, b, sd: n > 2 ? Math.sqrt(ss / (n - 2)) : 0 };
}

/**
 * Forecast players_tracked at the target. Returns the count and, when the
 * history is frozen, the prior refresh multiplier that was assumed (0 when
 * the history itself carried the growth).
 */
function forecastPlayers(
  c: CaseFile,
  tTargetH: number,
  tCheckH: number,
  horizonDays: number,
): { players: number; priorJump: number } {
  const pts: Array<{ t: number; p: number }> = [];
  for (const r of c.history) {
    const p = r.players_tracked;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
      pts.push({ t: hoursSinceLaunch(r.at), p });
    }
  }
  if (pts.length === 0) return { players: 1, priorJump: 0 };
  const lastP = pts[pts.length - 1].p;
  // The page sits on a plateau between refreshes, so fit the distinct
  // plateaus, not every read (which would overweight the longest plateau).
  const plateaus = pts.filter((pt, i) => i === 0 || pt.p !== pts[i - 1].p);
  const tCheckDays = Math.max(0, tCheckH / 24);
  if (plateaus.length >= 3) {
    const fit = linfit(
      plateaus.map((d) => Math.log1p(d.t)),
      plateaus.map((d) => Math.log(d.p)),
    );
    const pPow = fit ? Math.exp(fit.a + fit.b * Math.log1p(tTargetH)) : lastP;
    // Recent daily log-growth, over the last 24 h of reads.
    const recent = pts.filter((pt) => pt.t >= tCheckH - 24);
    let g = 0;
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const dtDays = Math.max(0.25, (last.t - first.t) / 24);
      g = Math.min(3, Math.max(0, (Math.log(last.p) - Math.log(first.p)) / dtDays));
    }
    const pExp = lastP * Math.exp((g * horizonDays) / (1 + horizonDays / 6));
    const pT = Math.sqrt(Math.max(pPow, 1) * Math.max(pExp, 1));
    return {
      players: Math.min(Math.max(pT, lastP), lastP * Math.exp(3 * horizonDays)),
      priorJump: 0,
    };
  }
  // Frozen history: no refresh has been seen yet, but at least one is
  // coming before the target. Its size decays with time since launch
  // (launch night's first sync was several-fold; a week in, a refresh
  // adds a far smaller share), on top of slow continuous growth.
  const jump = 1.5 * Math.exp(-tCheckDays);
  const gFrozen = 0.5 * Math.exp(-tCheckDays / 2);
  const pT = lastP * (1 + jump) * Math.exp(gFrozen * horizonDays);
  return { players: Math.max(pT, lastP), priorJump: jump };
}

/**
 * Forecast one trophy's earn rate at the target: its median rate and the
 * residual scale of its earned-count fit (0.35 when the history is frozen).
 */
function forecastTrophy(
  c: CaseFile,
  idx: number,
  tTargetH: number,
  horizonDays: number,
  playersTarget: number,
): { median: number; fitSd: number } {
  const pts: Array<{ t: number; e: number }> = [];
  let lastRate: number | null = null;
  let lastE = 0;
  for (const r of c.history) {
    const rate = r.rates[idx];
    if (rate === null || rate === undefined) continue;
    const p = r.players_tracked;
    if (!(p > 0)) continue;
    const t = hoursSinceLaunch(r.at);
    // The page prints rates to 2 decimals; a 0.00% rate still means some
    // players may have earned it, so credit half a quantum, not zero.
    let e = (rate / 100) * p;
    if (e <= 0) e = 0.5 * 0.0001 * p;
    pts.push({ t, e });
    lastRate = rate;
    lastE = e;
  }
  if (pts.length === 0 || lastRate === null) {
    // No read ever listed this trophy: a neutral, very wide forecast.
    return { median: 1.0, fitSd: 0.6 };
  }
  const distinct = pts.filter(
    (pt, i) => i === 0 || pt.e !== pts[i - 1].e || pt.t !== pts[i - 1].t,
  );
  let eT: number | undefined;
  let fitSd = 0.35;
  if (distinct.length >= 3) {
    const fit = linfit(
      distinct.map((d) => Math.log1p(d.t)),
      distinct.map((d) => Math.log(d.e)),
    );
    if (fit) {
      eT = Math.exp(fit.a + fit.b * Math.log1p(tTargetH));
      fitSd = fit.sd;
    }
  }
  if (eT === undefined) {
    // Frozen history: earned grows slowly, faster for popular trophies
    // (new players earn the easy ones quickly) and slower for rare ones.
    const k = 0.15 + 0.6 * Math.sqrt(Math.max(0, lastRate) / 100);
    eT = lastE * (1 + k * horizonDays);
  }
  // Earned counts never fall; cap the move at 8x either way so a noisy
  // fit cannot fling the median across the scale.
  eT = Math.min(Math.max(eT, lastE), lastE * 50 + 1);
  let median = (100 * eT) / playersTarget;
  const move = Math.log(Math.max(median, 0.01) / Math.max(lastRate, 0.01));
  if (Math.abs(move) > Math.log(8)) {
    median = Math.max(lastRate, 0.01) * Math.exp(Math.sign(move) * Math.log(8));
  }
  return { median: clampPct(median), fitSd };
}

/** Forecast one case into its output rows. */
function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const tCheckH = hoursSinceLaunch(c.at);
  const tTargetH = hoursSinceLaunch(c.target);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const tCheckDays = Math.max(0, tCheckH / 24);
  const { players: playersTarget } = forecastPlayers(
    c,
    tTargetH,
    tCheckH,
    horizonDays,
  );
  // Refresh-jump allowance for the spread: a refresh can move every rate
  // at once. Large on launch night, small a week in.
  const jumpSpread = 2.5 * Math.exp(-tCheckDays) + 0.15;
  const sRefresh = Math.log(1 + jumpSpread);
  const sRw = 0.4 * Math.sqrt(horizonDays);
  return c.trophies.map((t, i) => {
    const { median, fitSd } = forecastTrophy(
      c,
      i,
      tTargetH,
      horizonDays,
      playersTarget,
    );
    const sFit = Math.min(1.5, Math.max(0.15, fitSd));
    const s = Math.min(
      2.0,
      Math.max(0.35, Math.sqrt(sFit * sFit + sRefresh * sRefresh + sRw * sRw)),
    );
    const l = logit(median);
    const q: number[] = [];
    for (const z of Z) {
      const v = round4(clampPct(sigmoidPct(l + z * s)));
      // Rounding can only tie, never decrease, but enforce it outright.
      q.push(q.length === 0 ? v : Math.max(v, q[q.length - 1]));
    }
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  if (c.history.length === 0) {
    // No reads at all: still write a valid, very wide forecast.
    const trophies = c.trophies.map((t) => ({
      id: t.id,
      q: Z.map((z) => round4(clampPct(sigmoidPct(logit(1.0) + z * 1.5)))),
    }));
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
    continue;
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
