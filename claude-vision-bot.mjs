// ═══════════════════════════════════════════════════════════
//  CLAUDE VISION SCALP BOT v4 — XAU/USD
//  Fetches candle data from TwelveData
//  Builds chart via quickchart.io POST (fixes 400 error)
//  Sends image to Claude Vision API
//  Full conversation memory
// ═══════════════════════════════════════════════════════════

import fs   from "fs";
import path from "path";

const TG_TOKEN       = process.env.TG_TOKEN;
const TG_CHAT        = process.env.TG_CHAT;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;
const STATE_FILE     = path.resolve("./vision_bot_state.json");

// ── Load / save memory ───────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch {}
  }
  return { history: [], lastSignal: null, signalsToday: 0, lastDate: "", lastAction: "none" };
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Fetch candles ────────────────────────────────────────
async function fetchCandles(interval = "5min", count = 50) {
  const url  = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${count}&apikey=${TWELVEDATA_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error("TwelveData: " + JSON.stringify(data));
  return data.values.reverse();
}

// ── EMA ──────────────────────────────────────────────────
function computeEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = [];
  let val = closes[0];
  for (let i = 0; i < closes.length; i++) {
    val = i === 0 ? closes[0] : closes[i] * k + val * (1 - k);
    result.push(i < period - 1 ? null : parseFloat(val.toFixed(2)));
  }
  return result;
}

// ── ATR / RSI ────────────────────────────────────────────
function computeATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const h = parseFloat(c.high), l = parseFloat(c.low), pc = parseFloat(candles[i].close);
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  return (trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2);
}
function computeRSI(closes, period = 14) {
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return (100 - 100 / (1 + g / (l || 0.001))).toFixed(1);
}

