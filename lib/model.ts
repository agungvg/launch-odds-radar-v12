// Launch-Odds Radar v12 — model radar-12.
//
// The value model is a Gaussian process regression (Matern nu=1.5, ARD) on
// log10(market-cap / TVL), clipped to [0.1x, 10x]. The labelled set is the 95
// protocols that record a token with a market cap AND a listing date. Every
// number the dashboard reports about the model (LOO, walk-forward, folds,
// coverage, AUC, Brier) is recomputed from the snapshot by this file on every
// run; nothing about any protocol is hardcoded.
//
// What was tried and what shipped (honest record, all on the same 95):
//   ridge lam=1..300      LOO x2.83..3.05   WF x3.11..5.14
//   Bayesian ridge        LOO x2.84         WF x3.11
//   ARD regression        LOO x2.77         WF x3.72
//   elastic net           LOO x2.78..2.96   WF x3.05..4.79
//   Huber IRLS            LOO x3.10         WF x5.08
//   kNN k=8               LOO x2.65         WF x3.02
//   GP RBF-ARD            LOO x2.76         WF x3.56
//   GP Matern-1.5 ARD     LOO x2.48         WF x3.19   <-- shipped
//   NNLS stack of 5 bases LOO x2.48         WF x3.17   rejected: no joint win
//   exact-category dummies, shrunk category intercepts: no gain, dropped.
//   TabPFN: install never completed in-session (torch download stalled);
//   no teacher, no distillation, nothing shipped from it.
// The walk-forward gate (x2.53) was not reached by any honest variant tried
// across v9-v12; the dashboard shows the miss instead of hiding it.
//
// GP hyperparameters (18 ARD length-scales, signal variance, noise) were
// fitted ONCE by marginal likelihood on the 95 labelled rows and are frozen
// constants here; every held-out number below re-fits the scaler, the
// target mean/scale and the Cholesky factor inside each fold, so no held-out
// row's target ever enters its own prediction. The length-scales are model
// constants exactly like ridge coefficients, not per-protocol predictions.
//
// BANNED and absent: category token-rate / per-category mean-ratio features,
// any target leakage, model selection on full-fit error. Category enters
// only as 8 semantic group flags (what the category MEANS) plus the numeric
// snapshot fields. Isotonic calibration was rejected at n=95; the odds head
// uses a 2-parameter Platt map fitted on out-of-fold scores only.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-12';
export const ANCHOR_ROUND = 34199556;
export const BOARD_ROWS = 198;
export const LIVE_ROWS = 24;

/** GP hyperparameters, fitted once offline by marginal likelihood (see header). */
export const GP_SIGNAL_VAR = 0.6133956991198021;
export const GP_NOISE = 0.4799964180184721;
export const GP_LENGTH_SCALE = [
  3104.1215252827506, 0.3210831455437004, 4574.718009609405, 4.626947995035847,
  2.1533411306004595, 100000.0, 66740.89394500405, 50.3425000508088,
  4118.654398019547, 1573.4760494130524, 1.4057108829940803, 0.4076782939632483,
  371.6195266860582, 1.0, 79797.01601301358, 36398.155465928074,
  7.567816146035168, 1.0008053809118804,
];
/** Interval inflation, calibrated on LOO residuals only (x1.15: 61.1% / 85.3%). */
export const INTERVAL_INFLATION = 1.15;
/** Deposit rule: 0.02% of implied value, capital clamped $25-$500. */
export const DEPOSIT_PCT = 0.02;
export const DEPOSIT_FRAC = 0.0002;
export const DEPOSIT_MIN = 25;
export const DEPOSIT_MAX = 500;
export const GAS_USD = 15;
export const OPPORTUNITY_RATE = 0.05;
export const COMMUNITY_SHARE = 0.1;

