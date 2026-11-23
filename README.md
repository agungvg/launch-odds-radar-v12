# Launch-Odds Radar v12

[![Bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v12/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v12/reward.svg)](https://make.fun/bounty/token-radar-01)

Every value term fitted and tested held-out twice. Token odds from the labelled peers' record. Integrity strip. A costed farm plan on every row.

A [make.fun](https://make.fun/bounty/token-radar-01) token-radar-01 entry by [@lyso](https://make.fun/u/lyso). Referral: `p9r33tb4`.

## What it is

Launch-Odds Radar ranks the 198 pre-token protocols in a frozen DefiLlama snapshot (14 Nov 2026, 758 protocols) by implied token value, and gives every row a costed 10-step farm plan with a net-of-fees verdict.

## Model — radar-12

A Gaussian process regression (Matérn ν=1.5, ARD) on log10(market-cap / TVL), clipped to [0.1×, 10×], fitted on the 95 labelled protocols that record a token with a market cap and a listing date. Features are snapshot figures only: log TVL and its square, clamped 7-day growth, log age, chain count, and 8 semantic category flags. No category token-rate, no target leakage, no selection on full-fit error.

Held-out evidence, recomputed from the snapshot on every run:

| Check | Measured | Target |
|---|---|---|
| Leave-one-out miss | ×2.48 | ≤ ×3.33 |
| Walk-forward miss (66 older → 29 newer) | ×3.19 | ≤ ×2.53 |
| Worst 5-fold (sequential / stratified / random) | ×2.99 / ×3.10 / ×2.64 | ≤ ×4.5 |
| P25–P75 / P10–P90 coverage | 61.1% / 85.3% | ≥ 57% / ≥ 76% |
| Token-odds AUC / Brier (out-of-fold) | 0.754 / 0.199 | ≥ 0.79 / ≤ 0.215 |

Two misses are disclosed on the dashboard, not hidden: walk-forward ×3.19 and AUC 0.754. No honest variant tried across four versions reached them; the ceiling is in the data at n=95.

## Farm economics

Expected value = odds × 10% community share × implied value × (deposit / TVL), minus $15 gas and a 5% opportunity cost. Deposit is 0.02% of implied value, clamped $25–$500. Verdict: FARM at net ≥ $5, THIN at $0–$5, SKIP below $0. The 10% community share is a stated modelling assumption.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

Node 22, standard library only. The program reads `/input/snapshot.json` (or `--input`), writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to `/output`, and writes `dossier.json` with the vendored make.fun library.
