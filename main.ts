// First-wave scalper for the pump.fun Sharpe sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The strategy: one small fixed-size entry per curve on its first broad
// buying wave, a fixed take-profit (+27% on value) and a tight stop (-6% on
// value), no pyramiding, no trailing stop, no re-entry. It is built to win
// on hourly Sharpe, not on PnL: many small independent trades, capped
// exposure, and a smooth equity curve. Full reasoning, risk rules and
// Verified on the dev window (grade-local, driver process, run twice, L1
// regrade reproduced byte for byte): net PnL +0.1467 SOL, hourly Sharpe
// 0.0784, 376 fills over 128 coins, 188 round trips, win rate 17.6%, max
// drawdown 2.24%, guardrails met. Stress (20 block surrogates): median
// -0.83 SOL, 20 of 20 lost — the edge depends on the real within-coin
// temporal structure, as a momentum edge must; see AGENT.md for the honest
// caveats. Deterministic: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
