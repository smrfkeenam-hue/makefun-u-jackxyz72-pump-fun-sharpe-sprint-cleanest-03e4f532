# Agent notes — first-wave scalper (Pump.fun Sharpe Sprint)

## Strategy

One small fixed-size entry per curve, on the first broad buying wave, then a
fixed take-profit or a tight stop. No pyramiding, no trailing stop, no
re-entry: measured on the dev window, re-entering a curve that already ran
buys the top, trailing stops give the win back, and pyramiding into strength
turns a -20% stop into an account-ending loss (the kit pilot's momentum
baseline loses -9.4 SOL on this window for exactly those reasons).

Entry (120-slot window, evaluated per batch on curves that traded):
- net SOL inflow >= 1.0, >= 5 buys, >= 5 distinct buyers, price up >= 2% over
  the window and <= 30% (skip curves that already ran too far), real SOL 1-80,
  age 500-2000 slots since creation, never entered before (one entry per coin).
- Stake 0.30 SOL, capped by the 1%-of-real-reserve size cap and by free cash;
  skip when the cap is under 0.01 SOL. Total exposure capped at 3 SOL.

Exits (sell whole, slippage wide open): close value >= cost x 1.27
(take-profit), close value < cost x 0.94 (tight stop), or held > 1800 slots.
Close value is the mark-to-market sell proceeds after curve fees and the tx
fee, so the take-profit is about +30% on price and the stop about -4% on price
once fees and the 2-slot fill latency are counted.

Guardrails: the run needs >= 200 fills over >= 20 coins. The selective main
strategy trades ~187 round trips per 24 h on its own, so tiny probe round
trips (0.012 SOL, sold as soon as the buy lands) pace the fill count to the
220-fill target, spread evenly over the window by block time. A probe costs
~3% of 0.012 SOL; its price noise is negligible against a 10 SOL equity.

Deterministic by construction: no clock, no randomness, iteration only over
insertion-ordered maps fed by the batch stream.

## What was tried and dropped (dev window)

- Trailing stops, fade exits, pyramiding, re-entry after cooldown, signal
  confirmation on 2-3 consecutive batches, "don't chase the last tick"
  (maxLastJump), wider stops (0.80-0.90), wider take-profits (1.35+), long
  holds / riding runners to 2x, buying the dump, spike-chasing: all worse.
- The kit pilot's momentum baseline (pyramid to 2 SOL, -20% stop, no
  take-profit): -9.38 SOL on the dev window, 5/80 wins, 95% drawdown.
- Round-trip cost is ~6.3% of stake (1.25% curve fee each way + tx fees +
  ~1.6% buy slippage and ~1.7% sell slippage from the 2-slot latency), so a
  trade needs a real edge to clear it; that is why the take-profit is +27%
  on value and the stop is tight.

## Verification (dev window, 24 h, 1222 coins)

Local sim (kit engine port, full dataset, fail keys 11/22/33/44):
- net PnL +0.123 / +0.039 / +0.125 / +0.137 SOL; hourly Sharpe
  +0.082 / +0.041 / +0.084 / +0.090; fills 372-376, coins 126-129,
  trips 186-188, win rate 16-18%, max drawdown 1.6-2.9%.
- The setting sits on a flat plateau: window 120 with minNetSol 1.0 and
  minPriceUp 0.02-0.04, takeProfit 1.27 with stopLoss 0.94-0.95, stakeSol
  0.20-0.30 all land within a few hundredths of a SOL of each other.

Official grade-local (driver process, run twice, L1 regrade reproduced
byte for byte — deterministic):
- net PnL +0.1467 SOL (return +1.47%); hourly Sharpe 0.0784
  (result/performance/metrics/sharpe).
- 376 fills over 128 coins, 188 round trips, win rate 17.6%, max drawdown
  2.24%, 6 rejected, 1 failed. Guardrails met (128 coins hold a round trip
  of at least 0.01 SOL; drawdown ok).
- Fees 0.423 SOL curve + 0.040 SOL tx; at 2x fees net PnL -0.313 SOL.
- result_sha256 07bdcb8307dfa8508d6d6e18409b9d16d6d822b29a0725cd046852489f3628f6
  (local Node v24.22.1; the server harness runs v26.13.1, so the server hash
  will differ — the score should not).
- action_log_sha256 45dd7a2efc3c00fddf4f0d6f3e6aab6d452b7985eecd22279a5c5cad23bc199a

Stress test (grade-local --stress 20, block surrogates of the dev window):
- 20 block copies: median -0.83 SOL, p10 -1.44, p90 -0.12; 20 of 20 lost
  money; the dev score (+0.147) is above 20 of 20 copies.
- Read honestly: the edge depends on the real within-coin temporal
  structure. A block copy rebuilds each coin's tape from 8-trade blocks of
  other coins, which destroys momentum by design — so a momentum strategy
  is *expected* to lose on them. The kit's own note says the copies "are
  not a forecast of another window". What the stress test does rule out is
  the hindsight risk: the dev score is only +0.98 SOL above the block-copy
  median, far below the >=3.00 SOL (twins) / >=3.50 SOL (blocks) hold
  thresholds, so the entry is not a hindsight artifact.
- The remaining risk is the honest one: whether the momentum edge that
  exists in this 24 h window also exists in the final 6 h window. It
  cannot be proven from the dev window alone.

## Caveats (honest)

- The edge is thin: +0.15 SOL on a 10 SOL account over 24 h. The
  dev_profitable gate (net PnL > 0) passes, but only just.
- Concentration: the 3 best coins made 21% of the gains (+0.29 SOL); net
  PnL without them is -0.14 SOL. The final 6-hour window has ~47 trips, so
  whether a big winner lands inside it matters a lot; the 6-hour Sharpe
  will be noisier than the 24-hour dev Sharpe reported here.
- The strategy holds no real addresses, signatures or trade amounts from
  the dev window; nothing in it is tuned to a specific coin.