// ── Build chart image (POST to quickchart) ───────────────
async function buildChartImage(candles) {
  const slice  = candles.slice(-40);
  const labels = slice.map(c => c.datetime.slice(11, 16));
  const closes = slice.map(c => parseFloat(c.close));
  const highs  = slice.map(c => parseFloat(c.high));
  const lows   = slice.map(c => parseFloat(c.low));
  const ema21  = computeEMA(closes, 21);
  const ema50  = computeEMA(closes, 50);

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label      : "High",
          data       : highs,
          borderColor: "#4caf50",
          borderWidth: 1,
          pointRadius: 0,
          fill       : "+1",
          backgroundColor: "rgba(38,166,154,0.08)",
          tension    : 0.1
        },
        {
          label      : "Low",
          data       : lows,
          borderColor: "#ef5350",
          borderWidth: 1,
          pointRadius: 0,
          fill       : false,
          tension    : 0.1
        },
        {
          label      : "Close",
          data       : closes,
          borderColor: "#ffffff",
          borderWidth: 2,
          pointRadius: 0,
          fill       : false,
          tension    : 0.1
        },
        {
          label      : "EMA21",
          data       : ema21,
          borderColor: "#FFD700",
          borderWidth: 2,
          pointRadius: 0,
          fill       : false,
          tension    : 0.3
        },
        {
          label      : "EMA50",
          data       : ema50,
          borderColor: "#FF8C00",
          borderWidth: 2,
          pointRadius: 0,
          fill       : false,
          tension    : 0.3
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text   : `XAU/USD 5M — ${new Date().toUTCString()}`,
          color  : "#fff",
          font   : { size: 14 }
        },
        legend: { labels: { color: "#fff", boxWidth: 12 } }
      },
      scales: {
        x: {
          ticks: { color: "#aaa", maxTicksLimit: 8, maxRotation: 0 },
          grid : { color: "rgba(255,255,255,0.05)" }
        },
        y: {
          ticks   : { color: "#aaa" },
          grid    : { color: "rgba(255,255,255,0.05)" },
          position: "right"
        }
      }
    }
  };

  console.log("Building chart via quickchart.io POST...");
  const res = await fetch("https://quickchart.io/chart", {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({
      chart          : chartConfig,
      width          : 900,
      height         : 500,
      backgroundColor: "#1a1a2e",
      format         : "png"
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`quickchart failed ${res.status}: ${err.slice(0, 200)}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  console.log(`Chart ready (${Math.round(base64.length / 1024)}KB)`);
  return base64;
}

// ── Market summary text ──────────────────────────────────
function buildSummary(candles) {
  const last    = candles[candles.length - 1];
  const closes  = candles.map(c => parseFloat(c.close));
  const current = parseFloat(last.close);
  const ema21v  = computeEMA(closes, 21);
  const ema50v  = computeEMA(closes, 50);
  const atr     = computeATR(candles);
  const rsi     = computeRSI(closes);
  const high20  = Math.max(...candles.slice(-20).map(c => parseFloat(c.high))).toFixed(2);
  const low20   = Math.min(...candles.slice(-20).map(c => parseFloat(c.low))).toFixed(2);
  const e21     = ema21v[ema21v.length - 1];
  const e50     = ema50v[ema50v.length - 1];

  return `${last.datetime} UTC | Price:${current} H:${last.high} L:${last.low} | EMA21:${e21} EMA50:${e50} | Trend:${e21 > e50 ? "BULL" : "BEAR"} | RSI:${rsi} ATR:${atr} | 20-bar H:${high20} L:${low20}`;
}

// ── Claude Vision call ───────────────────────────────────
async function callClaude(state, imageBase64, summary) {
  const system = `You are an expert XAU/USD scalp trader acting as a live signal provider. Every 5 minutes you get a live chart image (Close=white, High=green, Low=red, EMA21=yellow, EMA50=orange) plus real-time stats.

Your job is to identify HIGH confluence setups and provide PRECISE limit orders. Think like an ICT/Smart Money trader.

ANALYSIS:
- Trend: EMA21 vs EMA50, structure of highs/lows
- Nearest swing high and swing low
- Liquidity sweep: wick beyond a level that closed back?
- Break of structure (BOS) or change of character (CHoCH)?
- Order block: last opposing candle before a big move
- RSI: overbought/oversold?
- Risk:reward minimum 1:2

ENTRY RULES:
- BUY LIMIT: place BELOW current price at demand zone / OB / swept low
- SELL LIMIT: place ABOVE current price at supply zone / OB / swept high  
- Never chase price — always wait for it to come to you
- No clean setup = WAIT

SL RULES:
- BUY SL: below the swing low or OB that was swept
- SELL SL: above the swing high or OB that was swept
- SL must be beyond structure, not arbitrary pips

TP RULES:
- TP1: nearest opposing structure (quick partial)
- TP2: next major level (let runners go)

MEMORY: Remember all signals this session. If last signal still active, say so and WAIT unless stronger setup appears. Max 3 signals per day.

ALWAYS respond in EXACTLY this format — no extra text:
SIGNAL: [BUY LIMIT / SELL LIMIT / WAIT]
ENTRY: [exact price]
TP1: [exact price]
TP2: [exact price]
SL: [exact price]
RR: [e.g. 1:2.5]
REASON: [3-4 sentences — trend, structure, entry logic, key level]
CONFIDENCE: [LOW / MEDIUM / HIGH]

If WAIT:
SIGNAL: WAIT
REASON: [exactly what you are waiting for and at what price level]`;

  const messages = [
    ...state.history.map(h => ({ role: h.role, content: h.content })),
    {
      role   : "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
        { type: "text",  text: `Live XAU/USD 5M. Stats: ${summary}. Analyze and signal.` }
      ]
    }
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method : "POST",
    headers: {
      "Content-Type"      : "application/json",
      "x-api-key"         : ANTHROPIC_KEY,
      "anthropic-version" : "2023-06-01"
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 600, system, messages })
  });

  const data = await res.json();
  if (!data.content) throw new Error("Claude: " + JSON.stringify(data));
  return data.content[0].text;
}

// ── Telegram ─────────────────────────────────────────────
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" })
  });
  const d = await res.json();
  if (!d.ok) throw new Error("Telegram: " + JSON.stringify(d));
}

// ── Format signal ────────────────────────────────────────
function formatSignal(r) {
  // normalize signal text
  r = r.replace("BUY LIMIT", "BUY LIMIT").replace("SELL LIMIT", "SELL LIMIT");
  if (r.includes("SIGNAL: WAIT")) {
    const reason = r.match(/REASON:\s*([^\n]+)/)?.[1] || "";
    return { isWait: true, text: `⏳ <b>XAUUSD WAIT</b>\n📝 ${reason}\n\n⚠️ Not financial advice` };
  }
  const sigFull = r.match(/SIGNAL:\s*(BUY LIMIT|SELL LIMIT|BUY|SELL)/)?.[1] || "?";
  const sig  = sigFull;
  const ent  = r.match(/ENTRY:\s*([^\n]+)/)?.[1]      || "?";
  const tp1  = r.match(/TP1:\s*([^\n]+)/)?.[1]        || "?";
  const tp2  = r.match(/TP2:\s*([^\n]+)/)?.[1]        || "?";
  const sl   = r.match(/SL:\s*([^\n]+)/)?.[1]         || "?";
  const rsn  = r.match(/REASON:\s*([^\n]+)/)?.[1]     || "?";
  const rr   = r.match(/RR:\s*([^\n]+)/)?.[1]         || "?";
  const conf = r.match(/CONFIDENCE:\s*([^\n]+)/)?.[1] || "?";
  const e    = sig.includes("BUY") ? "🟢" : "🔴";
  const ce   = conf === "HIGH" ? "🔥" : conf === "MEDIUM" ? "⚡" : "⚠️";
  return {
    isWait: false, signal: sig,
    text: `${e} <b>XAUUSD ${sig}</b>\n🕐 ${new Date().toUTCString()}\n━━━━━━━━━━━━━━━\n🎯 Entry : <b>${ent}</b>\n✅ TP1   : <b>${tp1}</b>\n✅ TP2   : <b>${tp2}</b>\n❌ SL    : <b>${sl}</b>\n📊 R:R   : <b>${rr}</b>\n━━━━━━━━━━━━━━━\n${ce} Confidence: <b>${conf}</b>\n📝 ${rsn}\n\n⚠️ Not financial advice`
  };
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log(`\n[${new Date().toISOString()}] Claude Vision Bot v4 starting...`);
  const state = loadState();

  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDate !== today) { state.signalsToday = 0; state.lastDate = today; console.log("New day — reset."); }
  if (state.signalsToday >= 3)  { console.log("Max 3 signals today. Done."); return; }

  const candles  = await fetchCandles("5min", 50);
  const summary  = buildSummary(candles);
  const image    = await buildChartImage(candles);

  console.log("Stats:", summary);
  console.log("Calling Claude Vision...");

  const response = await callClaude(state, image, summary);
  console.log("Claude:\n", response);

  state.history.push({ role: "user",      content: `[Chart ${new Date().toUTCString()}] ${summary}` });
  state.history.push({ role: "assistant", content: response });
  if (state.history.length > 60) state.history = state.history.slice(-60);

  const { isWait, signal, text } = formatSignal(response);
  if (!isWait) {
    state.signalsToday++;
    state.lastSignal = { time: new Date().toISOString(), signal, response };
    await sendTelegram(text);
    console.log(`✅ ${signal} sent! (${state.signalsToday}/3 today)`);
  } else {
    console.log("WAIT — no Telegram.");
  }

  saveState(state);
  console.log("Done.");
}

main().catch(async err => {
  console.error("❌ Error:", err.message);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ chat_id: TG_CHAT, text: `❌ Bot error: ${err.message}` })
    });
  } catch {}
});
