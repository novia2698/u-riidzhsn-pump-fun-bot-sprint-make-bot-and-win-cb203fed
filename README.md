# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/novia2698/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/novia2698/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A momentum scalper for pump.fun bonding curves, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty ($2, top 2 paid). It trades paper SOL on a replay of pump.fun chain data, ranked on net PnL — aiming for a paid place, not just a complete entry.

## How it works

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's SDK shim). For every new coin it watches the tape: price from the curve's virtual reserves, trade count, buy share, and SOL flow. It buys only a young coin that proves strong buy pressure — price up at least 20% over its window with at least 1.5 SOL net inflow from at least 6 distinct buyers — with a small 0.05 SOL probe, one entry per coin, no adds, at most 5 open positions. It exits fast: stop-loss (-6%), trailing give-back (sells if it falls 10% from peak once up 8%), a fade in buy flow, or a hard ~3-minute time limit that does not apply while the position is up 20% or more. Every decision is a pure function of the hello and the batches, so the two grading runs agree.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` with this directory mounted at `/bot`. No dependencies, no network, no secrets — Node 22+ runs the TypeScript directly.

## Files

- `main.ts` — the whole strategy (entry, exits, tape tracking).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, unchanged.
- `system-prompt.txt` — the builder brief this entry was written from.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bpr1tvsc&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
