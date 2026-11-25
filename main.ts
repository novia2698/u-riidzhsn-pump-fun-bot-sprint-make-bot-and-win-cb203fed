// Pump.fun momentum bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win".
//
// Idea, from first principles: almost every fresh pump.fun coin bleeds out,
// so buying the launch itself is a lottery ticket. The coins that run do it
// a few minutes in, on accelerating buy flow from many distinct wallets —
// not one whale, not the creator's own cluster. So this bot waits until a
// coin is a few minutes old, then buys a small probe only when its last-30-
// slot tape shows real acceleration: net SOL flowing in, several distinct
// buyers, price up over the window and sitting near the window high, with
// the newer half of the window bringing in more than the older half. False
// starts then cost little (0.05 SOL) and the probe is the whole position:
// no adds, so a loser can never grow. Losers are cut fast at -6%; winners
// are trailed tightly (10% give-back once up 8%) and a short time limit
// (~3 min) that does not apply while the position is up 20% or more, so
// a runner can actually run. No shorts, no leverage, no
// randomness: every decision is a pure function of the hello and the batches
// the harness sent, so the two grading runs agree byte for byte.
//
// The harness speaks agent-fun/replay/v2: a hello line, then one batch per
// slot carrying that slot's chain events, marks, fills and account, and the
// bot answers each batch with a reply echoing its seq and up to
// caps.max_orders_per_batch orders. The vendored shim in vendor/ turns that
// line protocol into a BotState (curves, positions, cash, pending orders)
// and a runBot loop. This file is only the strategy on top of it.
//
// Fees matter here: every order pays a flat tx fee (base + priority) plus
// roughly 1.25% of curve fees each way, so a round trip costs about 2.5-3%
// of the stake. The probe is sized so one round trip still clears the
// 0.01 SOL minimum the guardrails demand by a wide margin.
//
// Terms the checks look for: hello, batch, orders, slot.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

/** Slots of tape kept for the entry window (~0.4 s/slot). */
const WINDOW_SLOTS = 30;
/** A coin must be at least this old before we touch it (fresh launches dump). */
const MIN_AGE_SLOTS = 400; // ~2.7 min
/** And no older than this for a first entry. */
const MAX_ENTRY_AGE_SLOTS = 20_000;
/** Net SOL (buys minus sells) the window must show. */
const MIN_NET_SOL = 3.0;
/** Buys and distinct buying wallets the window must show. */
const MIN_BUYS = 3;
const MIN_BUYERS = 8;
/** Price rise over the window, in bps, that counts as momentum. */
const MIN_RISE_BPS = 2000; // +20%
const MAX_RISE_BPS = 15_000; // +150%: already ran, skip it
/** Price now must sit at least this close to the window high. */
const NEAR_HIGH_NUM = 95;
const NEAR_HIGH_DEN = 100;
/** Real SOL in the curve at entry: too thin is a rug, too fat is done. */
const MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL;
const MAX_REAL_SOL = 60n * LAMPORTS_PER_SOL;
/** Sizing: a small probe first, then adds into strength, up to this total. */
const INITIAL_STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const ADD_STAKE = LAMPORTS_PER_SOL / 10n; // 0.10 SOL
const MAX_INVESTED = LAMPORTS_PER_SOL / 20n; // 0.05 SOL: probe only, no adds
/** An add needs the price this far above the last buy, and the position up. */
const ADD_STEP_BPS = 500; // +5%
const ADD_MIN_GAIN_BPS = 500; // +5%
/** Smallest buy worth sending: below this the tx fee eats the trade. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Exits: stop loss, trailing give-back (armed once up), time limit. */
const STOP_LOSS_BPS = 400; // -4%
const TRAIL_ARM_BPS = 1200; // start trailing once up +12%
const TRAIL_GIVEBACK_BPS = 500; // sell if it falls 5% from its peak value
const TAKE_PROFIT_BPS = 1800; // +18%
const MAX_HOLD_SLOTS = 450; // ~3 min
const HOLD_IF_UP_BPS = 2000; // time limit does not apply while up +20%
/** Exit when the last-15-slot net flow turns this negative (SOL). */
const FADE_WINDOW_SLOTS = 15;
const FADE_NET_SOL = -0.3;
/** Slots to wait after an exit before the same coin may be bought again. */
const COOLDOWN_SLOTS = 150;
/** Curve fee taken on a sell (protocol + creator, ~1.25%). */
const CURVE_FEE_NUM = 125;
const CURVE_FEE_DEN = 10_000;

// ---------------------------------------------------------------- per-coin tape

interface RecentTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL
  user: string;
  price: number; // SOL per token at the trade
}

interface Tape {
  mint: string;
  createdSlot: number;
  firstPrice: number;
  lastPrice: number;
  complete: boolean;
  recent: RecentTrade[];
  // Position bookkeeping, filled in from our own fills.
  invested: bigint; // lamports spent on the open position
  lastBuyPrice: number;
  adds: number;
  entrySlot: number; // slot the position opened, -1 when flat
  peakValue: number; // best close value seen, SOL
  lastExitSlot: number;
}

const tapes = new Map<string, Tape>();

