// ═══════════════════════════════════════════════════════════
//  CLAUDE VISION SCALP BOT — XAU/USD
//  Takes TradingView chart screenshot every 5 min
//  Sends image to Claude Vision (exactly like you do manually)
//  Claude analyzes and sends signal to Telegram
//  Full conversation memory across all calls
// ═══════════════════════════════════════════════════════════

import fs   from "fs";
import path from "path";

// ── Config ───────────────────────────────────────────────
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT       = process.env.TG_CHAT;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHART_ID      = process.env.CHART_ID || "6LmEU7gG";

const STATE_FILE    = path.resolve("./vision_bot_state.json");

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

// ── Grab TradingView chart snapshot as base64 ────────────
async function getChartImage() {
  // TradingView public snapshot URL
  const snapshotUrl = `https://charts.tradingview.com/charts/${CHART_ID}/snapshot`;

  console.log("Fetching chart snapshot from TradingView...");
  const res = await fetch(snapshotUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer"   : "https://www.tradingview.com/"
    }
  });

  if (!res.ok) throw new Error(`Snapshot fetch failed: ${res.status} ${res.statusText}`);

  const buffer     = await res.arrayBuffer();
  const base64     = Buffer.from(buffer).toString("base64");
  const mimeType   = res.headers.get("content-type") || "image/png";
  return { base64, mimeType };
}

// ── Call Claude Vision with image + memory ───────────────
async function callClaudeVision(state, imageBase64, mimeType) {
  const systemPrompt = `You are an expert XAU/USD scalp trader. You receive a live TradingView chart screenshot every 5 minutes and must decide: BUY, SELL, or WAIT.

Analyze exactly like a professional trader:
- Read the overall trend and structure
- Identify key levels (swing highs/lows, support/resistance, order blocks)
- Check momentum (candle patterns, speed of move)
- Factor in any previous signals you gave (check conversation history)
- Only signal when confluence is HIGH
- Give LIMIT entry at a better price than current when possible
- TP and SL based on actual chart structure — not fixed pips
- Max 3 signals per day — quality over quantity
- If you already gave a signal that hasn't resolved, say so and WAIT

ALWAYS respond in this exact format:
SIGNAL: [BUY / SELL / WAIT]
ENTRY: [price]
TP1: [price]
TP2: [price]  
SL: [price]
REASON: [2-3 sentences — structure, momentum, key levels]
CONFIDENCE: [LOW / MEDIUM / HIGH]

If WAIT:
SIGNAL: WAIT
REASON: [what you're waiting for specifically]`;

  // Build messages — history (text only) + current image
  const historyMessages = state.history.map(h => ({
    role   : h.role,
    content: h.content
  }));

  const currentMessage = {
    role   : "user",
    content: [
      {
        type  : "image",
        source: {
          type      : "base64",
          media_type: mimeType,
          data      : imageBase64
        }
      },
      {
        type: "text",
        text: `This is the live XAUUSD chart right now (${new Date().toUTCString()}). Analyze it and give your signal. Remember your previous signals from this session.`
      }
    ]
  };

  const messages = [...historyMessages, currentMessage];

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
      messages
    })
  });

  const data = await res.json();
  if (!data.content) throw new Error("Claude API error: " + JSON.stringify(data));
  return data.content[0].text;
}

// ── Send Telegram message ────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({
      chat_id   : TG_CHAT,
      text,
      parse_mode: "HTML"
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error("Telegram error: " + JSON.stringify(data));
}

// ── Format Claude response for Telegram ─────────────────
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
  const time      = new Date().toUTCString();

  const text = `${emoji} <b>XAUUSD ${signal} SIGNAL</b>
🕐 ${time}
━━━━━━━━━━━━━━━
🎯 Entry      : <b>${entry}</b>
✅ TP1        : <b>${tp1}</b>
✅ TP2        : <b>${tp2}</b>
❌ SL         : <b>${sl}</b>
━━━━━━━━━━━━━━━
${confEmoji} Confidence : <b>${confidence}</b>
📝 ${reason}

⚠️ Not financial advice`;

  return { isWait: false, signal, text };
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log(`\n[${new Date().toISOString()}] Claude Vision Bot starting...`);

  const state = loadState();

  // Reset daily signal count
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDate !== today) {
    state.signalsToday = 0;
    state.lastDate     = today;
    console.log("New day — signal count reset.");
  }

  if (state.signalsToday >= 3) {
    console.log("Max 3 signals reached today. Skipping.");
    return;
  }

  // Get chart screenshot
  const { base64, mimeType } = await getChartImage();
  console.log(`Chart image fetched (${Math.round(base64.length / 1024)}KB)`);

  // Call Claude Vision with full memory
  console.log("Sending to Claude Vision...");
  const claudeResponse = await callClaudeVision(state, base64, mimeType);
  console.log("Claude says:\n", claudeResponse);

  // Save to memory — store text summary only (not image) to avoid state bloat
  state.history.push({
    role   : "user",
    content: `[Chart screenshot sent at ${new Date().toUTCString()}]`
  });
  state.history.push({
    role   : "assistant",
    content: claudeResponse
  });

  // Keep last 30 exchanges (60 messages)
  if (state.history.length > 60) {
    state.history = state.history.slice(-60);
  }

  // Format and send
  const { isWait, signal, text } = formatSignal(claudeResponse);

  if (!isWait) {
    state.signalsToday++;
    state.lastSignal  = { time: new Date().toISOString(), signal, response: claudeResponse };
    state.lastAction  = signal;
    await sendTelegram(text);
    console.log(`✅ ${signal} signal sent to Telegram! (${state.signalsToday}/3 today)`);
  } else {
    state.lastAction = "WAIT";
    console.log("Claude says WAIT — no Telegram sent.");
  }

  saveState(state);
  console.log("State saved.");
}

main().catch(async err => {
  console.error("❌ Bot error:", err.message);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({
        chat_id: TG_CHAT,
        text   : `❌ Claude Vision Bot error:\n${err.message}`
      })
    });
  } catch {}
});
