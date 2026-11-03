import type { Env } from "../env";

type Markup = Record<string, unknown>;

async function call(env: Env, method: string, body: BodyInit, json = true): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: json ? { "Content-Type": "application/json" } : undefined,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!j.ok) console.log(`telegram ${method} failed: ${j.description ?? r.status}`);
  return j;
}

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface SendOpts {
  markup?: Markup;
  protect?: boolean;
}

export async function sendMessage(env: Env, chat: number, text: string, o: SendOpts = {}): Promise<number | null> {
  const j = await call(
    env,
    "sendMessage",
    JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: o.markup,
      protect_content: o.protect,
    }),
  );
  return j.ok ? j.result.message_id : null;
}

export async function editMessage(env: Env, chat: number, msgId: number, text: string, markup?: Markup): Promise<void> {
  await call(
    env,
    "editMessageText",
    JSON.stringify({
      chat_id: chat,
      message_id: msgId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: markup ?? { inline_keyboard: [] },
    }),
  );
}

export async function sendPhoto(env: Env, chat: number, png: Uint8Array, caption: string): Promise<void> {
  const f = new FormData();
  f.set("chat_id", String(chat));
  f.set("caption", caption);
  f.set("parse_mode", "HTML");
  f.set("photo", new Blob([png], { type: "image/png" }), "qr.png");
  await call(env, "sendPhoto", f, false);
}

export async function answerCallback(env: Env, id: string, text?: string): Promise<void> {
  await call(env, "answerCallbackQuery", JSON.stringify({ callback_query_id: id, text }));
}

export async function deleteMessage(env: Env, chat: number, msgId: number): Promise<boolean> {
  const j = await call(env, "deleteMessage", JSON.stringify({ chat_id: chat, message_id: msgId }));
  return !!j.ok;
}