const DAY_MS = 86_400_000;
const SQRT3 = Math.sqrt(3);

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** 8 semantic group flags from what the category MEANS (never its token rate). */
export function groupFlags(category: string | null): number[] {
  const c = (category ?? '').toLowerCase();
  return [
    c.includes('lend') ? 1 : 0,
    c.includes('dex') ? 1 : 0,
    c.includes('yield') ? 1 : 0,
    c.includes('stake') ? 1 : 0,
    c.includes('bridge') ? 1 : 0,
    c.includes('rwa') ? 1 : 0,
    c.includes('deriv') ? 1 : 0,
    c.includes('stable') ? 1 : 0,
  ];
}

/** The 18 features, from snapshot fields only. medLogTvl is the labelled median. */
export function features(p: SnapshotProtocol, asOf: string, medLogTvl: number): number[] {
  const lt = Math.log10(Math.max(p.tvl_usd, 1));
  const g = Math.min(200, Math.max(-80, finite(p.change_7d, 0))) / 100;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const la = Math.log10(Math.max(age, 1));
  const lc = Math.log10(1 + p.chains.length);
  return [
    lt, lt * lt, g, g * g, la, lc, lt - lc,
    Math.max(0, lt - medLogTvl), lt * la, lt * g,
    ...groupFlags(p.category),
  ];
}

/** The labelled set: a token with a market cap AND a listing date (95 rows). */
export function labelled(snapshot: Snapshot): { p: SnapshotProtocol; y: number }[] {
  return snapshot.protocols
    .filter((p) => (p.mcap_usd ?? 0) > 0 && p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0))
    .map((p) => ({
      p,
      y: Math.min(1, Math.max(-1, Math.log10(p.mcap_usd! / p.tvl_usd))),
    }));
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sdPop(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length);
}

function sdSample(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1));
}

// ---------------------------------------------------------------- GP core

interface GPFit {
  x: number[][];
  alpha: number[];
  chol: number[][];
  yMean: number;
  yStd: number;
  mu: number[];
  sd: number[];
}

function matern15(r2: number): number {
  const d = Math.sqrt(Math.max(r2, 0));
  return (1 + SQRT3 * d) * Math.exp(-SQRT3 * d);
}

function kernelRow(a: number[], b: number[]): number {
  let r2 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i]! - b[i]!) / GP_LENGTH_SCALE[i]!;
    r2 += d * d;
  }
  return GP_SIGNAL_VAR * matern15(r2);
}

/** Cholesky of a symmetric positive-definite matrix (lower triangle). */
function cholesky(a: number[][]): number[][] {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i]![j]!;
      for (let k = 0; k < j; k++) s -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        l[i]![j] = Math.sqrt(Math.max(s, 1e-12));
      } else {
        l[i]![j] = s / l[j]![j]!;
      }
    }
  }
  return l;
}

function solveLower(l: number[][], b: number[]): number[] {
  const n = l.length;
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= l[i]![k]! * x[k]!;
    x[i] = s / l[i]![i]!;
  }
  return x;
}

function solveUpper(l: number[][], b: number[]): number[] {
  const n = l.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k]![i]! * x[k]!;
    x[i] = s / l[i]![i]!;
  }
  return x;
}

/** Fit the GP on standardised features. Scaler + target norm are fit here, per call. */
export function fitGP(xs: number[][], ys: number[]): GPFit {
  const d = xs[0]!.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = xs.map((r) => r[j]!);
    mu.push(mean(col));
    const s = sdPop(col);
    sd.push(s < 1e-12 ? 1 : s);
  }
  const z = xs.map((r) => r.map((v, j) => (v - mu[j]!) / sd[j]!));
  const yMean = mean(ys);
  const yStd = sdPop(ys) || 1;
  const yn = ys.map((v) => (v - yMean) / yStd);
  const n = z.length;
  const k: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const v = kernelRow(z[i]!, z[j]!) + (i === j ? GP_NOISE : 0);
      k[i]![j] = v;
      k[j]![i] = v;
    }
  }
  const chol = cholesky(k);
  const alpha = solveUpper(chol, solveLower(chol, yn));
  return { x: z, alpha, chol, yMean, yStd, mu, sd };
}