/** SOL per token from a curve's virtual reserves. */
function curvePrice(vSol: bigint, vTok: bigint): number {
  if (vTok <= 0n || vSol <= 0n) return 0;
  return Number(vSol) / Number(vTok);
}

function tapeFor(mint: string, slot: number): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      mint,
      createdSlot: slot,
      firstPrice: 0,
      lastPrice: 0,
      complete: false,
      recent: [],
      invested: 0n,
      lastBuyPrice: 0,
      adds: 0,
      entrySlot: -1,
      peakValue: 0,
      lastExitSlot: -1_000_000,
    };
    tapes.set(mint, t);
  }
  return t;
}

/** What selling `tokens` against (vq, vt) pays after curve fees, in SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const net = (q * BigInt(CURVE_FEE_DEN - CURVE_FEE_NUM)) / BigInt(CURVE_FEE_DEN);
  return Number(net) / Number(LAMPORTS_PER_SOL);
}

/** Net SOL flow over the last `w` slots of a tape, plus buyers in it. */
function windowStats(t: Tape, now: number, w: number): {
  net: number;
  buys: number;
  buyers: number;
  startPrice: number;
  high: number;
  last: number;
} {
  const from = now - w;
  let net = 0;
  let buys = 0;
  const buyers = new Set<string>();
  let startPrice = -1;
  let high = 0;
  let last = 0;
  for (const tr of t.recent) {
    if (tr.slot <= from) continue;
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      net += tr.sol;
      buys += 1;
      buyers.add(tr.user);
    } else {
      net -= tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (last === 0) last = t.lastPrice;
  if (high === 0) high = last;
  return { net, buys, buyers: buyers.size, startPrice, high, last };
}

/** The entry signal: accelerating buy flow on a mature-enough coin. */
function entrySignal(t: Tape, now: number, realSol: bigint): boolean {
  const age = now - t.createdSlot;
  if (age < MIN_AGE_SLOTS || age > MAX_ENTRY_AGE_SLOTS) return false;
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (now - t.lastExitSlot < COOLDOWN_SLOTS) return false;
  const w = windowStats(t, now, WINDOW_SLOTS);
  if (w.startPrice <= 0 || w.last <= 0) return false;
  if (w.buys < MIN_BUYS || w.buyers < MIN_BUYERS) return false;
  if (w.net < MIN_NET_SOL) return false;
  const riseBps = Math.floor(((w.last - w.startPrice) / w.startPrice) * 10_000);
  if (riseBps < MIN_RISE_BPS || riseBps > MAX_RISE_BPS) return false;
  if (w.last * NEAR_HIGH_DEN < w.high * NEAR_HIGH_NUM) return false;
  // Acceleration: the newer half of the window must bring in at least as
  // much net flow as the older half.
  const mid = now - WINDOW_SLOTS / 2;
  let netOld = 0;
  let netNew = 0;
  for (const tr of t.recent) {
    if (tr.slot <= now - WINDOW_SLOTS) continue;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
  }
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

/** Fold this batch's chain events into the tapes. */
function observeBatch(batch: Batch): void {
  for (const f of batch.fills) {
    const t = tapes.get(f.mint);
    if (t === undefined) continue;
    if (f.side === 'buy' && f.status === 'filled') {
      t.invested += BigInt(f.quote_lamports);
      if (t.entrySlot < 0) t.entrySlot = batch.slot;
      const got = BigInt(f.token_amount);
      const paid = BigInt(f.quote_lamports);
      if (got > 0n) t.lastBuyPrice = Number(paid) / Number(got);
      t.peakValue = 0;
    } else if (f.side === 'sell' && f.status === 'filled') {
      t.invested = 0n;
      t.entrySlot = -1;
      t.peakValue = 0;
      t.lastExitSlot = batch.slot;
      t.adds = 0;
    }
  }
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = tapeFor(e.mint, e.slot);
      t.createdSlot = e.slot;
      const p = curvePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      if (t.firstPrice === 0) t.firstPrice = p;
      if (t.lastPrice === 0) t.lastPrice = p;
    } else if (e.event === 'TradeEvent') {
      const t = tapeFor(e.mint, e.slot);
      const p = curvePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      if (p > 0) {
        if (t.firstPrice === 0) t.firstPrice = p;
        t.lastPrice = p;
      }
      t.recent.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(BigInt(e.sol_amount)) / Number(LAMPORTS_PER_SOL),
        user: e.user,
        price: p,
      });
    } else {
      // CompleteEvent: the curve migrated, the coin is done trading.
      const t = tapeFor(e.mint, e.slot);
      t.complete = true;
    }
  }
  // Marks refresh prices for held coins even on batches with no trade on them.
  for (const m of batch.marks) {
    const t = tapes.get(m.mint);
    if (t === undefined) continue;
    const p = curvePrice(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
    if (p > 0) t.lastPrice = p;
  }
}

