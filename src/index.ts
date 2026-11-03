import type { Env } from "./env";
import { handleCallback, handleMessage, runCron } from "./telegram/router";
import { markUpdate } from "./db";

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

async function process(env: Env, u: any): Promise<void> {
  try {
    if (u.message?.text && u.message.chat?.type === "private" && u.message.from && !u.message.from.is_bot) {
      await handleMessage(env, {
        chat: u.message.chat.id,
        from: u.message.from.id,
        username: u.message.from.username ?? null,
        text: u.message.text,
      });
    } else if (u.callback_query?.message?.chat?.type === "private" && u.callback_query.data) {
      const q = u.callback_query;
      await handleCallback(env, { id: q.id, chat: q.message.chat.id, msgId: q.message.message_id, from: q.from.id, data: q.data });
    }
  } catch (e) {
    console.log("handler error", e instanceof Error ? e.message : "unknown");
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== `/webhook/${env.WEBHOOK_PATH}`) return new Response("Not found", { status: 404 });
    if (!safeEqual(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.WEBHOOK_SECRET)) return new Response("Forbidden", { status: 403 });
    const u = (await req.json().catch(() => null)) as any;
    if (!u || typeof u.update_id !== "number") return new Response("Bad request", { status: 400 });
    if (await markUpdate(env, u.update_id)) ctx.waitUntil(process(env, u));
    return new Response("ok");
  },
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