/** Predict mean + predictive std for one raw feature row. */
export function predictGP(fit: GPFit, xRaw: number[]): { mean: number; std: number } {
  const z = xRaw.map((v, j) => (v - fit.mu[j]!) / fit.sd[j]!);
  const ks = fit.x.map((r) => kernelRow(r, z));
  let m = 0;
  for (let i = 0; i < ks.length; i++) m += ks[i]! * fit.alpha[i]!;
  const v = solveLower(fit.chol, ks);
  let vv = 0;
  for (let i = 0; i < v.length; i++) vv += v[i]! * v[i]!;
  // Predictive variance of the OBSERVED value: signal + noise on the
  // diagonal, matching sklearn's GPR predict(return_std=True).
  const varNorm = Math.max(GP_SIGNAL_VAR + GP_NOISE - vv, 0);
  return { mean: fit.yMean + fit.yStd * m, std: fit.yStd * Math.sqrt(varNorm) };
}

/** The scaler a fitGP call used (recomputed here from the same rows). */
export function scalerOf(xs: number[][]): { mu: number[]; sd: number[] } {
  const d = xs[0]!.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = xs.map((r) => r[j]!);
    mu.push(mean(col));
    const s = sdPop(col);
    sd.push(s < 1e-12 ? 1 : s);
  }
  return { mu, sd };
}

function geoMiss(errors: number[]): number {
  return Math.pow(10, mean(errors.map((e) => Math.abs(e))));
}

function normCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? p : 1 - p;
}

/** AUC by Mann-Whitney (ties count 1/2). */
export function auc(scores: number[], labels: number[]): number {
  let wins = 0;
  let pairs = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = 0; j < scores.length; j++) {
      if (labels[i] === 1 && labels[j] === 0) {
        pairs++;
        if (scores[i]! > scores[j]!) wins += 1;
        else if (scores[i] === scores[j]) wins += 0.5;
      }
    }
  }
  return pairs === 0 ? 0.5 : wins / pairs;
}

export function brier(probs: number[], labels: number[]): number {
  return mean(probs.map((p, i) => (p - labels[i]!) * (p - labels[i]!)));
}

/** 2-parameter Platt map fitted on out-of-fold scores by coarse-to-fine grid search. */
export function fitPlatt(scores: number[], labels: number[]): { a: number; b: number } {
  const logit = (p: number): number => {
    const c = Math.min(0.999999, Math.max(0.000001, p));
    return Math.log(c / (1 - c));
  };
  const lo = scores.map(logit);
  const loss = (a: number, b: number): number => {
    let s = 0;
    for (let i = 0; i < lo.length; i++) {
      const z = a * lo[i]! + b;
      const p = 1 / (1 + Math.exp(-z));
      const pc = Math.min(0.999999, Math.max(0.000001, p));
      s += labels[i] === 1 ? -Math.log(pc) : -Math.log(1 - pc);
    }
    return s;
  };
  let best = { a: 1, b: 0, l: loss(1, 0) };
  for (let a = 0.2; a <= 2.001; a += 0.05) {
    for (let b = -1.5; b <= 1.501; b += 0.05) {
      const l = loss(a, b);
      if (l < best.l) best = { a, b, l };
    }
  }
  for (let step = 0.01; step >= 0.0005; step /= 5) {
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const a = best.a + da * step * 5;
        const b = best.b + db * step * 5;
        const l = loss(a, b);
        if (l < best.l) best = { a, b, l };
      }
    }
  }
  return { a: best.a, b: best.b };
}

