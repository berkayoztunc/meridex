// Usage: BOT_TOKEN=... WEBHOOK_SECRET=... WEBHOOK_PATH=... WORKER_URL=https://meridex.trade node scripts/webhook.mjs set|info
const { BOT_TOKEN, WEBHOOK_SECRET, WEBHOOK_PATH, WORKER_URL } = process.env;
const cmd = process.argv[2];
if (!BOT_TOKEN) throw new Error("BOT_TOKEN required");
const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());
if (cmd === "set") {
  if (!WEBHOOK_SECRET || !WEBHOOK_PATH || !WORKER_URL) throw new Error("WEBHOOK_SECRET, WEBHOOK_PATH, WORKER_URL required");
  console.log(
    await api("setWebhook", {
      url: `${WORKER_URL.replace(/\/$/, "")}/webhook/${WEBHOOK_PATH}`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  );
} else if (cmd === "info") {
  const r = await api("getWebhookInfo");
  if (r.result) r.result.url = r.result.url?.replace(/\/webhook\/.*/, "/webhook/***");
  console.log(r);
} else if (cmd === "commands") {
  console.log(
    await api("setMyCommands", {
      commands: [
        { command: "start", description: "Create wallet / welcome" },
        { command: "menu", description: "All actions in one place" },
        { command: "balance", description: "XLM and token balances" },
        { command: "receive", description: "Your address + QR" },
        { command: "send", description: "Send XLM or a token" },
        { command: "buy", description: "Buy a token with XLM" },
        { command: "sell", description: "Sell a token for XLM" },
        { command: "price", description: "Token price, market cap, pool depth" },
        { command: "slippage", description: "Swap slippage tolerance" },
        { command: "trust", description: "Add a token (trustline)" },
        { command: "wallets", description: "List / switch / create wallets" },
        { command: "referral", description: "Invite link and referral count" },
        { command: "export", description: "Export private key" },
        { command: "help", description: "Help" },
        { command: "cancel", description: "Cancel current action" },
      ],
    }),
  );
} else console.log("usage: set|info|commands");
