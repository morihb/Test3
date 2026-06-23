// ═══════════════════════════════════════════════════════════
//  CLAUDE VISION SCALP BOT v2 — XAU/USD
//  Fetches candle data from TwelveData
//  Builds chart image using quickchart.io (free, no auth)
//  Sends image to Claude Vision API
//  Claude analyzes exactly like reading a real chart
//  Signal → Telegram with full memory
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

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Fetch candles from TwelveData ────────────────────────
async function fetchCandles(interval = "5min", count = 60) {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${count}&apikey=${TWELVEDATA_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error("TwelveData error: " + JSON.stringify(data));
  return data.values.reverse(); // oldest → newest
}

// ── Build chart image via quickchart.io ──────────────────
async function buildChartImage(candles) {
  const labels = candles.map(c => c.datetime.slice(11, 16)); // HH:MM

  // OHLC data for candlestick
  const ohlc = candles.map(c => ({
    x: c.datetime.slice(11, 16),
    o: parseFloat(c.open),
    h: parseFloat(c.high),
    l: parseFloat(c.low),
    c: parseFloat(c.close)
  }));

  // EMA 21 & 50
  const closes = candles.map(c => parseFloat(c.close));
  const ema21  = computeEMA(closes, 21);
  const ema50  = computeEMA(closes, 50);

  const chartConfig = {
    type: "candlestick",
    data: {
      datasets: [
        {
          label          : "XAU/USD",
          data           : ohlc,
          color          : { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
          borderColor    : { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
          wickColor      : { up: "#26a69a", down: "#ef5350" }
        },
        {
          type       : "line",
          label      : "EMA21",
          data       : ema21,
          borderColor: "#FFD700",
          borderWidth: 1.5,
          pointRadius: 0,
          fill       : false,
          tension    : 0.3
        },
        {
          type       : "line",
          label      : "EMA50",
          data       : ema50,
          borderColor: "#FF8C00",
          borderWidth: 1.5,
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
          color  : "#ffffff"
        },
        legend: { labels: { color: "#ffffff" } }
      },
      scales: {
        x: { ticks: { color: "#aaa", maxTicksLimit: 10 } },
        y: { ticks: { color: "#aaa" }, position: "right" }
      },
      backgroundColor: "#1a1a2e"
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  const chartUrl = `https://quickchart.io/chart?c=${encoded}&width=900&height=500&backgroundColor=%231a1a2e`;

  console.log("Fetching chart image from quickchart.io...");
  const res = await fetch(chartUrl);
  if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  console.log(`Chart image ready (${Math.round(base64.length / 1024)}KB)`);
  return base64;
}

// ── EMA calculation ──────────────────────────────────────
function computeEMA(closes, period) {
  const k      = 2 / (period + 1);
  const result = [];
  let val      = closes[0];
  for (let i = 0; i < closes.length; i++) {
    val = i === 0 ? closes[0] : closes[i] * k + val * (1 - k);
    result.push(i < period - 1 ? null : parseFloat(val.toFixed(3)));
  }
  return result;
}

// ── Build text summary to accompany image ────────────────
function buildSummary(candles) {
  const last    = candles[candles.length - 1];
  const closes  = candles.map(c => parseFloat(c.close));
  const highs   = candles.map(c => parseFloat(c.high));
  const lows    = candles.map(c => parseFloat(c.low));
  const current = parseFloat(last.close);

  // ATR
  const trs = candles.slice(1).map((c, i) => {
    const h = parseFloat(c.high), l = parseFloat(c.low), pc = parseFloat(candles[i].close);
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const atr = (trs.slice(-14).reduce((a, b) => a + b, 0) / 14).toFixed(2);

  // RSI
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rsi = (100 - 100 / (1 + gains / (losses || 0.001))).toFixed(1);

  const recentHigh = Math.max(...highs.slice(-20)).toFixed(2);
  const recentLow  = Math.min(...lows.slice(-20)).toFixed(2);

  const ema21arr = computeEMA(closes, 21);
  const ema50arr = computeEMA(closes, 50);
  const ema21    = ema21arr[ema21arr.length - 1];
  const ema50    = ema50arr[ema50arr.length - 1];

  return `Time: ${last.datetime} UTC | Price: ${current} | High: ${last.high} | Low: ${last.low}
EMA21: ${ema21} | EMA50: ${ema50} | Trend: ${ema21 > ema50 ? "BULLISH" : "BEARISH"}
RSI(14): ${rsi} | ATR(14): ${atr}
20-bar High: ${recentHigh} | 20-bar Low: ${recentLow}`;
}

// ── Call Claude Vision with image + memory ───────────────
async function callClaudeVision(state, imageBase64, summary) {
  const systemPrompt = `You are an expert XAU/USD scalp trader. Every 5 minutes you receive a live candlestick chart image with EMA21 (yellow) and EMA50 (orange) overlaid, plus key market stats.

Analyze exactly like a professional ICT/price action trader:
- Read trend direction from EMAs and candle structure
- Identify key levels: swing highs/lows, support/resistance, order blocks
- Read momentum: candle size, wicks, speed of moves
- Check if there was a liquidity sweep followed by structure break
- Factor in your previous signals from this session (in conversation history)
- Only signal when you see REAL confluence — not every candle
- Give LIMIT entry at a better price when possible
- Base TP and SL on actual chart structure levels
- Max 3 signals per day — quality over quantity

ALWAYS respond in this exact format:
SIGNAL: [BUY / SELL / WAIT]
ENTRY: [price]
TP1: [price]
TP2: [price]
SL: [price]
REASON: [2-3 sentences max]
CONFIDENCE: [LOW / MEDIUM / HIGH]

If WAIT:
SIGNAL: WAIT
REASON: [what specifically you are waiting for]`;

  const historyMessages = state.history.map(h => ({
    role   : h.role,
    content: h.content
  }));

  const currentMessage = {
    role   : "user",
    content: [
      {
        type  : "image",
        source: { type: "base64", media_type: "image/png", data: imageBase64 }
      },
      {
        type: "text",
        text: `Live XAU/USD 5M chart. Stats: ${summary}\n\nAnalyze and give your signal.`
      }
    ]
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method : "POST",
    headers: {
      "Content-Type"      : "application/json",
      "x-api-key"         : ANTHROPIC_KEY,
      "anthropic-version" : "2023-06-01"
    },
    body: JSON.stringify({
      model     : "claude-sonnet-4-6",
      max_tokens: 600,
      system    : systemPrompt,
      messages  : [...historyMessages, currentMessage]
    })
  });

  const data = await res.json();
  if (!data.content) throw new Error("Claude API error: " + JSON.stringify(data));
  return data.content[0].text;
}

// ── Send Telegram message ────────────────────────────────
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" })
  });
  const data = await res.json();
  if (!data.ok) throw new Error("Telegram error: " + JSON.stringify(data));
}

// ── Format signal for Telegram ───────────────────────────
function formatSignal(claudeResponse) {
  const isWait = claudeResponse.includes("SIGNAL: WAIT");
  if (isWait) {
    const reason = claudeResponse.match(/REASON:\s*([^\n]+)/)?.[1] || "";
    return { isWait: true, text: `⏳ <b>XAUUSD — WAIT</b>\n📝 ${reason}\n\n⚠️ Not financial advice` };
  }

  const signal     = claudeResponse.match(/SIGNAL:\s*(BUY|SELL)/)?.[1]  || "?";
  const entry      = claudeResponse.match(/ENTRY:\s*([^\n]+)/)?.[1]      || "?";
  const tp1        = claudeResponse.match(/TP1:\s*([^\n]+)/)?.[1]        || "?";
  const tp2        = claudeResponse.match(/TP2:\s*([^\n]+)/)?.[1]        || "?";
  const sl         = claudeResponse.match(/SL:\s*([^\n]+)/)?.[1]         || "?";
  const reason     = claudeResponse.match(/REASON:\s*([^\n]+)/)?.[1]     || "?";
  const confidence = claudeResponse.match(/CONFIDENCE:\s*([^\n]+)/)?.[1] || "?";

  const emoji     = signal === "BUY" ? "🟢" : "🔴";
  const confEmoji = confidence === "HIGH" ? "🔥" : confidence === "MEDIUM" ? "⚡" : "⚠️";

  return {
    isWait: false,
    signal,
    text: `${emoji} <b>XAUUSD ${signal} SIGNAL</b>
🕐 ${new Date().toUTCString()}
━━━━━━━━━━━━━━━
🎯 Entry : <b>${entry}</b>
✅ TP1   : <b>${tp1}</b>
✅ TP2   : <b>${tp2}</b>
❌ SL    : <b>${sl}</b>
━━━━━━━━━━━━━━━
${confEmoji} Confidence: <b>${confidence}</b>
📝 ${reason}

⚠️ Not financial advice`
  };
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log(`\n[${new Date().toISOString()}] Claude Vision Bot v2 starting...`);

  const state = loadState();

  // Reset daily count
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDate !== today) {
    state.signalsToday = 0;
    state.lastDate     = today;
    console.log("New day — signal count reset.");
  }

  if (state.signalsToday >= 3) {
    console.log("Max 3 signals today. Skipping.");
    return;
  }

  // Fetch candles + build chart image
  const candles    = await fetchCandles("5min", 60);
  const summary    = buildSummary(candles);
  const imageBase64 = await buildChartImage(candles);

  console.log("Market:", summary);
  console.log("Calling Claude Vision...");

  // Call Claude with image + full memory
  const claudeResponse = await callClaudeVision(state, imageBase64, summary);
  console.log("Claude:\n", claudeResponse);

  // Save to memory (text only, not image)
  state.history.push({ role: "user",      content: `[Chart at ${new Date().toUTCString()}] ${summary}` });
  state.history.push({ role: "assistant", content: claudeResponse });
  if (state.history.length > 60) state.history = state.history.slice(-60);

  // Send to Telegram if signal
  const { isWait, signal, text } = formatSignal(claudeResponse);
  if (!isWait) {
    state.signalsToday++;
    state.lastSignal = { time: new Date().toISOString(), signal, response: claudeResponse };
    await sendTelegram(text);
    console.log(`✅ ${signal} sent to Telegram! (${state.signalsToday}/3 today)`);
  } else {
    console.log("WAIT — no Telegram message.");
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
      body   : JSON.stringify({ chat_id: TG_CHAT, text: `❌ Claude Vision Bot error:\n${err.message}` })
    });
  } catch {}
});
