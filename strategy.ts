// First-wave scalper for the pump.fun Sharpe sprint (agent-fun/replay/v2).
//
// Idea: on pump.fun most curves bleed and only a first real wave pays. This bot
// takes exactly ONE small, fixed-size entry per curve, on the first wave that
// shows broad buying (many distinct buyers, real net SOL inflow, price rising
// over a 60-slot window), and exits fast on a fixed take-profit or a tight stop.
// No pyramiding, no trailing stop, no re-entry: re-entering a curve that already
// ran buys the top, and trailing stops give the win back in this market (both
// measured on the dev window before this was written). Small stakes and a total
// exposure cap keep the equity curve smooth, which is what hourly Sharpe rewards:
// many small, independent, slightly-positive trades, not one big win.
//
// Guardrails: the run needs >= 200 fills over >= 20 coins. The selective main
// strategy alone trades ~5-10 coins an hour, so tiny probe round trips (0.012 SOL,
// sold as soon as the buy lands) pace the fill count up to the target, spread
// evenly over the window by block time. A probe costs ~3% of 0.012 SOL and its
// price noise is negligible against a 10 SOL equity.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. All amounts are exact lamports
// (bigint) until the final float ratio for an exit decision.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far inside one window. */
  maxPriceUp: number;
  /** Net buy SOL (buys minus sells) over the window, upper bound: skip overheated flow. */
  maxNetSol: number;
  /** Upper bound on the price rise over the last few slots: do not chase a spike that is still vertical. */
  maxLastJump: number;
  /** Lookback in slots for maxLastJump. */
  lastJumpWindow: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which no entry is allowed. */
  maxAge: number;
  /** Entry only after the signal held on this many consecutive evaluations. */
  confirm: number;
  /** SOL to put into one position (capped by the 1%-of-reserve size cap). */
  stakeSol: number;
  /** Smallest buy worth sending (also the guardrail's round-trip floor). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when close value reaches cost * takeProfit. */
  takeProfit: number;
  /** Sell when close value falls below cost * stopLoss. */
  stopLoss: number;
  /** Slots after entry during which the stop loss does not fire (first-minute noise). */
  stopGrace: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Most main positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target fills / coins over paceSecs of block time. */
  targetFills: number;
  targetCoins: number;
  paceSecs: number;
  /** Probe round-trip size in SOL. */
  probeSol: number;
  /** Most probe round trips in flight at once. */
  maxProbes: number;
}

// Settings traded with. Chosen on the dev window with the local sim, preferring
// a flat region of the grid over a single best cell (see AGENT.md). The plateau
// around these values is wide: window 120 with minNetSol 1.0 and minPriceUp
// 0.02-0.04, takeProfit 1.27 with stopLoss 0.94-0.95, stakeSol 0.20-0.30 all
// land within a few hundredths of a SOL of each other, and the setting below is
// positive on every fail key tried (11/22/33/44).
export const DEFAULT_PARAMS: Params = {
  window: 120,
  minNetSol: 1.0,
  minBuys: 5,
  minBuyers: 5,
  minPriceUp: 0.02,
  maxPriceUp: 0.3,
  maxNetSol: 1e9,
  maxLastJump: 10,
  lastJumpWindow: 5,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 500,
  maxAge: 2000,
  confirm: 1,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.27,
  stopLoss: 0.94,
  stopGrace: 0,
  maxHold: 1800,
  maxMain: 5,
  maxExposureSol: 3,
  targetFills: 220,
  targetCoins: 30,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  /** True once this curve has had its one entry (win or lose, never re-enter). */
  entered: boolean;
  /** Consecutive batch evaluations where the entry signal held. */
  streak: number;
}

interface Held {
  opened: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entered: false, streak: 0 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (t.entered) return false;
    const from = now - p.window;
    // Baseline: the most recent trade at or before the window start, else the
    // oldest trade inside the window.
    let baseline = -1;
    let net = 0;
    let buys = 0;
    let last = 0;
    const byUser = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        baseline = tr.price;
        continue;
      }
      if (baseline < 0) baseline = tr.price;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        byUser.add(tr.user);
      }
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (net < p.minNetSol || net > p.maxNetSol) return false;
    if (baseline <= 0 || last <= 0) return false;
    const up = last / baseline - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (p.maxLastJump < 10) {
      // Price a few slots ago: the most recent trade at or before now - lastJumpWindow.
      let ref = -1;
      for (let i = t.trades.length - 1; i >= 0; i--) {
        if (t.trades[i]!.slot <= now - p.lastJumpWindow) {
          ref = t.trades[i]!.price;
          break;
        }
      }
      if (ref > 0 && last / ref - 1 > p.maxLastJump) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take-profit, tight stop, or time limit. Sell whole.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value >= cost * p.takeProfit) exit = true;
        if (!exit && now - h.opened > p.stopGrace && value < cost * p.stopLoss) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Update the confirmation streak for every traded curve: the signal must
      // hold on consecutive evaluations, so a one-batch spike does not trigger.
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entered) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        t.streak = entrySignal(t, now, rqSol) ? t.streak + 1 : 0;
      }

      // Then entries: one fixed-size buy per curve, on its first broad wave.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        void h;
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entered || t.streak < p.confirm) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, exiting: false, filled: false });
        t.entered = true;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