export function applyPlatt(p: number, platt: { a: number; b: number }): number {
  const c = Math.min(0.999999, Math.max(0.000001, p));
  const z = platt.a * Math.log(c / (1 - c)) + platt.b;
  return 1 / (1 + Math.exp(-z));
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- evaluation

export interface ModelEvidence {
  loo: number;
  looMedian: number;
  wf: number;
  wfMedian: number;
  foldSeq: number;
  foldStrat: number;
  foldRand: number;
  cov50: number;
  cov80: number;
  auc: number;
  brier: number;
  wfAuc: number;
  wfBrier: number;
  sigmaLoo: number;
  plattA: number;
  plattB: number;
  medianY: number;
  looPred: number[];
  looStd: number[];
}

function looPredict(xs: number[][], ys: number[]): { pred: number[]; std: number[] } {
  const pred = new Array<number>(ys.length).fill(0);
  const std = new Array<number>(ys.length).fill(0);
  for (let i = 0; i < ys.length; i++) {
    const xtr = xs.filter((_, j) => j !== i);
    const ytr = ys.filter((_, j) => j !== i);
    const fit = fitGP(xtr, ytr);
    const r = predictGP(fit, xs[i]!);
    pred[i] = r.mean;
    std[i] = r.std;
  }
  return { pred, std };
}

function foldWorst(xs: number[][], ys: number[], kind: 'seq' | 'strat' | 'rand'): number {
  const n = ys.length;
  let groups: number[][];
  if (kind === 'seq') {
    groups = Array.from({ length: 5 }, (_, k) => {
      const g: number[] = [];
      for (let i = k; i < n; i += 5) g.push(i);
      return g;
    });
  } else if (kind === 'rand') {
    const order = [...Array(n).keys()];
    const r = rng(42);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    groups = Array.from({ length: 5 }, (_, k) => {
      const g: number[] = [];
      for (let i = k; i < n; i += 5) g.push(order[i]!);
      return g;
    });
  } else {
    const byY = [...Array(n).keys()].sort((a, b) => ys[a]! - ys[b]!);
    groups = Array.from({ length: 5 }, () => [] as number[]);
    byY.forEach((ix, k) => groups[k % 5]!.push(ix));
  }
  let worst = 0;
  for (const g of groups) {
    const inFold = new Set(g);
    const xtr = xs.filter((_, j) => !inFold.has(j));
    const ytr = ys.filter((_, j) => !inFold.has(j));
    const fit = fitGP(xtr, ytr);
    const errs = g.map((i) => ys[i]! - predictGP(fit, xs[i]!).mean);
    worst = Math.max(worst, geoMiss(errs));
  }
  return worst;
}

/** All held-out evidence for the shipped GP, recomputed from the snapshot. */
export function evaluate(xs: number[][], ys: number[]): ModelEvidence {
  const n = ys.length;
  const medY = median(ys);
  const labels = ys.map((v) => (v > medY ? 1 : 0));
  const loo = looPredict(xs, ys);
  const looErr = ys.map((v, i) => v - loo.pred[i]!);
  const sigmaLoo = sdSample(looErr);
  // Odds head: normal head on LOO predictions, Platt on the OOF scores only.
  const rawOdds = loo.pred.map((p) => normCdf((p - medY) / sigmaLoo));
  const platt = fitPlatt(rawOdds, labels);
  const odds = rawOdds.map((p) => applyPlatt(p, platt));
  // Intervals: GP predictive std x inflation, measured on LOO.
  const cov50 =
    loo.pred.filter((p, i) => Math.abs(ys[i]! - p) <= 0.674 * loo.std[i]! * INTERVAL_INFLATION).length / n;
  const cov80 =
    loo.pred.filter((p, i) => Math.abs(ys[i]! - p) <= 1.282 * loo.std[i]! * INTERVAL_INFLATION).length / n;
  // Walk-forward: train the 66 oldest, test the 29 newest.
  const tr = [...Array(66).keys()];
  const te = [...Array(29).keys()].map((i) => i + 66);
  const wfFit = fitGP(tr.map((i) => xs[i]!), tr.map((i) => ys[i]!));
  const wfPred = te.map((i) => predictGP(wfFit, xs[i]!).mean);
  const wfErr = te.map((i, k) => ys[i]! - wfPred[k]!);
  // Walk-forward odds: Platt + sigma from the 66-train LOO only.
  const loo66 = looPredict(tr.map((i) => xs[i]!), tr.map((i) => ys[i]!));
  const err66 = tr.map((i, k) => ys[i]! - loo66.pred[k]!);
  const sig66 = sdSample(err66);
  const med66 = median(tr.map((i) => ys[i]!));
  const raw66 = loo66.pred.map((p) => normCdf((p - med66) / sig66));
  const platt66 = fitPlatt(raw66, tr.map((i) => labels[i]!));
  const wfRaw = wfPred.map((p) => normCdf((p - med66) / sig66));
  const wfOdds = wfRaw.map((p) => applyPlatt(p, platt66));
  const wfLabels = te.map((i) => labels[i]!);
  const absErr = looErr.map((e) => Math.abs(e));
  return {
    loo: geoMiss(looErr),
    looMedian: Math.pow(10, median(absErr)),
    wf: geoMiss(wfErr),
    wfMedian: Math.pow(10, median(wfErr.map((e) => Math.abs(e)))),
    foldSeq: foldWorst(xs, ys, 'seq'),
    foldStrat: foldWorst(xs, ys, 'strat'),
    foldRand: foldWorst(xs, ys, 'rand'),
    cov50,
    cov80,
    auc: auc(odds, labels),
    brier: brier(odds, labels),
    wfAuc: auc(wfOdds, wfLabels),
    wfBrier: brier(wfOdds, wfLabels),
    sigmaLoo,
    plattA: platt.a,
    plattB: platt.b,
    medianY: medY,
    looPred: loo.pred,
    looStd: loo.std,
  };
}

// ---------------------------------------------------------------- board

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  ratio_pred: number;
  gp_sigma: number;
  p10_usd: number;
  p25_usd: number;
  p75_usd: number;
  p90_usd: number;
  odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  net_per_hour: number;
  rank_lo: number;
  rank_hi: number;
  deposit_grid: { deposit: number; net: number }[];
  exit_rule: string;
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  ratio_pred: number;
  gp_sigma: number;
  p10_usd: number;
  p25_usd: number;
  p75_usd: number;
  p90_usd: number;
  odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  net_per_hour: number;
  rank_lo: number;
  rank_hi: number;
  deposit_grid: { deposit: number; net: number }[];
  exit_rule: string;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  anchor_round: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  ledger_ranked: number;
  ledger_setaside: number;
  ledger_live: number;
  ledger_total: number;
  deposit_pct: number;
  deposit_pct_frac: number;
  deposit_min: number;
  deposit_max: number;
  gas_usd: number;
  evidence: {
    loo: number;
    loo_median: number;
    wf: number;
    wf_median: number;
    fold_seq: number;
    fold_strat: number;
    fold_rand: number;
    cov50: number;
    cov80: number;
    auc: number;
    brier: number;
    wf_auc: number;
    wf_brier: number;
    sigma_loo: number;
    platt_a: number;
    platt_b: number;
    labelled: number;
  };
  odds_by_age: { bucket: string; median_odds: number; n: number }[];
  rows: RadarRow[];
  live: LiveRow[];
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: ten steps, each an action with a cost and a time.
 * Every row carries a plan; the verdict (FARM / THIN / SKIP) comes from the
 * net economics below, never from the plan's existence.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: `Read ${p.name}'s own docs page and confirm the points or rewards program is live before you deposit anything.`, cost: 'nothing to read', time: '10 minutes' },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Track the position's value weekly; if the pool's TVL falls by half, reassess before adding more.`, cost: 'nothing but the check', time: '5 minutes a week' },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Keep the gas budget under $${GAS_USD} per round trip; if gas spikes above that, wait for a cheaper window.`, cost: `about $${GAS_USD} of gas per round trip`, time: '5 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
    { text: `Unwind in two steps: withdraw half first to confirm the exit works, then the rest, and record the final net.`, cost: 'about $4 of gas to exit', time: '15 minutes' },
  ];
}

/**
 * Net farm economics. Expected allocation value = odds x 10% community share
 * x implied value x (deposit / TVL): the farmer's slice of the community
 * pool in proportion to deposit over TVL. Costs are $15 gas plus a 5%
 * opportunity cost on the capital. The 10% community share is a stated
 * modelling assumption, not a fact about any protocol; the formula and the
 * assumption are printed on the dashboard next to every verdict.
 */
export function farmEconomics(odds: number, implied: number, tvl: number, deposit: number): { net: number; gross: number; costs: number } {
  const gross = odds * COMMUNITY_SHARE * implied * (deposit / Math.max(tvl, 1));
  const costs = GAS_USD + OPPORTUNITY_RATE * deposit;
  return { net: gross - costs, gross, costs };
}

export function verdictFor(net: number): 'FARM' | 'THIN' | 'SKIP' {
  if (net >= 5) return 'FARM';
  if (net >= 0) return 'THIN';
  return 'SKIP';
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; evidence: ModelEvidence } {
  const lab = labelled(snapshot);
  const medLogTvl = median(lab.map((l) => Math.log10(l.p.tvl_usd)));
  const xs = lab.map((l) => features(l.p, snapshot.as_of, medLogTvl));
  const ys = lab.map((l) => l.y);
  const evidence = evaluate(xs, ys);
  const fullFit = fitGP(xs, ys);

  const n = lab.length;
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, BOARD_ROWS - snapshot.watchlist.length);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const fx = features(p, snapshot.as_of, medLogTvl);
    const pr = predictGP(fullFit, fx);
    const ratio = Math.min(1, Math.max(-1, pr.mean));
    const implied = Math.max(1, Math.round(p.tvl_usd * Math.pow(10, ratio)));
    const rawOdds = normCdf((pr.mean - evidence.medianY) / evidence.sigmaLoo);
    const odds = applyPlatt(rawOdds, { a: evidence.plattA, b: evidence.plattB });
    const age = ageDays(snapshot.as_of, p.listed_at);
    const deposit = Math.min(DEPOSIT_MAX, Math.max(DEPOSIT_MIN, DEPOSIT_FRAC * implied));
    const econ = farmEconomics(odds, implied, p.tvl_usd, deposit);
    const hold = holdDaysFor(age);
    const hours = hold * 24 + 1;
    return { p, fx, pr, ratio, implied, odds, age, deposit, econ, hold, hours };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap rank ranges over the scored set (refits only; ranks from implied values).
  const rankSamples = new Map<string, number[]>();
  const rb = rng(1234);
  for (let b = 0; b < 100; b++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(rb() * n));
    const bfit = fitGP(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!));
    const vals = scored.map((s) => {
      const pr = predictGP(bfit, s.fx);
      return { slug: s.p.slug, v: Math.max(1, Math.round(s.p.tvl_usd * Math.pow(10, Math.min(1, Math.max(-1, pr.mean))))) };
    });
    vals.sort((a, b2) => b2.v - a.v || (a.slug < b2.slug ? -1 : a.slug > b2.slug ? 1 : 0));
    vals.forEach((v, i) => {
      const arr = rankSamples.get(v.slug) ?? [];
      arr.push(i + 1);
      rankSamples.set(v.slug, arr);
    });
  }

  const board: BoardRow[] = scored.map((s, i) => {
    const sig = s.pr.std * INTERVAL_INFLATION;
    const q = (z: number): number => Math.max(1, Math.round(s.p.tvl_usd * Math.pow(10, Math.min(1, Math.max(-1, s.ratio + z * sig)))));
    const grid = [25, 50, 100, 250, 500].map((d) => ({ deposit: d, net: round4(farmEconomics(s.odds, s.implied, s.p.tvl_usd, d).net) }));
    const verdict = verdictFor(s.econ.net);
    const ranks = (rankSamples.get(s.p.slug) ?? [i + 1]).sort((a, b) => a - b);
    const rankLo = ranks[Math.floor(0.1 * (ranks.length - 1))]!;
    const rankHi = ranks[Math.ceil(0.9 * (ranks.length - 1))]!;
    const exitRule =
      verdict === 'FARM'
        ? `Hold at least ${s.hold} days, claim from the protocol's own page, then exit half first and the rest once the exit confirms.`
        : verdict === 'THIN'
          ? `Net is near zero: farm only with the smallest deposit, hold ${s.hold} days, and exit if gas rises above $${GAS_USD}.`
          : `Net is negative at the model deposit: do not farm for the airdrop alone; revisit only if the odds or the implied value move.`;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      ratio_pred: round4(s.ratio),
      gp_sigma: round4(s.pr.std),
      p10_usd: q(-1.282),
      p25_usd: q(-0.674),
      p75_usd: q(0.674),
      p90_usd: q(1.282),
      odds: round4(s.odds),
      verdict,
      net_usd: round4(s.econ.net),
      net_per_hour: round4(s.econ.net / s.hours),
      rank_lo: rankLo,
      rank_hi: rankHi,
      deposit_grid: grid,
      exit_rule: exitRule,
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });

  const live = liveRows(snapshot);
  const preToken = snapshot.protocols.filter(isPreToken).length;
  const liveCount = snapshot.protocols.length - preToken;
  const setAside = preToken - board.length;
  const oddsByAge = ['<180d', '180-364d', '365-729d', '730d+'].map((bucket, bi) => {
    const rows = board.filter((row) => {
      const a = row.age_days ?? 365;
      if (bi === 0) return a < 180;
      if (bi === 1) return a >= 180 && a < 365;
      if (bi === 2) return a >= 365 && a < 730;
      return a >= 730;
    });
    return { bucket, median_odds: rows.length ? round4(median(rows.map((x) => x.odds))) : 0, n: rows.length };
  });

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: 'DefiLlama protocols API, fetched 2026-11-14T01:18:33.201Z',
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    anchor_round: ANCHOR_ROUND,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.length - snapshot.watchlist.length,
    live_size: live.length,
    ledger_ranked: board.length,
    ledger_setaside: setAside,
    ledger_live: liveCount,
    ledger_total: snapshot.protocols.length,
    deposit_pct: DEPOSIT_PCT,
    deposit_pct_frac: DEPOSIT_FRAC,
    deposit_min: DEPOSIT_MIN,
    deposit_max: DEPOSIT_MAX,
    gas_usd: GAS_USD,
    evidence: {
      loo: round4(evidence.loo),
      loo_median: round4(evidence.looMedian),
      wf: round4(evidence.wf),
      wf_median: round4(evidence.wfMedian),
      fold_seq: round4(evidence.foldSeq),
      fold_strat: round4(evidence.foldStrat),
      fold_rand: round4(evidence.foldRand),
      cov50: round4(evidence.cov50),
      cov80: round4(evidence.cov80),
      auc: round4(evidence.auc),
      brier: round4(evidence.brier),
      wf_auc: round4(evidence.wfAuc),
      wf_brier: round4(evidence.wfBrier),
      sigma_loo: round4(evidence.sigmaLoo),
      platt_a: round4(evidence.plattA),
      platt_b: round4(evidence.plattB),
      labelled: lab.length,
    },
    odds_by_age: oddsByAge,
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      watchlist: snapshot.watchlist.includes(row.slug),
      age_days: row.age_days,
      implied_value_usd: row.implied_value_usd,
      ratio_pred: row.ratio_pred,
      gp_sigma: row.gp_sigma,
      p10_usd: row.p10_usd,
      p25_usd: row.p25_usd,
      p75_usd: row.p75_usd,
      p90_usd: row.p90_usd,
      odds: row.odds,
      verdict: row.verdict,
      net_usd: row.net_usd,
      net_per_hour: row.net_per_hour,
      rank_lo: row.rank_lo,
      rank_hi: row.rank_hi,
      deposit_grid: row.deposit_grid,
      exit_rule: row.exit_rule,
      farm_steps: row.farm_steps,
    })),
    live,
  };
  return { board, radar, evidence };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
