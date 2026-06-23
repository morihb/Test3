// ═══════════════════════════════════════════════════════════
//  CLAUDE SCALP BOT — XAU/USD
//  Claude reads live candles + news every 5 min
//  Full conversation memory across every call
//  Sends signal to Telegram with entry, TP, SL, reason
// ═══════════════════════════════════════════════════════════

import fs   from "fs";
import path from "path";

// ── Config from env ──────────────────────────────────────
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;
const TG_TOKEN       = process.env.TG_TOKEN;
const TG_CHAT        = process.env.TG_CHAT;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

const STATE_FILE     = path.resolve("./claude_scalp_state.json");
const INTERVAL       = "5min";
const SYMBOL         = "XAU/USD";
const CANDLES        = 60; // last 60 candles sent to Claude for context

// ── Load / save conversation memory ─────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { }
  }
  return { history: [], lastSignal: null, signalsToday: 0, lastDate: "" };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Fetch live candles from TwelveData ───────────────────
async function fetchCandles() {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${INTERVAL}&outputsize=${CANDLES}&apikey=${TWELVEDATA_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error("TwelveData error: " + JSON.stringify(data));
  return data.values.reverse(); // oldest first
}

// ── Fetch latest gold news headlines ────────────────────
async function fetchNews() {
  try {
    const url = `https://api.twelvedata.com/news?symbol=${encodeURIComponent(SYMBOL)}&outputsize=5&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.data) return "No news available.";
    return data.data
      .map((n, i) => `${i + 1}. ${n.title} (${n.datetime})`)
      .join("\n");
  } catch {
    return "News fetch failed.";
  }
}

// ── Build market summary for Claude ─────────────────────
function buildMarketSummary(candles, news) {
  const last    = candles[candles.length - 1];
  const prev    = candles[candles.length - 2];
  const current = parseFloat(last.close);
  const open    = parseFloat(last.open);
  const high    = parseFloat(last.high);
  const low     = parseFloat(last.low);
  const prevClose = parseFloat(prev.close);
  const change  = (current - prevClose).toFixed(2);

  // Simple indicators
  const closes  = candles.map(c => parseFloat(c.close));
  const ema21   = ema(closes, 21);
  const ema50   = ema(closes, 50);
  const atr14   = atr(candles, 14);
  const rsi14   = rsi(closes, 14);

  // Recent highs/lows for structure
  const recentHigh = Math.max(...candles.slice(-20).map(c => parseFloat(c.high))).toFixed(3);
  const recentLow  = Math.min(...candles.slice(-20).map(c => parseFloat(c.low))).toFixed(3);

  return `
=== XAU/USD LIVE MARKET DATA (${last.datetime} UTC) ===
Current Price : ${current}
Open          : ${open}
High          : ${high}
Low           : ${low}
Change        : ${change}
EMA 21        : ${ema21.toFixed(3)}
EMA 50        : ${ema50.toFixed(3)}
RSI (14)      : ${rsi14.toFixed(1)}
ATR (14)      : ${atr14.toFixed(3)}
20-bar High   : ${recentHigh}
20-bar Low    : ${recentLow}
Trend         : ${ema21 > ema50 ? "BULLISH (EMA21 > EMA50)" : "BEARISH (EMA21 < EMA50)"}

=== LAST 10 CANDLES (oldest → newest) ===
${candles.slice(-10).map(c =>
  `[${c.datetime}] O:${c.open} H:${c.high} L:${c.low} C:${c.close}`
).join("\n")}

=== LATEST GOLD NEWS ===
${news}
`.trim();
}

// ── Simple indicator math ────────────────────────────────
function ema(closes, period) {
  const k = 2 / (period + 1);
  let val = closes[0];
  for (let i = 1; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function atr(candles, period) {
  const trs = candles.slice(1).map((c, i) => {
    const h = parseFloat(c.high), l = parseFloat(c.low);
    const pc = parseFloat(candles[i].close);
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

// ── Call Claude API with full memory ────────────────────
async function callClaude(state, marketSummary) {
  const systemPrompt = `You are an expert XAU/USD scalp trader analyzing live 5-minute chart data.
Your job is to decide: BUY, SELL, or WAIT — based on price action, structure, indicators, and news.

Rules:
- Only signal when confluence is HIGH (structure + momentum + trend aligned)
- Give LIMIT entry (not market) — a slightly better price than current
- TP and SL must be based on actual structure levels (swing highs/lows, OBs), not fixed pips
- Max 3 signals per day — quality over quantity
- If last signal hasn't played out yet, factor that in
- Be concise — trader needs quick info, not an essay

Response format (ALWAYS use this exact format):
SIGNAL: [BUY / SELL / WAIT]
ENTRY: [price or "market"]
TP1: [price]
TP2: [price]
SL: [price]
REASON: [2-3 sentences max — structure, momentum, news catalyst if any]
CONFIDENCE: [LOW / MEDIUM / HIGH]

If WAIT, just say:
SIGNAL: WAIT
REASON: [why — what you're waiting for]`;

  // Build messages with full history for memory
  const messages = [
    ...state.history,
    {
      role: "user",
      content: marketSummary
    }
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type"      : "application/json",
      "x-api-key"         : ANTHROPIC_KEY,
      "anthropic-version" : "2023-06-01"
    },
    body: JSON.stringify({
      model      : "claude-sonnet-4-6",
      max_tokens : 500,
      system     : systemPrompt,
      messages
    })
  });

  const data = await res.json();
  if (!data.content) throw new Error("Claude error: " + JSON.stringify(data));
  return data.content[0].text;
}

// ── Send Telegram message ────────────────────────────────
async function sendTelegram(text) {
  const url  = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  await fetch(url, {
    method  : "POST",
    headers : { "Content-Type": "application/json" },
    body    : JSON.stringify({
      chat_id    : TG_CHAT,
      text,
      parse_mode : "HTML"
    })
  });
}

// ── Format signal for Telegram ───────────────────────────
function formatTelegram(claudeResponse, currentPrice) {
  const isWait = claudeResponse.includes("SIGNAL: WAIT");

  if (isWait) {
    const reason = claudeResponse.match(/REASON:\s*(.+)/)?.[1] || "";
    return `⏳ <b>XAUUSD — WAITING</b>\n💰 Price: <b>${currentPrice}</b>\n📝 ${reason}\n\n⚠️ Not financial advice`;
  }

  const signal     = claudeResponse.match(/SIGNAL:\s*(BUY|SELL)/)?.[1]     || "?";
  const entry      = claudeResponse.match(/ENTRY:\s*([^\n]+)/)?.[1]         || "?";
  const tp1        = claudeResponse.match(/TP1:\s*([^\n]+)/)?.[1]           || "?";
  const tp2        = claudeResponse.match(/TP2:\s*([^\n]+)/)?.[1]           || "?";
  const sl         = claudeResponse.match(/SL:\s*([^\n]+)/)?.[1]            || "?";
  const reason     = claudeResponse.match(/REASON:\s*([^\n]+)/)?.[1]        || "?";
  const confidence = claudeResponse.match(/CONFIDENCE:\s*([^\n]+)/)?.[1]    || "?";

  const emoji = signal === "BUY" ? "🟢" : "🔴";
  const confEmoji = confidence === "HIGH" ? "🔥" : confidence === "MEDIUM" ? "⚡" : "⚠️";

  return `${emoji} <b>XAUUSD ${signal} SIGNAL</b>
💰 Price: <b>${currentPrice}</b>
🎯 Entry : <b>${entry}</b>
✅ TP1   : <b>${tp1}</b>
✅ TP2   : <b>${tp2}</b>
❌ SL    : <b>${sl}</b>
${confEmoji} Confidence: <b>${confidence}</b>
📝 ${reason}

⚠️ Not financial advice`;
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Claude Scalp Bot running...`);

  const state = loadState();

  // Reset daily count
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDate !== today) {
    state.signalsToday = 0;
    state.lastDate = today;
  }

  // Max 3 signals per day
  if (state.signalsToday >= 3) {
    console.log("Max 3 signals reached for today. Skipping.");
    return;
  }

  // Fetch market data
  const [candles, news] = await Promise.all([fetchCandles(), fetchNews()]);
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  const marketSummary = buildMarketSummary(candles, news);

  console.log("Market data fetched. Calling Claude...");

  // Call Claude with full memory
  const claudeResponse = await callClaude(state, marketSummary);
  console.log("Claude response:\n", claudeResponse);

  // Save to conversation history (this IS the memory)
  state.history.push({ role: "user",      content: marketSummary    });
  state.history.push({ role: "assistant", content: claudeResponse   });

  // Keep history to last 40 messages (20 rounds) to avoid token overflow
  if (state.history.length > 40) {
    state.history = state.history.slice(-40);
  }

  // Only send Telegram if signal or first WAIT of the session
  const isSignal = claudeResponse.includes("SIGNAL: BUY") || claudeResponse.includes("SIGNAL: SELL");

  if (isSignal) {
    state.signalsToday++;
    state.lastSignal = { time: new Date().toISOString(), price: currentPrice, response: claudeResponse };
    const msg = formatTelegram(claudeResponse, currentPrice);
    await sendTelegram(msg);
    console.log("Signal sent to Telegram!");
  } else {
    console.log("Claude says WAIT — no Telegram message sent.");
  }

  saveState(state);
}

main().catch(async err => {
  console.error("Bot error:", err.message);
  // Send error to Telegram so you know something broke
  try {
    await sendTelegram(`⚠️ Claude Scalp Bot error:\n${err.message}`);
  } catch {}
});
