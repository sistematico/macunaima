import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { MessageEntity } from "grammy/types";
import { analyzeMessage } from "./spam-detector";
import { captchaKey, generateCaptcha, type CaptchaData } from "./captcha";
import {
  checkProfilePhoto,
  checkProfileText,
  fetchUserBio,
} from "./profile-checker";
import { registerWarnCommands } from "./warns";
import {
  getLogChannel,
  setLogChannel,
  removeLogChannel,
  sendLog,
  ulink,
  esc,
} from "./logger";

export interface Env {
  BOT_TOKEN: string;
  GOOGLE_AI_API_KEY: string;
  SPAM_THRESHOLD: string;
  MAX_WARNINGS: string;
  GEMINI_MODEL: string;
  CAPTCHA_TIMEOUT_MINUTES: string;
  PROFILE_CHECK_THRESHOLD: string;
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
  await kv.put(warningKey(chatId, userId), String(next), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
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

// ── Bot factory ────────────────────────────────────────────────────────────────

function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  const threshold = parseFloat(env.SPAM_THRESHOLD ?? "0.80");
  const maxWarnings = parseInt(env.MAX_WARNINGS ?? "3", 10);
  const geminiModel = env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const timeoutMinutes = parseFloat(env.CAPTCHA_TIMEOUT_MINUTES ?? "5");
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const profileThreshold = parseFloat(env.PROFILE_CHECK_THRESHOLD ?? "0.85");

  // ── Warn commands ─────────────────────────────────────────────────────────
  registerWarnCommands(bot, env);

  // ── /ping ──────────────────────────────────────────────────────────────────

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply("🏓 Pong!");
    const elapsed = Date.now() - start;
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        msg.message_id,
        `🏓 Pong!\n⏱ <code>${elapsed}ms</code>`,
        { parse_mode: "HTML" }
      )
      .catch(() => undefined);
  });

  // ── /setlogchannel ─────────────────────────────────────────────────────────

  bot.command("setlogchannel", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const callerMember = await ctx.getChatMember(ctx.from!.id).catch(() => null);
    if (!callerMember || !["administrator", "creator"].includes(callerMember.status)) {
      await ctx.reply("❌ Apenas administradores podem usar este comando.");
      return;
    }

    const text = ctx.message?.text ?? "";
    const match = /^\/setlogchannel(?:@\S+)?\s+(\S+)/i.exec(text);
    const input = match?.[1];

    if (!input) {
      await ctx.reply(
        "❌ Uso: <code>/setlogchannel @canal</code> ou <code>/setlogchannel -100xxxxxxxxx</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Resolve channel ID from username or raw ID
    let channelId: number;
    if (/^-?\d+$/.test(input)) {
      channelId = parseInt(input, 10);
    } else {
      try {
        const chat = await ctx.api.getChat(input.startsWith("@") ? input : `@${input}`);
        if (chat.type !== "channel") {
          await ctx.reply("❌ O destino deve ser um canal, não um grupo.");
          return;
        }
        channelId = chat.id;
      } catch {
        await ctx.reply(
          "❌ Canal não encontrado. Verifique o username e se o bot é membro do canal."
        );
        return;
      }
    }

    // Validate: try posting a test message to the channel
    // ctx.chat is already narrowed to group|supergroup, both have title
    const chatTitle = (ctx.chat as { title: string }).title;
    try {
      await ctx.api.sendMessage(
        channelId,
        `📋 <b>Canal de logs ativado!</b>\n\n` +
          `Este canal passará a receber os registros de moderação do grupo <b>${esc(chatTitle)}</b>.`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply(
        "❌ Não consigo postar neste canal.\n" +
          "Certifique-se de que o bot é <b>administrador</b> do canal com permissão de publicar mensagens.",
        { parse_mode: "HTML" }
      );
      return;
    }

    await setLogChannel(env.SPAM_KV, ctx.chat.id, channelId);
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply("✅ Canal de logs configurado.");
  });

  // ── /unsetlogchannel ───────────────────────────────────────────────────────

  bot.command("unsetlogchannel", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const callerMember = await ctx.getChatMember(ctx.from!.id).catch(() => null);
    if (!callerMember || !["administrator", "creator"].includes(callerMember.status)) {
      await ctx.reply("❌ Apenas administradores podem usar este comando.");
      return;
    }

    const had = await getLogChannel(env.SPAM_KV, ctx.chat.id);
    await removeLogChannel(env.SPAM_KV, ctx.chat.id);
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(had ? "✅ Canal de logs removido." : "ℹ️ Nenhum canal de logs estava configurado.");
  });

  // ── New member: profile check + captcha ───────────────────────────────────

  bot.on("message:new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;

      // Fetch bio and run photo + text checks in parallel
      const bio = await fetchUserBio(env.BOT_TOKEN, member.id).catch(
        () => undefined
      );

      const [photoResult, textResult] = await Promise.all([
        checkProfilePhoto(
          env.BOT_TOKEN,
          member.id,
          env.GOOGLE_AI_API_KEY,
          geminiModel
        ).catch(() => ({ flagged: false, confidence: 0, reason: "erro" })),
        checkProfileText(
          member.first_name,
          member.username,
          bio,
          env.GOOGLE_AI_API_KEY,
          geminiModel
        ).catch(() => ({ flagged: false, confidence: 0, reason: "erro" })),
      ]);

      const profileFlagged =
        (photoResult.flagged && photoResult.confidence >= profileThreshold) ||
        (textResult.flagged && textResult.confidence >= profileThreshold);

      if (profileFlagged) {
        // Kick immediately — no captcha needed
        try {
          await ctx.api.banChatMember(ctx.chat.id, member.id);
          await ctx.api.unbanChatMember(ctx.chat.id, member.id);
        } catch {
          // no permission
        }
        const flagReason = photoResult.flagged ? photoResult.reason : textResult.reason;
        const flagConf = photoResult.flagged ? photoResult.confidence : textResult.confidence;
        const chatTitle = (ctx.chat as { title: string }).title;
        await ctx.reply(
          `🚫 <a href="tg://user?id=${member.id}">${member.first_name}</a> foi removido automaticamente.\n` +
            `Motivo: <i>${flagReason}</i>`,
          { parse_mode: "HTML" }
        );
        await sendLog(ctx.api, env.SPAM_KV, ctx.chat.id, chatTitle,
          `🚫 <b>PERFIL REMOVIDO AUTOMATICAMENTE</b>\n\n` +
          `👤 Usuário: ${ulink(member.id, member.first_name)} <code>${member.id}</code>\n` +
          `📝 Motivo: <i>${esc(flagReason)}</i>\n` +
          `📊 Confiança: <b>${Math.round(flagConf * 100)}%</b>`
        );
        continue;
      }

      // Profile OK — show captcha
      const captcha = generateCaptcha();
      const keyboard = new InlineKeyboard();
      for (const opt of captcha.options) {
        keyboard.text(String(opt), `captcha:${member.id}:${opt}`);
      }

      const sent = await ctx.reply(
        `👋 Olá, <a href="tg://user?id=${member.id}">${member.first_name}</a>!\n\n` +
          `Para entrar no grupo, resolva o captcha:\n\n` +
          `<b>${captcha.question}</b>\n\n` +
          `⏳ Você tem <b>${timeoutMinutes} minuto(s)</b> para responder.\n` +
          `Sem resposta, você será removido automaticamente.`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );

      const data: CaptchaData = {
        messageId: sent.message_id,
        correct: captcha.correct,
        expiresAt: Date.now() + timeoutMs,
        chatId: ctx.chat.id,
        userId: member.id,
        firstName: member.first_name,
      };

      await env.SPAM_KV.put(
        captchaKey(ctx.chat.id, member.id),
        JSON.stringify(data),
        { expirationTtl: Math.ceil(timeoutMs / 1000) + 120 }
      );
    }
  });

  // ── Captcha: button click ─────────────────────────────────────────────────

  bot.callbackQuery(/^captcha:(\d+):(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]!, 10);
    const answer = parseInt(ctx.match[2]!, 10);
    const chat = ctx.chat;

    if (!chat) return;

    // Only the challenged user may answer
    if (ctx.from.id !== targetUserId) {
      await ctx.answerCallbackQuery({ text: "Este captcha não é para você." });
      return;
    }

    const key = captchaKey(chat.id, targetUserId);
    const data = await env.SPAM_KV.get<CaptchaData>(key, "json");

    if (!data) {
      await ctx.answerCallbackQuery({
        text: "Captcha expirado ou já resolvido.",
      });
      return;
    }

    await env.SPAM_KV.delete(key);
    await ctx.deleteMessage().catch(() => undefined);

    // chat could be any type in a callback query — use safe access
    const chatTitle = (chat as { title?: string }).title ?? String(chat.id);

    if (answer === data.correct) {
      await ctx.answerCallbackQuery({ text: "✅ Correto! Bem-vindo(a)!" });
      await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
        `✅ <b>CAPTCHA APROVADO</b>\n\n` +
        `👤 Usuário: ${ulink(targetUserId, data.firstName)} <code>${targetUserId}</code>`
      );
    } else {
      await ctx.answerCallbackQuery({ text: "❌ Resposta incorreta." });
      try {
        await ctx.api.banChatMember(chat.id, targetUserId);
        await ctx.api.unbanChatMember(chat.id, targetUserId);
      } catch {
        // no ban permission
      }
      await ctx.reply(
        `❌ <a href="tg://user?id=${targetUserId}">${data.firstName}</a> ` +
          `foi removido por responder incorretamente ao captcha.`,
        { parse_mode: "HTML" }
      );
      await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
        `❌ <b>CAPTCHA REPROVADO</b>\n\n` +
        `👤 Usuário: ${ulink(targetUserId, data.firstName)} <code>${targetUserId}</code>\n` +
        `📝 Motivo: resposta incorreta`
      );
    }
  });

  // ── Spam detection ─────────────────────────────────────────────────────────

  bot.on("message", async (ctx) => {
    const { chat, from, message } = ctx;

    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!from || from.is_bot) return;

    try {
      const member = await ctx.getChatMember(from.id);
      if (member.status === "administrator" || member.status === "creator") {
        return;
      }
    } catch {
      // proceed with analysis if membership check fails
    }

    const text = message.text ?? message.caption ?? "";
    if (text.length < 8) return;

    const entities = message.entities ?? message.caption_entities ?? [];
    const links = extractLinks(text, entities);

    let analysis: Awaited<ReturnType<typeof analyzeMessage>>;
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

    try {
      await ctx.deleteMessage();
    } catch {
      // no delete permission
    }

    const warnings = await incrementWarnings(env.SPAM_KV, chat.id, from.id);
    // chat is already narrowed to group|supergroup above
    const chatTitle = (chat as { title: string }).title;
    const userMention = from.username
      ? `@${from.username}`
      : `<a href="tg://user?id=${from.id}">${from.first_name}</a>`;

    // Log the deleted spam message
    await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
      `🗑️ <b>SPAM REMOVIDO</b>\n\n` +
      `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
      `📋 Categoria: <i>${esc(analysis.category)}</i>\n` +
      `📊 Confiança: <b>${Math.round(analysis.confidence * 100)}%</b>  Aviso: <b>${warnings}/${maxWarnings}</b>\n` +
      `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
    );

    if (warnings >= maxWarnings) {
      try {
        await ctx.banChatMember(from.id);
        await ctx.reply(`🚫 ${userMention} foi banido por spam repetido.`, {
          parse_mode: "HTML",
        });
        await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
          `🚫 <b>BAN POR SPAM</b>\n\n` +
          `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
          `📊 Avisos de spam atingidos: <b>${warnings}/${maxWarnings}</b>`
        );
      } catch {
        await ctx.reply(
          `⛔ ${userMention} atingiu o limite de avisos (${maxWarnings}/${maxWarnings}). ` +
            `Não tenho permissão para banir — por favor, remova manualmente.`,
          { parse_mode: "HTML" }
        );
      }
    } else {
      await ctx.reply(
        `⚠️ Mensagem de ${userMention} removida por spam.\n` +
          `📋 Categoria: <i>${analysis.category}</i>\n` +
          `📊 Aviso ${warnings}/${maxWarnings}`,
        { parse_mode: "HTML" }
      );
    }
  });

  return bot;
}

// ── Exports ────────────────────────────────────────────────────────────────────

export default {
  // Webhook: called by Telegram on every update
  async fetch(request: Request, env: Env): Promise<Response> {
    const bot = createBot(env);
    return webhookCallback(bot, "cloudflare-mod")(request);
  },

  // Cron: runs every minute to kick members who ignored the captcha
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const bot = new Bot(env.BOT_TOKEN);
    const now = Date.now();

    const { keys } = await env.SPAM_KV.list({ prefix: "captcha:" });

    await Promise.all(
      keys.map(async ({ name }) => {
        const data = await env.SPAM_KV.get<CaptchaData>(name, "json");
        if (!data || now < data.expiresAt) return;

        // Captcha timed out — kick the user
        try {
          await bot.api.banChatMember(data.chatId, data.userId);
          await bot.api.unbanChatMember(data.chatId, data.userId);
          await bot.api.deleteMessage(data.chatId, data.messageId);
          await bot.api.sendMessage(
            data.chatId,
            `⏰ <a href="tg://user?id=${data.userId}">${data.firstName}</a> ` +
              `foi removido por não responder ao captcha a tempo.`,
            { parse_mode: "HTML" }
          );
          await sendLog(bot.api, env.SPAM_KV, data.chatId, String(data.chatId),
            `⏰ <b>CAPTCHA EXPIRADO</b>\n\n` +
            `👤 Usuário: ${ulink(data.userId, data.firstName)} <code>${data.userId}</code>\n` +
            `📝 Não respondeu ao captcha dentro do prazo`
          );
        } catch (err) {
          console.error(`Failed to kick user ${data.userId}:`, err);
        }

        await env.SPAM_KV.delete(name);
      })
    );
  },
};