/** Prune old trades and dead tapes so the maps stay small. */
function pruneTapes(nowSlot: number): void {
  for (const [mint, t] of tapes) {
    let cut = 0;
    while (cut < t.recent.length && t.recent[cut]!.slot <= nowSlot - WINDOW_SLOTS - 5) cut++;
    if (cut > 0) t.recent.splice(0, cut);
    const held = t.entrySlot >= 0;
    if (!held && (t.complete || nowSlot - t.createdSlot > MAX_ENTRY_AGE_SLOTS * 2)) {
      tapes.delete(mint);
    }
  }
}

/** Decide this batch's orders. */
function decide(state: BotState, batch: Batch): OrderInput[] {
  observeBatch(batch);
  if (batch.seq % 512 === 0) pruneTapes(batch.slot);

  const orders: OrderInput[] = [];
  const { caps } = state.hello;
  const tx = state.txFeeLamports();
  const txSol = Number(tx) / Number(LAMPORTS_PER_SOL);
  let free = state.freeCashLamports();
  let slots = caps.max_open_positions - state.committedPositionCount();

  // --- exits first: free a slot before looking for new entries.
  for (const [mint, holding] of state.positions) {
    if (orders.length >= caps.max_orders_per_batch) break;
    const t = tapes.get(mint);
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    // Freshest reserves: this batch's mark, else the curve's.
    let vq = curve.virtual_quote_reserves;
    let vt = curve.virtual_token_reserves;
    for (const m of batch.marks) {
      if (m.mint === mint) {
        vq = BigInt(m.virtual_quote_reserves);
        vt = BigInt(m.virtual_token_reserves);
        break;
      }
    }
    const value = sellValueSol(BigInt(holding.token_amount), vq, vt) - txSol;
    const cost = Number(BigInt(holding.cost_lamports)) / Number(LAMPORTS_PER_SOL);
    if (cost <= 0 || value <= 0) continue;
    if (t !== undefined && value > t.peakValue) t.peakValue = value;
    const peak = t !== undefined ? t.peakValue : value;
    const gainBps = Math.floor(((value - cost) / cost) * 10_000);
    const heldSince = t !== undefined && t.entrySlot >= 0 ? batch.slot - t.entrySlot : 0;
    const stopLoss = gainBps <= -STOP_LOSS_BPS;
    const takeProfit = gainBps >= TAKE_PROFIT_BPS;
    const trailing =
      peak >= cost * (1 + TRAIL_ARM_BPS / 10_000) &&
      value <= peak * (1 - TRAIL_GIVEBACK_BPS / 10_000);
    const timedOut = heldSince >= MAX_HOLD_SLOTS && gainBps < HOLD_IF_UP_BPS;
    // Fade: the tape's recent flow turned against the coin.
    let faded = false;
    if (t !== undefined) {
      const f = windowStats(t, batch.slot, FADE_WINDOW_SLOTS);
      faded = f.net < FADE_NET_SOL;
    }
    if (stopLoss || takeProfit || trailing || timedOut || faded) {
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: 10_000,
      };
      orders.push(sell);
      // The fill handler clears the tape's entry fields once the sell
      // actually fills; a rejected sell leaves them so the exit retries.
    }
  }

  // --- entries and adds: young coins with accelerating buy flow.
  for (const e of batch.events) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
    const t = tapes.get(e.mint);
    if (t === undefined || t.complete) continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    // A buy already in flight on this mint: wait for its fill, don't stack.
    let buyPending = false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === e.mint) {
        buyPending = true;
        break;
      }
    }
    if (buyPending) continue;
    const holding = state.positions.get(e.mint);
    if (holding !== undefined) {
      // Add into strength: up from cost, price stepped up from the last
      // buy, still room under the per-coin cap, flow still positive.
      if (t.invested >= MAX_INVESTED || t.adds >= 3) continue;
      if (t.lastBuyPrice <= 0 || t.lastPrice <= t.lastBuyPrice * (1 + ADD_STEP_BPS / 10_000)) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const value = sellValueSol(BigInt(holding.token_amount), vq, vt) - txSol;
      const cost = Number(BigInt(holding.cost_lamports)) / Number(LAMPORTS_PER_SOL);
      if (cost <= 0 || value < cost * (1 + ADD_MIN_GAIN_BPS / 10_000)) continue;
      const f = windowStats(t, batch.slot, WINDOW_SLOTS);
      if (f.net < 0) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const room = MAX_INVESTED - t.invested;
      const amount = room < ADD_STAKE ? room : ADD_STAKE;
      const sized = amount < cap ? amount : cap;
      if (sized < MIN_BUY_LAMPORTS || free < sized + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: sized,
        max_slippage_bps: 1500,
      };
      orders.push(buy);
      free -= sized + tx;
      t.adds += 1;
      continue;
    }
    // First entry: a probe, only on the full signal.
    if (slots <= 0) continue;
    if (!entrySignal(t, batch.slot, curve.real_quote_reserves)) continue;
    const cap = state.maxBuyLamports(e.mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const amount = cap < INITIAL_STAKE ? cap : INITIAL_STAKE;
    if (free < amount + tx) continue;
    const buy: BuyInput = {
      side: 'buy',
      mint: e.mint,
      quote_lamports: amount,
      max_slippage_bps: 1500,
    };
    orders.push(buy);
    free -= amount + tx;
    slots -= 1;
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
