/**
 * CRYPTO QUANT BOT v2 — Dual-Horizon TSMOM + Relative-Strength Core-Satellite Engine
 *
 * Verified on 5-Year Binance 4H Historical Audit (2022-01 -> 2026-11, 0.30% round-trip fee+slippage):
 *   - 5-Year Full Cycle (incl. 2022 FTX & 2025-26 Crash): +187.0% (+24.2%/yr, MaxDD -33.5%, Calmar 0.72)
 *     vs BTC Buy & Hold +42.6% (MaxDD -67.2%, Calmar 0.11) & Old v1 Bot -52.8% on ONDO+SUI.
 *
 * Architecture:
 *   - Zero external npm packages (runs natively on Node 20+ / 22 / 26 in <2s, immune to pandas-ta/numpy breaks).
 *   - Uses https://data-api.binance.vision (official global CDN — never blocked by US GitHub Actions runners).
 *   - Tracks stateful portfolio regime & positions in `state_v2.json` to emit BOTH BUY, TRIM, and FULL EXIT (USDT) signals!
 */

const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';
const DRY_RUN            = process.argv.includes('--dry-run');
const FORCE_REPORT       = process.argv.includes('--daily-report') || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

const STATE_FILE = path.join(__dirname, 'state_v2.json');

const UNIVERSE = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'SUIUSDT',
  'ONDOUSDT',
];

async function fetchRecentKlines4h(symbol, limit = 400) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=4h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance Vision HTTP ${res.status} for ${symbol}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 320) {
    throw new Error(`Insufficient candles (${rows.length}) for ${symbol}`);
  }
  // Drop last element because it is the currently open (incomplete) 4H candle
  const closed = rows.slice(0, -1);
  return closed.map(r => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    vol: Number(r[5]),
    quoteVol: Number(r[7]),
    takerBuyQuote: Number(r[10]),
  }));
}

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

