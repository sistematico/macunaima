import { Bot, webhookCallback } from "grammy";
import type { MessageEntity } from "grammy/types";
import { analyzeMessage } from "./spam-detector";

export interface Env {
  BOT_TOKEN: string;
  GOOGLE_AI_API_KEY: string;
  SPAM_THRESHOLD: string;
  MAX_WARNINGS: string;
  GEMINI_MODEL: string;
  SPAM_KV: KVNamespace;
}

// ── KV helpers ────────────────────────────────────────────────────────────────

const warningKey = (chatId: number, userId: number) =>
  `warnings:${chatId}:${userId}`;

async function getWarnings(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<number> {
  const val = await kv.get(warningKey(chatId, userId));
  return val ? parseInt(val, 10) : 0;
}

async function incrementWarnings(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<number> {
  const next = (await getWarnings(kv, chatId, userId)) + 1;
  // Warnings expire after 7 days of inactivity
  await kv.put(warningKey(chatId, userId), String(next), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
  return next;
}

// ── Link extraction ────────────────────────────────────────────────────────────

function extractLinks(text: string, entities: MessageEntity[]): string[] {
  const links: string[] = [];
  for (const entity of entities) {
    if (entity.type === "url") {
      links.push(text.slice(entity.offset, entity.offset + entity.length));
    } else if (entity.type === "text_link" && entity.url) {
      links.push(entity.url);
    }
  }
  return links;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    const threshold = parseFloat(env.SPAM_THRESHOLD ?? "0.80");
    const maxWarnings = parseInt(env.MAX_WARNINGS ?? "3", 10);
    const geminiModel = env.GEMINI_MODEL ?? "gemini-2.0-flash";

    bot.on("message", async (ctx) => {
      const { chat, from, message } = ctx;

      // Only act in group chats
      if (chat.type !== "group" && chat.type !== "supergroup") return;
      if (!from || from.is_bot) return;

      // Admins and the group creator are exempt
      try {
        const member = await ctx.getChatMember(from.id);
        if (member.status === "administrator" || member.status === "creator") {
          return;
        }
      } catch {
        // If we cannot fetch membership, proceed with analysis
      }

      const text = message.text ?? message.caption ?? "";
      if (text.length < 8) return; // ignore very short messages

      const entities = message.entities ?? message.caption_entities ?? [];
      const links = extractLinks(text, entities);

      let analysis;
      try {
        analysis = await analyzeMessage(
          text,
          links,
          env.GOOGLE_AI_API_KEY,
          geminiModel
        );
      } catch (err) {
        console.error("Gemini analysis failed:", err);
        return;
      }

      if (!analysis.isSpam || analysis.confidence < threshold) return;

      // ── Spam detected ──────────────────────────────────────────────────────

      // Try to delete the offending message
      try {
        await ctx.deleteMessage();
      } catch {
        // Bot may lack delete permissions; continue to warn anyway
      }

      const warnings = await incrementWarnings(env.SPAM_KV, chat.id, from.id);
      const mention = from.username
        ? `@${from.username}`
        : `<a href="tg://user?id=${from.id}">${from.first_name}</a>`;

      if (warnings >= maxWarnings) {
        try {
          await ctx.banChatMember(from.id);
          await ctx.reply(`🚫 ${mention} foi banido por spam repetido.`, {
            parse_mode: "HTML",
          });
        } catch {
          await ctx.reply(
            `⛔ ${mention} atingiu o limite de avisos (${maxWarnings}/${maxWarnings}). ` +
              `Não tenho permissão para banir — por favor, remova manualmente.`,
            { parse_mode: "HTML" }
          );
        }
      } else {
        await ctx.reply(
          `⚠️ Mensagem de ${mention} removida por spam.\n` +
            `📋 Categoria: <i>${analysis.category}</i>\n` +
            `📊 Aviso ${warnings}/${maxWarnings}`,
          { parse_mode: "HTML" }
        );
      }
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};
