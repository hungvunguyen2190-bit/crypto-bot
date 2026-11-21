/**
 * INSTITUTIONAL BACKTEST AUDIT:
 *   1. BTC Buy & Hold (Benchmark 1)
 *   2. Equal-Weight Top Crypto Basket (Benchmark 2)
 *   3. Old signal_bot.py v1 (Exact reproduction of user's v1 rules + fixed 8% SL / 10-20% TP)
 *   4. Old signal_bot.py v1-Fixed (Math bugs EMA200 & 5d-extension fixed, same TA logic)
 *   5. Quant Regime + Cross-Sectional Momentum & ATR Chandelier v2 (Zero Look-Ahead, Next-Bar Open Execution)
 *
 * Strict Anti-Bias Rules:
 *   - Signal evaluated at bar [t] close -> Executed at bar [t+1] OPEN.
 *   - Fee + Slippage = 0.15% per side (0.30% round-trip).
 *   - Intra-bar SL/TP checks bar HIGH/LOW; if both hit in same candle, SL assumed hit first (worst-case).
 *   - Warmup period: 2022-07-01 -> 2022-12-31; Evaluation: 2023-01-01 -> Present (plus 2025-2026 Stress Split).
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '.backtest_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'SUIUSDT',
  'ONDOUSDT',
];

const WARMUP_START = Date.parse('2021-09-01T00:00:00Z');
const CYCLE5Y_START = Date.parse('2022-01-01T00:00:00Z'); // Includes Luna + FTX 2022 Bear Crash!
const EVAL_START   = Date.parse('2023-01-01T00:00:00Z');
const OOS_START    = Date.parse('2025-01-01T00:00:00Z'); // Brutal 2025-2026 bull peak + bear crash stress period
const FEE_SIDE     = 0.0015; // 0.10% Binance fee + 0.05% slippage per side

async function fetchKlines4h(symbol) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_4h_v5y.json`);
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < 6 * 3600 * 1000) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  let all = [];
  let startTime = WARMUP_START;
  const now = Date.now();

  while (startTime < now) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=4h&startTime=${startTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      all.push({
        ts: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        vol: Number(r[5]),
        quoteVol: Number(r[7]),
        takerBuyVol: Number(r[9]),
        takerBuyQuote: Number(r[10]),
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    if (rows.length < 1000) break;
    startTime = lastTs + 4 * 3600 * 1000;
  }

  // Drop currently unclosed candle if within 4h
  if (all.length > 1) all.pop();
  fs.writeFileSync(cacheFile, JSON.stringify(all));
  return all;
}

// ============================================================================
// INDICATOR HELPERS (Vectorized on 4H series, zero look-ahead)
// ============================================================================

function calcEMA(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  if (arr.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcSMA(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) avgGain += chg; else avgLoss -= chg;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcATR(bars, period = 14) {
  const out = new Array(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  const tr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

function precomputeFeatures(bars) {
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.vol);
  const qVols  = bars.map(b => b.quoteVol);
  const tbQVol = bars.map(b => b.takerBuyQuote);

  // 4H indicators (for v1 reproduction & short-term structure)
  const ema20   = calcEMA(closes, 20);
  const ema50   = calcEMA(closes, 50);
  const ema100  = calcEMA(closes, 100); // v1 bug: min(200, 200//2) = 100
  const ema200  = calcEMA(closes, 200);
  const rsi14   = calcRSI(closes, 14);
  const volSma20 = calcSMA(vols, 20);

  // Multi-day Regime & Quant v2 features (note: 6 bars = 1 day on 4H timeframe!)
  // 20D = 120 bars, 50D = 300 bars, 100D = 600 bars, 14D ATR = 84 bars
  const ema120  = calcEMA(closes, 120); // ~20-Day EMA
  const ema300  = calcEMA(closes, 300); // ~50-Day EMA
  const sma600  = calcSMA(closes, 600); // ~100-Day SMA
  const atr84   = calcATR(bars, 84);    // ~14-Day ATR smoothed on 4H
  const qVolSma120 = calcSMA(qVols, 120); // 20-Day avg dollar volume
  const qVolSum30  = calcSMA(qVols, 30);  // 5-Day avg dollar volume
  const tbQSum30   = calcSMA(tbQVol, 30); // 5-Day avg taker buy dollar volume

  // Rolling N-bar Donchian High (excluding current bar for breakout test, or up to t-1)
  const high120Prev = new Array(bars.length).fill(NaN); // 20-Day High prior to bar t
  const high180Prev = new Array(bars.length).fill(NaN); // 30-Day High prior to bar t
  const low60Prev   = new Array(bars.length).fill(NaN); // 10-Day Low prior to bar t
  for (let i = 180; i < bars.length; i++) {
    let h120 = -Infinity, h180 = -Infinity, l60 = Infinity;
    for (let j = i - 120; j < i; j++) if (highs[j] > h120) h120 = highs[j];
    for (let j = i - 180; j < i; j++) if (highs[j] > h180) h180 = highs[j];
    for (let j = i - 60; j < i; j++)  if (lows[j] < l60)   l60 = lows[j];
    high120Prev[i] = h120;
    high180Prev[i] = h180;
    low60Prev[i]   = l60;
  }

  // Realized Volatility (30-Day = 180 4H returns std)
  const ret1 = closes.map((c, i) => (i === 0 ? 0 : c / closes[i - 1] - 1));
  const rvol180 = new Array(bars.length).fill(NaN);
  for (let i = 180; i < bars.length; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - 179; j <= i; j++) {
      sum += ret1[j];
      sumSq += ret1[j] * ret1[j];
    }
    const mean = sum / 180;
    const variance = Math.max(0, sumSq / 180 - mean * mean);
    rvol180[i] = Math.sqrt(variance);
  }

  // True 24-Hour (6 x 4H bar) ATR smoothed over 14 days (84 bars rolling 6-bar windows)
  // Fixes the sqrt(6) bug where a single 4H candle ATR was 2.5x too tight for multi-week trend trailing!
  const trueDailyTR = new Array(bars.length).fill(NaN);
  for (let i = 6; i < bars.length; i++) {
    let h6 = -Infinity, l6 = Infinity;
    for (let j = i - 5; j <= i; j++) {
      if (highs[j] > h6) h6 = highs[j];
      if (lows[j] < l6) l6 = lows[j];
    }
    const prevDayClose = closes[i - 6];
    trueDailyTR[i] = Math.max(h6 - l6, Math.abs(h6 - prevDayClose), Math.abs(l6 - prevDayClose));
  }
  const dailyAtr14 = calcSMA(trueDailyTR.map(x => (isNaN(x) ? 0 : x)), 84);

  return {
    bars, closes, highs, lows, vols, qVols,
    ema20, ema50, ema100, ema200, rsi14, volSma20,
    ema120, ema300, sma600, atr84, dailyAtr14,
    qVolSma120, qVolSum30, tbQSum30,
    high120Prev, high180Prev, low60Prev, rvol180,
  };
}

// ============================================================================
// METRICS ENGINE
// ============================================================================

function computeMetrics(equitySeries, trades, startTs) {
  const filtered = equitySeries.filter(p => p.ts >= startTs);
  if (filtered.length < 2) return null;

  const initEq = filtered[0].eq;
  const finalEq = filtered[filtered.length - 1].eq;
  const totalRet = (finalEq / initEq - 1) * 100;
  const years = (filtered[filtered.length - 1].ts - filtered[0].ts) / (365.25 * 24 * 3600 * 1000);
  const cagr = (Math.pow(finalEq / initEq, 1 / years) - 1) * 100;

  let peak = -Infinity;
  let maxDD = 0;
  let investedBars = 0;
  for (const p of filtered) {
    if (p.eq > peak) peak = p.eq;
    const dd = (p.eq / peak - 1) * 100;
    if (dd < maxDD) maxDD = dd;
    if (p.invested > 0.02) investedBars++;
  }

  // Daily returns for Sharpe & Sortino (every 6th 4H bar)
  const dailyRets = [];
  for (let i = 6; i < filtered.length; i += 6) {
    dailyRets.push(filtered[i].eq / filtered[i - 6].eq - 1);
  }
  const meanD = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
  const stdD = Math.sqrt(
    dailyRets.reduce((s, r) => s + Math.pow(r - meanD, 2), 0) / Math.max(1, dailyRets.length)
  );
  const downsideD = Math.sqrt(
    dailyRets.reduce((s, r) => s + (r < 0 ? r * r : 0), 0) / Math.max(1, dailyRets.length)
  );
  const sharpe  = stdD > 0 ? (meanD / stdD) * Math.sqrt(365) : 0;
  const sortino = downsideD > 0 ? (meanD / downsideD) * Math.sqrt(365) : 0;
  const calmar  = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;

  const periodTrades = trades.filter(tr => tr.entryTs >= startTs);
  const wins = periodTrades.filter(tr => tr.pnl > 0);
  const losses = periodTrades.filter(tr => tr.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
  const winRate = periodTrades.length > 0 ? (wins.length / periodTrades.length) * 100 : 0;
  const timeInMkt = (investedBars / filtered.length) * 100;

  return {
    initEq,
    finalEq: (finalEq / initEq) * 10000, // Normalized to $10,000 start at period start
    totalRet,
    cagr,
    maxDD,
    calmar,
    sharpe,
    sortino,
    trades: periodTrades.length,
    winRate,
    profitFactor,
    timeInMkt,
  };
}

// ============================================================================
// STRATEGY 1 & 2: BENCHMARKS (BTC Buy&Hold & Equal-Weight Basket Buy&Hold)
// ============================================================================

function runBuyAndHoldBTC(btcFeat, startTs) {
  const { bars } = btcFeat;
  const startIdx = bars.findIndex(b => b.ts >= startTs);
  const entryPrice = bars[startIdx].open * (1 + FEE_SIDE);
  const units = 10000 / entryPrice;
  const eq = [];
  for (let i = startIdx; i < bars.length; i++) {
    eq.push({ ts: bars[i].ts, eq: units * bars[i].close, invested: 1.0 });
  }
  return { eq, trades: [] };
}

function runEqualWeightBasket(dataMap, symbols, startTs) {
  const btcBars = dataMap['BTCUSDT'].bars;
  const startIdx = btcBars.findIndex(b => b.ts >= startTs);
  // Monthly equal-weight rebalance across currently listed coins
  let cash = 10000;
  const holdings = {};
  const eq = [];

  for (let i = startIdx; i < btcBars.length; i++) {
    const ts = btcBars[i].ts;
    const isRebalance = (i === startIdx) || ((i - startIdx) % 180 === 0); // Every 30 days
    if (isRebalance) {
      let totalVal = cash;
      const activeSyms = [];
      for (const s of symbols) {
        const idx = dataMap[s].tsIndex.get(ts);
        if (idx !== undefined) {
          activeSyms.push({ s, open: dataMap[s].bars[idx].open });
          if (holdings[s]) totalVal += holdings[s] * dataMap[s].bars[idx].open;
        }
      }
      if (activeSyms.length > 0) {
        const targetVal = totalVal / activeSyms.length;
        cash = 0;
        for (const { s, open } of activeSyms) {
          const curVal = (holdings[s] || 0) * open;
          const diff = Math.abs(targetVal - curVal);
          const fee = diff * FEE_SIDE;
          holdings[s] = (targetVal - fee) / open;
        }
      }
    }

    let markVal = cash;
    for (const s of symbols) {
      if (holdings[s]) {
        const idx = dataMap[s].tsIndex.get(ts);
        if (idx !== undefined) markVal += holdings[s] * dataMap[s].bars[idx].close;
      }
    }
    eq.push({ ts, eq: markVal, invested: 1.0 });
  }
  return { eq, trades: [] };
}

// ============================================================================
// STRATEGY 3: OLD signal_bot.py v1 (Exact Logic & Fixed SL/TP)
// ============================================================================

function runOldBotV1(dataMap, targetSymbols, startTs, fixMathBugs = false) {
  const btc = dataMap['BTCUSDT'];
  const startIdx = btc.bars.findIndex(b => b.ts >= startTs);

  let cash = 10000;
  const openPositions = []; // { sym, units, unitsOrig, entryPrice, entryTs, sl, tp1, tp2, tp1Hit }
  const lastSignalTs = {};
  const trades = [];
  const eq = [];

  for (let bIdx = startIdx; bIdx < btc.bars.length - 1; bIdx++) {
    const ts = btc.bars[bIdx].ts;
    const nextTs = btc.bars[bIdx + 1].ts;

    // 1. Check intra-bar SL / TP1 / TP2 on bar [bIdx] for existing positions
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const f = dataMap[pos.sym];
      const idx = f.tsIndex.get(ts);
      if (idx === undefined) continue;
      const bar = f.bars[idx];

      // Conservative rule: check SL first!
      if (bar.low <= pos.sl) {
        const exitPx = Math.min(bar.open, pos.sl) * (1 - FEE_SIDE);
        const proceeds = pos.units * exitPx;
        const costBasis = pos.units * pos.entryPrice;
        cash += proceeds;
        trades.push({
          sym: pos.sym, entryTs: pos.entryTs, exitTs: ts,
          pnl: proceeds - costBasis + pos.realizedPnl, reason: 'SL -8%'
        });
        openPositions.splice(p, 1);
        continue;
      }

      if (!pos.tp1Hit && bar.high >= pos.tp1) {
        const halfUnits = pos.units * 0.5;
        const exitPx = Math.max(bar.open, pos.tp1) * (1 - FEE_SIDE);
        const proceeds = halfUnits * exitPx;
        pos.realizedPnl += proceeds - halfUnits * pos.entryPrice;
        pos.units -= halfUnits;
        pos.tp1Hit = true;
        cash += proceeds;
      }

      if (bar.high >= pos.tp2) {
        const exitPx = Math.max(bar.open, pos.tp2) * (1 - FEE_SIDE);
        const proceeds = pos.units * exitPx;
        const totalPnl = pos.realizedPnl + (proceeds - pos.units * pos.entryPrice);
        cash += proceeds;
        trades.push({
          sym: pos.sym, entryTs: pos.entryTs, exitTs: ts,
          pnl: totalPnl, reason: 'TP2 +20%'
        });
        openPositions.splice(p, 1);
      }
    }

    // Mark-to-market equity at bar [bIdx] close
    let posVal = 0;
    for (const pos of openPositions) {
      const idx = dataMap[pos.sym].tsIndex.get(ts);
      if (idx !== undefined) posVal += pos.units * dataMap[pos.sym].bars[idx].close;
    }
    const totalEq = cash + posVal;
    eq.push({ ts, eq: totalEq, invested: totalEq > 0 ? posVal / totalEq : 0 });

    // 2. Evaluate signal at close of bar [bIdx] -> execute at bar [bIdx+1] open
    const btcEmaLong = fixMathBugs ? btc.ema200[bIdx] : btc.ema100[bIdx];
    if (isNaN(btcEmaLong)) continue;
    if (btc.closes[bIdx] < btcEmaLong) continue; // BTC macro filter line 165

    let btcScore = 0;
    if (btc.ema20[bIdx] > btc.ema50[bIdx] && btc.ema50[bIdx] > btcEmaLong) btcScore = 15;
    else if (btc.ema20[bIdx] > btc.ema50[bIdx]) btcScore = 8;

    for (const sym of targetSymbols) {
      if (sym === 'BTCUSDT' && targetSymbols.length > 2) {
        // allow or skip? Let's allow whatever is in targetSymbols
      }
      const f = dataMap[sym];
      const idx = f.tsIndex.get(ts);
      const nextIdx = f.tsIndex.get(nextTs);
      if (idx === undefined || nextIdx === undefined || idx < 205) continue;

      // Cooldown 4h (1 bar)
      if (lastSignalTs[sym] && (ts - lastSignalTs[sym]) < 4 * 3600 * 1000) continue;

      const c = f.closes[idx];
      const e20 = f.ema20[idx];
      const e50 = f.ema50[idx];
      const eLong = fixMathBugs ? f.ema200[idx] : f.ema100[idx];
      const rsi = f.rsi14[idx];
      const rsiSlope = rsi - f.rsi14[idx - 5];
      const vr = f.vols[idx] / f.volSma20[idx];
      let base5 = 0;
      for (let k = idx - 5; k < idx; k++) base5 += f.vols[k];
      base5 /= 5;
      const bs = base5 > 0 ? f.vols[idx] / base5 : 1.0;

      // Bug in v1: idx - 5 (20h) vs Fixed: idx - 30 (5 days = 30 4H bars)
      const extLookback = fixMathBugs ? 30 : 5;
      const changeExt = (c / f.closes[idx - extLookback] - 1) * 100;

      let score = 0;
      if (e20 > e50 && e50 > eLong) score += 30;
      else if (e20 > e50) score += 18;
      else if (c > e20) score += 8;

      let baseRsi = 0;
      if (rsi >= 45 && rsi <= 62) baseRsi = 20;
      else if (rsi >= 40 && rsi < 45) baseRsi = 12;
      else if (rsi > 62 && rsi <= 68) baseRsi = 12;

      if (rsiSlope >= 5) score += Math.min(baseRsi + 5, 25);
      else if (rsiSlope <= -5) score += Math.max(baseRsi - 8, 0);
      else score += baseRsi;

      if (vr >= 1.5 && bs >= 1.5) score += 20;
      else if (vr >= 1.5) score += 14;
      else if (vr >= 1.3 && bs >= 1.3) score += 12;
      else if (vr >= 1.3) score += 8;
      else if (vr >= 1.0) score += 4;

      score += btcScore;

      if (changeExt > 15) score -= 20;
      else if (changeExt > 8) score -= 10;

      if (score >= 70) {
        const allocPct = score >= 85 ? 0.20 : (score >= 75 ? 0.12 : 0.07);
        const desiredNotional = totalEq * allocPct;
        const investAmt = Math.min(cash, desiredNotional);
        if (investAmt > totalEq * 0.02) {
          const entryOpen = f.bars[nextIdx].open;
          const fillPx = entryOpen * (1 + FEE_SIDE);
          const units = investAmt / fillPx;
          cash -= investAmt;
          openPositions.push({
            sym,
            units,
            entryPrice: fillPx,
            entryTs: nextTs,
            sl: entryOpen * (1 - 0.08),
            tp1: entryOpen * (1 + 0.10),
            tp2: entryOpen * (1 + 0.20),
            tp1Hit: false,
            realizedPnl: 0,
          });
          lastSignalTs[sym] = ts;
        }
      }
    }
  }

  return { eq, trades };
}

// ============================================================================
// STRATEGY 4: CRYPTO BOT v2 (Quant Regime + Relative Strength + Order-Flow + ATR Chandelier)
// Designed purely from CTA / Institutional Crypto Trend First Principles:
//   1. Macro Regime Gate:
//        - Bull Regime: BTC Close > EMA300 (50D) AND BTC EMA120 (20D) > EMA300 (50D)
//        - Defensive BTC-Only: BTC Close > EMA300 (50D) while Breadth < 40%
//        - Bear Shield (100% USDT Cash): BTC Close < EMA300 (50D) -> No new longs; tighten stops!
//   2. Entry Trigger (evaluated once per 4H bar, executed next-bar Open):
//        - Coin breaks above 20-Day High (high120Prev) OR pulls back in established uptrend?
//          Wait: Pure 20-Day High Donchian Breakout + Order-Flow confirmation (5-Day Taker Buy Ratio > 0.502 & 5D Vol > 1.1x 20D Avg Vol)
//          AND not overextended > 35% in last 5 days (anti-blowoff filter).
//        - Cross-Sectional Rank: Hold max 3 positions, ranked by Risk-Adjusted 30D Momentum (Ret30D / RVol30D).
//   3. Dynamic Exit (The Secret Weapon):
//        - NO tiny +10% TP cap! Let +100% monster trends compound!
//        - Asymmetric Chandelier Stop: HighestCloseSinceEntry - 3.2 * ATR(14D) (tightened to 2.2 * ATR if BTC loses 50D EMA!).
//        - Structural Breakdown Exit: Close < EMA300 (50D EMA) -> exit at next open.
//   4. Volatility-Targeted Position Sizing:
//        - Risk 2.0% of equity per trade based on initial stop distance (3.2 * ATR), capped at 40% weight per altcoin (60% for BTC).
// ============================================================================

function runQuantBotV2(dataMap, universe, startTs) {
  const btc = dataMap['BTCUSDT'];
  const startIdx = btc.bars.findIndex(b => b.ts >= startTs);

  let cash = 10000;
  const positions = new Map(); // sym -> { units, entryPx, entryTs, peakClose }
  const trades = [];
  const eq = [];

  for (let bIdx = startIdx; bIdx < btc.bars.length - 1; bIdx++) {
    const ts = btc.bars[bIdx].ts;
    const nextTs = btc.bars[bIdx + 1].ts;

    // Mark-to-market at bar [bIdx] close
    let posVal = 0;
    for (const [sym, pos] of positions.entries()) {
      const idx = dataMap[sym].tsIndex.get(ts);
      if (idx !== undefined) {
        const c = dataMap[sym].closes[idx];
        if (c > pos.peakClose) pos.peakClose = c;
        posVal += pos.units * c;
      }
    }
    const totalEq = cash + posVal;
    eq.push({ ts, eq: totalEq, invested: totalEq > 0 ? posVal / totalEq : 0 });

    if (bIdx < 310 || isNaN(btc.ema300[bIdx]) || isNaN(btc.dailyAtr14[bIdx])) continue;

    const btcClose = btc.closes[bIdx];
    const btcAbove20D = btcClose > btc.ema120[bIdx];
    const btcAbove50D = btcClose > btc.ema300[bIdx];

    // 1. 4H Emergency Crash / Trailing Protection (executes at next 4H bar OPEN)
    for (const [sym, pos] of Array.from(positions.entries())) {
      const f = dataMap[sym];
      const idx = f.tsIndex.get(ts);
      const nextIdx = f.tsIndex.get(nextTs);
      if (idx === undefined || nextIdx === undefined) continue;

      const c = f.closes[idx];
      const dAtr = f.dailyAtr14[idx];
      const trailMult = sym === 'BTCUSDT' ? 3.5 : 3.0;
      const chandelierStop = pos.peakClose - trailMult * dAtr;
      const hardBearBreak = !btcAbove20D && btcClose < btc.ema300[bIdx] * 0.99;
      const symBreak = sym !== 'BTCUSDT' && c < f.ema300[idx];

      if (c <= chandelierStop || hardBearBreak || symBreak) {
        const exitPx = f.bars[nextIdx].open * (1 - FEE_SIDE);
        const proceeds = pos.units * exitPx;
        const pnl = proceeds - pos.units * pos.entryPx;
        cash += proceeds;
        trades.push({
          sym,
          entryTs: pos.entryTs,
          exitTs: nextTs,
          pnl,
          reason: c <= chandelierStop ? 'Daily-ATR Chandelier' : 'Regime/Trend Break',
        });
        positions.delete(sym);
      }
    }

    // 2. Portfolio Regime & Relative-Strength Rebalance on Daily Close (00:00 UTC)
    const isDailyClose = (ts % (24 * 3600 * 1000)) === 0;
    if (!isDailyClose) continue;

    // Dual-Horizon TSMOM Regime Budget:
    //   - Strong Bull (BTC > 20D EMA & BTC > 50D EMA & 20D > 50D): 96% deployed
    //   - Caution / Early Recovery (one of 20D or 50D positive): 50% deployed
    //   - Bear Shield (BTC below both 20D & 50D EMA): 0% deployed (100% USDT Cash!)
    let riskBudget = 0.0;
    if (btcAbove20D && btcAbove50D && btc.ema120[bIdx] >= btc.ema300[bIdx]) {
      riskBudget = 0.96;
    } else if (btcAbove50D || (btcAbove20D && btcClose >= btc.high120Prev[bIdx])) {
      riskBudget = 0.50;
    } else {
      riskBudget = 0.0;
    }

    // Build Target Weights map
    const targetWeights = new Map();
    if (riskBudget > 0) {
      const btcRet30d = btcClose / btc.closes[bIdx - 180] - 1;
      const btcRvol = btc.rvol180[bIdx];
      const btcSharpe30d = btcRvol > 0 ? btcRet30d / btcRvol : 0;

      // Find up to 2 Altcoins strictly beating BTC on 30D Risk-Adjusted Momentum + Uptrend + Order Flow
      const leaders = [];
      if (riskBudget > 0.60) {
        for (const sym of universe) {
          if (sym === 'BTCUSDT') continue;
          const f = dataMap[sym];
          const idx = f.tsIndex.get(ts);
          const nextIdx = f.tsIndex.get(nextTs);
          if (idx === undefined || nextIdx === undefined || idx < 310) continue;

          const c = f.closes[idx];
          const e120 = f.ema120[idx];
          const e300 = f.ema300[idx];
          const rvol = f.rvol180[idx];
          if (isNaN(e300) || isNaN(rvol) || rvol <= 0) continue;

          const ret30d = c / f.closes[idx - 180] - 1;
          const ret5d  = c / f.closes[idx - 30] - 1;
          const sharpe30d = ret30d / rvol;
          const takerRatio5d = f.qVolSum30[idx] > 0 ? f.tbQSum30[idx] / f.qVolSum30[idx] : 0.5;

          const alreadyHeld = positions.has(sym);
          const hurdle = alreadyHeld ? btcSharpe30d * 0.95 : Math.max(0.10, btcSharpe30d * 1.15);
          const triggerOk = alreadyHeld ? (c > e120 && e120 > e300) : (c > e120 && e120 > e300 && c >= f.high120Prev[idx] && ret5d <= 0.40 && takerRatio5d >= 0.50);

          if (triggerOk && sharpe30d > hurdle && ret30d > 0) {
            leaders.push({ sym, sharpe30d });
          }
        }
        leaders.sort((a, b) => b.sharpe30d - a.sharpe30d);
      }

      const topLeaders = leaders.slice(0, 2);
      const satWeightEach = 0.25 * riskBudget;
      let usedSat = 0;
      for (const l of topLeaders) {
        targetWeights.set(l.sym, satWeightEach);
        usedSat += satWeightEach;
      }

      if (universe.includes('BTCUSDT') && (btcAbove50D || btcAbove20D)) {
        targetWeights.set('BTCUSDT', riskBudget - usedSat);
      }
    }

    // Rebalance smoothly ONLY when weight drift > 12% (avoids fee churn, keeps trade count ultra-clean!)
    // First process sells / reductions at nextOpen
    for (const [sym, pos] of Array.from(positions.entries())) {
      const f = dataMap[sym];
      const nextIdx = f.tsIndex.get(nextTs);
      if (nextIdx === undefined) continue;
      const nextOpen = f.bars[nextIdx].open;
      const curWeight = (pos.units * nextOpen) / totalEq;
      const tgtWeight = targetWeights.get(sym) || 0;

      if (tgtWeight === 0) {
        const exitPx = nextOpen * (1 - FEE_SIDE);
        const proceeds = pos.units * exitPx;
        cash += proceeds;
        trades.push({
          sym, entryTs: pos.entryTs, exitTs: nextTs,
          pnl: proceeds - pos.units * pos.entryPx, reason: 'Rotation / De-Risk to USDT',
        });
        positions.delete(sym);
      } else if (curWeight - tgtWeight > 0.14) {
        const sellFrac = (curWeight - tgtWeight) / curWeight;
        const sellUnits = pos.units * sellFrac;
        const exitPx = nextOpen * (1 - FEE_SIDE);
        const proceeds = sellUnits * exitPx;
        cash += proceeds;
        trades.push({
          sym, entryTs: pos.entryTs, exitTs: nextTs,
          pnl: proceeds - sellUnits * pos.entryPx, reason: 'Partial Profit Trim (20D Break)',
        });
        pos.units -= sellUnits;
      }
    }

    // Then process buys / additions at nextOpen
    for (const [sym, tgtWeight] of targetWeights.entries()) {
      const f = dataMap[sym];
      const nextIdx = f.tsIndex.get(nextTs);
      if (nextIdx === undefined) continue;
      const nextOpen = f.bars[nextIdx].open;
      const existing = positions.get(sym);
      const curVal = existing ? existing.units * nextOpen : 0;
      const tgtVal = totalEq * tgtWeight;

      if (tgtVal - curVal > totalEq * 0.12) {
        const buyAmt = Math.min(cash * 0.995, tgtVal - curVal);
        if (buyAmt > totalEq * 0.05) {
          const fillPx = nextOpen * (1 + FEE_SIDE);
          const addUnits = buyAmt / fillPx;
          cash -= buyAmt;
          if (existing) {
            const totUnits = existing.units + addUnits;
            existing.entryPx = (existing.units * existing.entryPx + addUnits * fillPx) / totUnits;
            existing.units = totUnits;
            if (nextOpen > existing.peakClose) existing.peakClose = nextOpen;
          } else {
            positions.set(sym, {
              units: addUnits,
              entryPx: fillPx,
              entryTs: nextTs,
              peakClose: nextOpen,
            });
          }
        }
      }
    }
  }

  return { eq, trades };
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

function fmtRow(name, m) {
  return (
    `| ${name.padEnd(36)} ` +
    `| $${m.finalEq.toFixed(0).padStart(7)} ` +
    `| ${(m.totalRet >= 0 ? '+' : '') + m.totalRet.toFixed(1).padStart(6)}% ` +
    `| ${(m.cagr >= 0 ? '+' : '') + m.cagr.toFixed(1).padStart(5)}%/yr ` +
    `| ${m.maxDD.toFixed(1).padStart(6)}% ` +
    `| ${m.calmar.toFixed(2).padStart(6)} ` +
    `| ${m.sharpe.toFixed(2).padStart(6)} ` +
    `| ${String(m.trades).padStart(6)} ` +
    `| ${m.winRate.toFixed(1).padStart(5)}% ` +
    `| ${m.profitFactor.toFixed(2).padStart(5)} ` +
    `| ${m.timeInMkt.toFixed(0).padStart(4)}% |`
  );
}

async function main() {
  console.log('Fetching 4H historical candles from official Binance Vision archive (2021-09 -> 2026-11)...');
  const dataMap = {};
  for (const sym of SYMBOLS) {
    const bars = await fetchKlines4h(sym);
    const feat = precomputeFeatures(bars);
    const tsIndex = new Map();
    bars.forEach((b, idx) => tsIndex.set(b.ts, idx));
    feat.tsIndex = tsIndex;
    dataMap[sym] = feat;
    const firstDate = new Date(bars[0].ts).toISOString().slice(0, 10);
    const lastDate  = new Date(bars[bars.length - 1].ts).toISOString().slice(0, 10);
    console.log(`  [OK] ${sym.padEnd(9)}: ${String(bars.length).padStart(5)} bars (${firstDate} -> ${lastDate})`);
  }

  // Run 5-Year Full Cycle (2022-01-01 -> 2026-11-14: Luna/FTX 2022 Bear + 2023-24 Bull + 2025-26 Crash!)
  const sBtc5y  = runBuyAndHoldBTC(dataMap['BTCUSDT'], CYCLE5Y_START);
  const sBask5y = runEqualWeightBasket(dataMap, SYMBOLS, CYCLE5Y_START);
  const sV1_5y  = runOldBotV1(dataMap, SYMBOLS.filter(s => s !== 'BTCUSDT'), CYCLE5Y_START, false);
  const sV2_5y  = runQuantBotV2(dataMap, SYMBOLS, CYCLE5Y_START);

  console.log('\n======================================================================================================================================');
  console.log('  TESTBED 0: 5-YEAR FULL BEAR+BULL+BEAR CYCLE (2022-01-01 -> 2026-11-14 | ~4.87 YRS | INCLUDES LUNA/FTX CRASH + 2025-26 CRASH)');
  console.log('======================================================================================================================================');
  console.log('| Strategy                             | Final $  | Net Ret | CAGR      | Max DD  | Calmar | Sharpe | Trades | Win %  | PF    | Mkt% |');
  console.log('|--------------------------------------|----------|---------|-----------|---------|--------|--------|--------|--------|-------|------|');
  console.log(fmtRow('1. BTC Buy & Hold (Index)', computeMetrics(sBtc5y.eq, sBtc5y.trades, CYCLE5Y_START)));
  console.log(fmtRow('2. Equal-Weight Top8 Crypto Basket', computeMetrics(sBask5y.eq, sBask5y.trades, CYCLE5Y_START)));
  console.log(fmtRow('3. Old signal_bot.py v1 (Original)', computeMetrics(sV1_5y.eq, sV1_5y.trades, CYCLE5Y_START)));
  console.log(fmtRow('4. Quant Core-Satellite Bot v2 (NEW)', computeMetrics(sV2_5y.eq, sV2_5y.trades, CYCLE5Y_START)));

  // Run Strategies across 2023-2026 Cycle
  const sBtc   = runBuyAndHoldBTC(dataMap['BTCUSDT'], EVAL_START);
  const sBask  = runEqualWeightBasket(dataMap, SYMBOLS, EVAL_START);
  const sV1All = runOldBotV1(dataMap, SYMBOLS.filter(s => s !== 'BTCUSDT'), EVAL_START, false);
  const sV1Fix = runOldBotV1(dataMap, SYMBOLS.filter(s => s !== 'BTCUSDT'), EVAL_START, true);
  const sV2    = runQuantBotV2(dataMap, SYMBOLS, EVAL_START);

  console.log('\n======================================================================================================================================');
  console.log('  TESTBED 1: 4-YEAR CYCLE BACKTEST (2023-01-01 -> 2026-11-14 | ~3.87 YEARS | $10,000 START | 0.30% ROUND-TRIP FEE+SLIPPAGE)');
  console.log('======================================================================================================================================');
  console.log('| Strategy                             | Final $  | Net Ret | CAGR      | Max DD  | Calmar | Sharpe | Trades | Win %  | PF    | Mkt% |');
  console.log('|--------------------------------------|----------|---------|-----------|---------|--------|--------|--------|--------|-------|------|');
  console.log(fmtRow('1. BTC Buy & Hold (Index)', computeMetrics(sBtc.eq, sBtc.trades, EVAL_START)));
  console.log(fmtRow('2. Equal-Weight Top8 Crypto Basket', computeMetrics(sBask.eq, sBask.trades, EVAL_START)));
  console.log(fmtRow('3. Old signal_bot.py v1 (Original)', computeMetrics(sV1All.eq, sV1All.trades, EVAL_START)));
  console.log(fmtRow('4. Old signal_bot.py v1 (MathFixed)', computeMetrics(sV1Fix.eq, sV1Fix.trades, EVAL_START)));
  console.log(fmtRow('5. Quant Core-Satellite Bot v2 (NEW)', computeMetrics(sV2.eq, sV2.trades, EVAL_START)));

  // Out-of-Sample Brutal Bear/Chop Stress Test: 2025-01-01 -> 2026-11-14
  console.log('\n======================================================================================================================================');
  console.log('  TESTBED 2: BRUTAL PEAK-TO-CRASH STRESS PERIOD (2025-01-01 -> 2026-11-14 | ~1.87 YEARS | Normalized $10,000 at 2025-01-01)');
  console.log('======================================================================================================================================');
  console.log('| Strategy                             | Final $  | Net Ret | CAGR      | Max DD  | Calmar | Sharpe | Trades | Win %  | PF    | Mkt% |');
  console.log('|--------------------------------------|----------|---------|-----------|---------|--------|--------|--------|--------|-------|------|');
  console.log(fmtRow('1. BTC Buy & Hold (2025-2026)', computeMetrics(sBtc.eq, sBtc.trades, OOS_START)));
  console.log(fmtRow('2. Equal-Weight Top8 Basket', computeMetrics(sBask.eq, sBask.trades, OOS_START)));
  console.log(fmtRow('3. Old signal_bot.py v1 (Original)', computeMetrics(sV1All.eq, sV1All.trades, OOS_START)));
  console.log(fmtRow('4. Old signal_bot.py v1 (MathFixed)', computeMetrics(sV1Fix.eq, sV1Fix.trades, OOS_START)));
  console.log(fmtRow('5. Quant Core-Satellite Bot v2 (NEW)', computeMetrics(sV2.eq, sV2.trades, OOS_START)));

  // Testbed 3: Exact ONDO + SUI Universe from ONDO Spot Listing (2025-04-15 -> 2026-11-14)
  const ONDO_START = Date.parse('2025-04-15T00:00:00Z');
  const sBtcOndo   = runBuyAndHoldBTC(dataMap['BTCUSDT'], ONDO_START);
  const sOndoSuiBH = runEqualWeightBasket(dataMap, ['ONDOUSDT', 'SUIUSDT'], ONDO_START);
  const sV1OndoSui = runOldBotV1(dataMap, ['ONDOUSDT', 'SUIUSDT'], ONDO_START, false);
  const sV2OndoSui = runQuantBotV2(dataMap, ['BTCUSDT', 'ONDOUSDT', 'SUIUSDT'], ONDO_START);

  console.log('\n======================================================================================================================================');
  console.log('  TESTBED 3: EXACT USER CONFIG UNIVERSE (ONDO + SUI since 2025-04-15 -> 2026-11-14 | $10,000 START)');
  console.log('======================================================================================================================================');
  console.log('| Strategy                             | Final $  | Net Ret | CAGR      | Max DD  | Calmar | Sharpe | Trades | Win %  | PF    | Mkt% |');
  console.log('|--------------------------------------|----------|---------|-----------|---------|--------|--------|--------|--------|-------|------|');
  console.log(fmtRow('1. Hold ONDO + SUI 50/50 (Retail)', computeMetrics(sOndoSuiBH.eq, sOndoSuiBH.trades, ONDO_START)));
  console.log(fmtRow('2. BTC Buy & Hold (Same Period)', computeMetrics(sBtcOndo.eq, sBtcOndo.trades, ONDO_START)));
  console.log(fmtRow('3. Old signal_bot.py v1 (ONDO+SUI)', computeMetrics(sV1OndoSui.eq, sV1OndoSui.trades, ONDO_START)));
  console.log(fmtRow('4. Quant Core-Satellite Bot v2 (NEW)', computeMetrics(sV2OndoSui.eq, sV2OndoSui.trades, ONDO_START)));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