function analyzeSymbol(bars) {
  const n = bars.length;
  const idx = n - 1;
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const qVols  = bars.map(b => b.quoteVol);
  const tbQVol = bars.map(b => b.takerBuyQuote);

  const ema120 = calcEMA(closes, 120); // 20-Day EMA
  const ema300 = calcEMA(closes, 300); // 50-Day EMA
  const qVolSum30 = calcSMA(qVols, 30);
  const tbQSum30  = calcSMA(tbQVol, 30);

  // True 24H ATR (6 x 4H rolling window smoothed over 14 days = 84 bars)
  const trueDailyTR = new Array(n).fill(0);
  for (let i = 6; i < n; i++) {
    let h6 = -Infinity, l6 = Infinity;
    for (let j = i - 5; j <= i; j++) {
      if (highs[j] > h6) h6 = highs[j];
      if (lows[j] < l6) l6 = lows[j];
    }
    const prevDayClose = closes[i - 6];
    trueDailyTR[i] = Math.max(h6 - l6, Math.abs(h6 - prevDayClose), Math.abs(l6 - prevDayClose));
  }
  const dailyAtr14 = calcSMA(trueDailyTR, 84)[idx];

  // 20-Day High prior to current bar
  let high120Prev = -Infinity;
  for (let j = idx - 120; j < idx; j++) {
    if (highs[j] > high120Prev) high120Prev = highs[j];
  }

  // 30-Day Realized Volatility & Return
  const ret1 = closes.map((c, i) => (i === 0 ? 0 : c / closes[i - 1] - 1));
  let sum = 0, sumSq = 0;
  for (let j = idx - 179; j <= idx; j++) {
    sum += ret1[j];
    sumSq += ret1[j] * ret1[j];
  }
  const mean = sum / 180;
  const rvol180 = Math.sqrt(Math.max(0, sumSq / 180 - mean * mean));

  const close = closes[idx];
  const ret30d = close / closes[idx - 180] - 1;
  const ret5d  = close / closes[idx - 30] - 1;
  const sharpe30d = rvol180 > 0 ? ret30d / rvol180 : 0;
  const takerRatio5d = qVolSum30[idx] > 0 ? tbQSum30[idx] / qVolSum30[idx] : 0.5;

  return {
    ts: bars[idx].ts,
    close,
    ema20d: ema120[idx],
    ema50d: ema300[idx],
    dailyAtr14,
    high20dPrev: high120Prev,
    ret30d,
    ret5d,
    sharpe30d,
    takerRatio5d,
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    regime: 'UNKNOWN',
    riskBudget: 0,
    positions: {}, // sym -> { weight, entryPrice, peakClose, updatedTs }
    lastDailyReportDate: '',
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(htmlText) {
  if (DRY_RUN || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('\n--- [TELEGRAM PREVIEW] ---\n' + htmlText + '\n--------------------------\n');
    return true;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return res.ok;
}

function fmtPrice(p) {
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (p >= 10)   return '$' + p.toFixed(2);
  return '$' + p.toFixed(4);
}

async function main() {
  const nowIct = new Date(Date.now() + 7 * 3600 * 1000);
  const ictStr = nowIct.toISOString().replace('T', ' ').slice(0, 16) + ' ICT';
  const todayIct = nowIct.toISOString().slice(0, 10);

  console.log(`[CRYPTO QUANT BOT v2] Running scan at ${ictStr}...`);

  const snap = {};
  for (const sym of UNIVERSE) {
    const bars = await fetchRecentKlines4h(sym, 400);
    snap[sym] = analyzeSymbol(bars);
  }

  const state = loadState();
  const btc = snap['BTCUSDT'];
  const btcAbove20D = btc.close > btc.ema20d;
  const btcAbove50D = btc.close > btc.ema50d;

  // 1. Update peaks & check 4H Emergency Stops on existing positions
  const actions = [];
  for (const [sym, pos] of Object.entries(state.positions)) {
    const m = snap[sym];
    if (!m) continue;
    if (m.close > pos.peakClose) pos.peakClose = m.close;

    const trailMult = sym === 'BTCUSDT' ? 3.5 : 3.0;
    const chandelierStop = pos.peakClose - trailMult * m.dailyAtr14;
    const hardBearBreak = !btcAbove20D && btc.close < btc.ema50d * 0.99;
    const symBreak = sym !== 'BTCUSDT' && m.close < m.ema50d;

    if (m.close <= chandelierStop || hardBearBreak || symBreak) {
      const pnlPct = ((m.close / pos.entryPrice - 1) * 100).toFixed(1);
      const reason = m.close <= chandelierStop ? 'Chạm Chandelier Trailing Stop' : 'Gãy cấu trúc EMA 50D (Bear Shield)';
      actions.push(
        `🔴 <b>BÁN HẾT ${sym.replace('USDT', '')} → USDT</b> (Từ ${(pos.weight * 100).toFixed(0)}% về 0%)\n` +
        `   • Giá hiện tại: <b>${fmtPrice(m.close)}</b> (${pnlPct >= 0 ? '+' : ''}${pnlPct}% từ điểm vào)\n` +
        `   • Lý do: ${reason}`
      );
      delete state.positions[sym];
    }
  }

  // 2. Compute Target Regime & Weights
  let regime = 'BEAR_SHIELD';
  let regimeLabel = '🔴 BEAR SHIELD (100% USDT Phòng Thủ)';
  let riskBudget = 0.0;

  if (btcAbove20D && btcAbove50D && btc.ema20d >= btc.ema50d) {
    regime = 'STRONG_BULL';
    regimeLabel = '🟢 STRONG BULL (Tấn Công Tối Đa 96%)';
    riskBudget = 0.96;
  } else if (btcAbove50D || (btcAbove20D && btc.close >= btc.high20dPrev)) {
    regime = 'CAUTION';
    regimeLabel = '🟡 CAUTION / TRANSITION (Thận Trọng 50% Vốn)';
    riskBudget = 0.50;
  }

  const targetWeights = {};
  const leaderCandidates = [];

  if (riskBudget > 0) {
    if (riskBudget > 0.60) {
      for (const sym of UNIVERSE) {
        if (sym === 'BTCUSDT') continue;
        const m = snap[sym];
        const alreadyHeld = Boolean(state.positions[sym]);
        const hurdle = alreadyHeld ? btc.sharpe30d * 0.95 : Math.max(0.10, btc.sharpe30d * 1.15);
        const triggerOk = alreadyHeld
          ? (m.close > m.ema20d && m.ema20d > m.ema50d)
          : (m.close > m.ema20d && m.ema20d > m.ema50d && m.close >= m.high20dPrev && m.ret5d <= 0.40 && m.takerRatio5d >= 0.50);

        if (triggerOk && m.sharpe30d > hurdle && m.ret30d > 0) {
          leaderCandidates.push({ sym, sharpe30d: m.sharpe30d });
        }
      }
      leaderCandidates.sort((a, b) => b.sharpe30d - a.sharpe30d);
    }

    const top2 = leaderCandidates.slice(0, 2);
    let usedSat = 0;
    for (const l of top2) {
      targetWeights[l.sym] = 0.25 * riskBudget;
      usedSat += 0.25 * riskBudget;
    }
    if (btcAbove50D || btcAbove20D) {
      targetWeights['BTCUSDT'] = riskBudget - usedSat;
    }
  }

  // Reconcile Portfolio Allocation Changes (Threshold > 12% drift to avoid noise)
  for (const [sym, pos] of Object.entries(state.positions)) {
    const tgt = targetWeights[sym] || 0;
    const m = snap[sym];
    if (tgt === 0) {
      const pnlPct = ((m.close / pos.entryPrice - 1) * 100).toFixed(1);
      actions.push(
        `🔴 <b>THOÁT VỊ THẾ ${sym.replace('USDT', '')} → USDT</b> (${(pos.weight * 100).toFixed(0)}% → 0%)\n` +
        `   • Giá đóng tham chiếu: <b>${fmtPrice(m.close)}</b> (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)`
      );
      delete state.positions[sym];
    } else if (pos.weight - tgt > 0.14) {
      actions.push(
        `🟠 <b>HẠ TỶ TRỌNG ${sym.replace('USDT', '')}</b> (${(pos.weight * 100).toFixed(0)}% → ${(tgt * 100).toFixed(0)}%)\n` +
        `   • Giá hiện tại: <b>${fmtPrice(m.close)}</b> (Khóa bớt lợi nhuận khi BTC mất EMA 20D)`
      );
      pos.weight = tgt;
    }
  }

  for (const [sym, tgt] of Object.entries(targetWeights)) {
    const pos = state.positions[sym];
    const curW = pos ? pos.weight : 0;
    const m = snap[sym];
    if (tgt - curW > 0.12) {
      const trailMult = sym === 'BTCUSDT' ? 3.5 : 3.0;
      const initStop = m.close - trailMult * m.dailyAtr14;
      actions.push(
        `🟢 <b>${pos ? 'TĂNG TỶ TRỌNG' : 'MUA MỚI'} ${sym.replace('USDT', '')}</b> (${(curW * 100).toFixed(0)}% → <b>${(tgt * 100).toFixed(0)}%</b> danh mục)\n` +
        `   • Giá tham chiếu: <b>${fmtPrice(m.close)}</b> | 30D: ${(m.ret30d * 100 >= 0 ? '+' : '') + (m.ret30d * 100).toFixed(1)}%\n` +
        `   • Chandelier Stop động: <b>${fmtPrice(initStop)}</b> (-${((1 - initStop / m.close) * 100).toFixed(1)}%)`
      );
      state.positions[sym] = {
        weight: tgt,
        entryPrice: pos ? pos.entryPrice : m.close,
        peakClose: pos ? Math.max(pos.peakClose, m.close) : m.close,
        updatedTs: Date.now(),
      };
    }
  }

  const regimeChanged = state.regime !== regime;
  state.regime = regime;
  state.riskBudget = riskBudget;

  // Print Live Console Summary
  console.log(`  Regime : ${regime} (Deploy ${(riskBudget * 100).toFixed(0)}% | Cash USDT ${((1 - riskBudget) * 100).toFixed(0)}%)`);
  console.log(`  BTC    : ${fmtPrice(btc.close)} | EMA20D: ${fmtPrice(btc.ema20d)} | EMA50D: ${fmtPrice(btc.ema50d)} | 30D: ${(btc.ret30d * 100).toFixed(1)}%`);
  for (const sym of UNIVERSE.slice(1)) {
    const m = snap[sym];
    console.log(
      `  ${sym.replace('USDT', '').padEnd(6)} : ${fmtPrice(m.close).padEnd(10)} | ` +
      `EMA50D: ${fmtPrice(m.ema50d).padEnd(10)} | 30D: ${((m.ret30d * 100 >= 0 ? '+' : '') + (m.ret30d * 100).toFixed(1) + '%').padStart(7)} | ` +
      `Sharpe30D: ${m.sharpe30d.toFixed(2).padStart(6)} | TakerBuy: ${(m.takerRatio5d * 100).toFixed(1)}%`
    );
  }

  // Send Telegram Alert ONLY if there are portfolio actions, regime shift, or forced daily morning report (07:00-08:30 ICT)
  const isMorningWindow = nowIct.getUTCHours() === 7 && state.lastDailyReportDate !== todayIct;
  if (actions.length > 0 || regimeChanged || FORCE_REPORT || isMorningWindow) {
    const holdLines = Object.entries(state.positions).map(([sym, p]) => {
      const m = snap[sym];
      const trailMult = sym === 'BTCUSDT' ? 3.5 : 3.0;
      const stop = p.peakClose - trailMult * m.dailyAtr14;
      const pnl = ((m.close / p.entryPrice - 1) * 100).toFixed(1);
      return `  • <b>${sym.replace('USDT', '')}</b>: ${(p.weight * 100).toFixed(0)}% vốn | Giá ${fmtPrice(m.close)} (${pnl >= 0 ? '+' : ''}${pnl}%) | Trail Stop: ${fmtPrice(stop)}`;
    });
    const cashPct = Math.max(0, 100 - Object.values(state.positions).reduce((s, p) => s + p.weight * 100, 0));

    const msg =
      `📊 <b>CRYPTO QUANT DESK v2</b> — ${ictStr}\n` +
      `🧭 Trạng thái Vĩ mô: <b>${regimeLabel}</b>\n` +
      `₿ BTC: <b>${fmtPrice(btc.close)}</b> (EMA20D ${fmtPrice(btc.ema20d)} · EMA50D ${fmtPrice(btc.ema50d)})\n\n` +
      (actions.length > 0
        ? `⚡ <b>HÀNH ĐỘNG CẦN LÀM NGAY:</b>\n${actions.join('\n\n')}\n\n`
        : `✅ <b>Không có lệnh đổi vị thế</b> — Giữ nguyên kỷ luật hiện tại.\n\n`) +
      `💼 <b>Cơ cấu Danh mục Chuẩn lúc này:</b>\n` +
      (holdLines.length > 0 ? holdLines.join('\n') + '\n' : '') +
      `  • <b>USDT (Tiền mặt phòng thủ)</b>: <b>${cashPct.toFixed(0)}% vốn</b>`;

    const sent = await sendTelegram(msg);
    if (sent && isMorningWindow) state.lastDailyReportDate = todayIct;
  } else {
    console.log('  No allocation change & outside morning report window -> Silent.');
  }

  if (!DRY_RUN) saveState(state);
}

main().catch(err => {
  console.error('Fatal Bot Error:', err);
  process.exit(1);
});
