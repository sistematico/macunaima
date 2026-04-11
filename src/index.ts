import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { MessageEntity } from "grammy/types";
import { analyzeContent, generateIntroPhrase, heuristicAnalysis } from "./spam-detector";
import {
  allowFixedWindow,
  isThrottled,
  reserveGeminiChatSlot,
  setThrottle,
} from "./throttle";
import { captchaKey, generateCaptcha, type CaptchaData } from "./captcha";
import {
  checkProfilePhoto,
  checkProfileText,
  fetchUserBio,
} from "./profile-checker";
import {
  registerWarnCommands,
  getConfig,
  saveConfig,
  addWarn,
  clearWarns,
  applyPunishment,
  PUNISHMENT_LABEL,
  ANTI_PROMOTION_ACTION_LABEL,
  type GroupConfig,
} from "./warns";
import {
  getLogChannel,
  setLogChannel,
  removeLogChannel,
  getGlobalLogChannel,
  setGlobalLogChannel,
  removeGlobalLogChannel,
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
  OFFENSIVE_THRESHOLD: string;
  GEMINI_THROTTLE_SECONDS: string;
  GEMINI_MAX_CALLS_PER_MINUTE: string;
  SPAM_KV: KVNamespace;
}

type PrivatePendingAction = {
  chatId: number;
  action: "set_rules_url";
};

const configContextKey = (userId: number) => `config_context:${userId}`;
const configPendingKey = (userId: number) => `config_pending:${userId}`;

function getCommandName(text: string, entities: MessageEntity[]): string | null {
  const cmdEntity = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!cmdEntity) return null;

  const raw = text.slice(1, cmdEntity.length);
  return raw.split("@")[0]?.toLowerCase() ?? null;
}

async function isAdminInChat(
  api: import("grammy").Api,
  chatId: number,
  userId: number
): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

function configSummary(config: GroupConfig): string {
  return (
    `⚙️ <b>Configuração atual</b>\n\n` +
    `• Regras: <b>${config.rulesUrl ? "definidas" : "não definidas"}</b>\n` +
    `• Apagar comandos de não-admin: <b>${config.deleteNonAdminCommands ? "on" : "off"}</b>\n` +
    `• Anti-divulgação: <b>${config.antiPromotion ? "on" : "off"}</b>\n` +
    `• Ação anti-divulgação: <b>${ANTI_PROMOTION_ACTION_LABEL[config.antiPromotionAction]}</b>\n` +
    `• Conteúdo ofensivo: <b>${config.offensiveDetection ? "on" : "off"}</b>\n` +
    `• Warns: <b>${config.maxWarns}</b> | Punição: <b>${PUNISHMENT_LABEL[config.punishment]}</b>`
  );
}

function configKeyboard(chatId: number, config: GroupConfig): InlineKeyboard {
  const antiPromotionNext = config.antiPromotion ? "off" : "on";
  const offensiveNext = config.offensiveDetection ? "off" : "on";
  const deleteCommandsNext = config.deleteNonAdminCommands ? "off" : "on";

  return new InlineKeyboard()
    .text(
      `🧹 Comandos não-admin: ${config.deleteNonAdminCommands ? "ON" : "OFF"}`,
      `cfg:${chatId}:delete_cmds:${deleteCommandsNext}`
    )
    .row()
    .text(
      `🚫 Anti-divulgação: ${config.antiPromotion ? "ON" : "OFF"}`,
      `cfg:${chatId}:anti_promo:${antiPromotionNext}`
    )
    .row()
    .text(
      `🤬 Conteúdo ofensivo: ${config.offensiveDetection ? "ON" : "OFF"}`,
      `cfg:${chatId}:offensive:${offensiveNext}`
    )
    .row()
    .text("📜 Definir link de regras", `cfg:${chatId}:rules:set`)
    .text("🗑️ Remover regras", `cfg:${chatId}:rules:clear`)
    .row()
    .text("🔄 Atualizar painel", `cfg:${chatId}:refresh`);
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

  const rawUrlPattern = /(?:https?:\/\/[^\s]+|(?:t\.me|telegram\.me|telegram\.dog)\/[^\s]+)/gi;
  for (const match of text.matchAll(rawUrlPattern)) {
    if (match[0]) links.push(match[0]);
  }

  return Array.from(new Set(links));
}

// ── Telegram link detection ──────────────────────────────────────────────────

const TELEGRAM_LINK_RE =
  /(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/\S+/i;

/**
 * Returns true if the message contains links to other Telegram groups or
 * channels (invite links, public group/channel links, etc.).
 */
function containsTelegramPromotion(
  text: string,
  entities: MessageEntity[]
): boolean {
  // Check URL entities
  for (const entity of entities) {
    if (entity.type === "url") {
      const url = text.slice(entity.offset, entity.offset + entity.length);
      if (TELEGRAM_LINK_RE.test(url)) return true;
    }
    if (entity.type === "text_link" && entity.url) {
      if (TELEGRAM_LINK_RE.test(entity.url)) return true;
    }
  }
  // Check raw text as fallback (obfuscated links without entity)
  if (TELEGRAM_LINK_RE.test(text)) return true;
  return false;
}

// ── Channel resolution helper ─────────────────────────────────────────────────
//
// Accepts either:
//   @username  — public channel  (resolved via getChat)
//   -100xxx    — private channel (numeric ID used directly)

async function resolveChannelId(
  api: import("grammy").Api,
  input: string
): Promise<{ id: number } | { error: string }> {
  if (/^-?\d+$/.test(input)) {
    return { id: parseInt(input, 10) };
  }
  try {
    const chat = await api.getChat(input.startsWith("@") ? input : `@${input}`);
    if (chat.type !== "channel") return { error: "O destino deve ser um canal, não um grupo." };
    return { id: chat.id };
  } catch {
    return {
      error:
        "Canal não encontrado.\n" +
        "• Para canais <b>públicos</b>: use <code>@username</code>\n" +
        "• Para canais <b>privados</b>: use o ID numérico (<code>-100xxxxxxxxx</code>)\n" +
        "Verifique também se o bot é membro do canal.",
    };
  }
}

// ── Bot factory ────────────────────────────────────────────────────────────────

function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  const spamThreshold = parseFloat(env.SPAM_THRESHOLD ?? "0.80");
  const offensiveThreshold = parseFloat(env.OFFENSIVE_THRESHOLD ?? "0.90");
  const maxWarnings = parseInt(env.MAX_WARNINGS ?? "3", 10);
  const geminiModel = env.GEMINI_MODEL ?? "gemini-1.5-flash";
  const timeoutMinutes = parseFloat(env.CAPTCHA_TIMEOUT_MINUTES ?? "5");
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const profileThreshold = parseFloat(env.PROFILE_CHECK_THRESHOLD ?? "0.85");
  const throttleSeconds = parseInt(env.GEMINI_THROTTLE_SECONDS ?? "60", 10);
  const geminiMaxCallsPerMinute = parseInt(
    env.GEMINI_MAX_CALLS_PER_MINUTE ?? "12",
    10
  );

  const openPrivateConfigPanel = async (
    userId: number,
    chatId: number
  ): Promise<void> => {
    const chat = await bot.api.getChat(chatId);
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await bot.api.sendMessage(userId, "❌ O contexto salvo não é um grupo válido.");
      return;
    }

    const config = await getConfig(env.SPAM_KV, chatId);
    const text =
      `🛠️ <b>Painel do grupo</b>\n` +
      `🏠 <b>${esc(chat.title)}</b>\n` +
      `🆔 <code>${chatId}</code>\n\n` +
      `${configSummary(config)}\n\n` +
      `Use os botões abaixo para ajustar.`;

    await bot.api.sendMessage(userId, text, {
      parse_mode: "HTML",
      reply_markup: configKeyboard(chatId, config),
    });
  };

  const attachGroupContext = async (
    userId: number,
    chatId: number,
    chatTitle: string
  ): Promise<boolean> => {
    await env.SPAM_KV.put(configContextKey(userId), String(chatId), {
      expirationTtl: 60 * 60 * 6,
    });

    try {
      await bot.api.sendMessage(
        userId,
        `✅ Contexto salvo para <b>${esc(chatTitle)}</b>.\n` +
          `Abra /config aqui no privado para ajustar as opções do grupo.`,
        { parse_mode: "HTML" }
      );
      return true;
    } catch {
      return false;
    }
  };

  bot.use(async (ctx, next) => {
    if (!ctx.chat || !ctx.message) {
      await next();
      return;
    }

    const text = ctx.message.text ?? ctx.message.caption ?? "";
    const entities = ctx.message.entities ?? ctx.message.caption_entities ?? [];
    const commandName = getCommandName(text, entities);
    if (!commandName) {
      await next();
      return;
    }

    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      if (commandName === "start" || commandName === "config") {
        await ctx.deleteMessage().catch(() => undefined);
        if (!ctx.from) return;

        const isAdmin = await isAdminInChat(ctx.api, ctx.chat.id, ctx.from.id);
        if (!isAdmin) return;

        const chatTitle = (ctx.chat as { title: string }).title;
        const sentInPrivate = await attachGroupContext(
          ctx.from.id,
          ctx.chat.id,
          chatTitle
        );
        if (!sentInPrivate) {
          await ctx
            .reply(
              "⚠️ Não consegui te chamar no privado. Abra uma conversa com o bot e envie /start, depois use /config no grupo novamente."
            )
            .catch(() => undefined);
        }
        return;
      }

      const groupConfig = await getConfig(env.SPAM_KV, ctx.chat.id);
      if (groupConfig.deleteNonAdminCommands && ctx.from) {
        const isAdmin = await isAdminInChat(ctx.api, ctx.chat.id, ctx.from.id);
        if (!isAdmin) {
          await ctx.deleteMessage().catch(() => undefined);
          return;
        }
      }
    }

    await next();
  });

  // ── /start and /config in private chat ───────────────────────────────────

  bot.command(["start", "config"], async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (!ctx.from) return;

    const allowed = await allowFixedWindow(
      env.SPAM_KV,
      `private_config_cmd:${ctx.from.id}`,
      10,
      60
    );
    if (!allowed) {
      await ctx.reply("⏳ Muitas tentativas. Aguarde alguns segundos e tente novamente.");
      return;
    }

    const contextRaw = await env.SPAM_KV.get(configContextKey(ctx.from.id));
    if (!contextRaw) {
      await ctx.reply(
        "Para abrir o painel, use <code>/config</code> em um grupo onde o bot está ativo.\n" +
          "Esse comando no grupo é apagado e salva o contexto automaticamente.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const chatId = parseInt(contextRaw, 10);
    if (Number.isNaN(chatId)) {
      await env.SPAM_KV.delete(configContextKey(ctx.from.id));
      await ctx.reply("❌ Contexto inválido. Use /config no grupo novamente.");
      return;
    }

    const isAdmin = await isAdminInChat(ctx.api, chatId, ctx.from.id);
    if (!isAdmin) {
      await ctx.reply(
        "❌ Você não é admin do grupo salvo no contexto.\n" +
          "Use /config no grupo correto para atualizar o contexto."
      );
      return;
    }

    await openPrivateConfigPanel(ctx.from.id, chatId);
  });

  bot.callbackQuery(/^cfg:(-?\d+):([a-z_]+)(?::([a-z_]+))?$/, async (ctx) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;

    const allowed = await allowFixedWindow(
      env.SPAM_KV,
      `private_config_cb:${ctx.from.id}`,
      30,
      60
    );
    if (!allowed) {
      await ctx.answerCallbackQuery({ text: "Aguarde alguns segundos." });
      return;
    }

    const chatId = parseInt(ctx.match[1]!, 10);
    const action = ctx.match[2]!;
    const value = ctx.match[3] ?? "";

    const isAdmin = await isAdminInChat(ctx.api, chatId, ctx.from.id);
    if (!isAdmin) {
      await ctx.answerCallbackQuery({ text: "Você não é admin desse grupo." });
      return;
    }

    if (action === "rules" && value === "set") {
      const pending: PrivatePendingAction = { chatId, action: "set_rules_url" };
      await env.SPAM_KV.put(configPendingKey(ctx.from.id), JSON.stringify(pending), {
        expirationTtl: 60 * 5,
      });
      await ctx.answerCallbackQuery({ text: "Envie agora o link das regras." });
      await ctx.reply(
        "Envie o link completo das regras (ex.: <code>https://...</code>).\n" +
          "Você tem 5 minutos para concluir.",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (action === "rules" && value === "clear") {
      await saveConfig(env.SPAM_KV, chatId, { rulesUrl: null });
      await ctx.answerCallbackQuery({ text: "Link de regras removido." });
    } else if (action === "anti_promo" && (value === "on" || value === "off")) {
      await saveConfig(env.SPAM_KV, chatId, { antiPromotion: value === "on" });
      await ctx.answerCallbackQuery({ text: "Anti-divulgação atualizada." });
    } else if (action === "offensive" && (value === "on" || value === "off")) {
      await saveConfig(env.SPAM_KV, chatId, { offensiveDetection: value === "on" });
      await ctx.answerCallbackQuery({ text: "Detecção ofensiva atualizada." });
    } else if (action === "delete_cmds" && (value === "on" || value === "off")) {
      await saveConfig(env.SPAM_KV, chatId, {
        deleteNonAdminCommands: value === "on",
      });
      await ctx.answerCallbackQuery({ text: "Filtro de comandos atualizado." });
    } else if (action !== "refresh") {
      await ctx.answerCallbackQuery({ text: "Ação inválida." });
      return;
    }

    const chat = await ctx.api.getChat(chatId);
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await ctx.answerCallbackQuery({ text: "Grupo inválido." });
      return;
    }

    const config = await getConfig(env.SPAM_KV, chatId);
    const text =
      `🛠️ <b>Painel do grupo</b>\n` +
      `🏠 <b>${esc(chat.title)}</b>\n` +
      `🆔 <code>${chatId}</code>\n\n` +
      `${configSummary(config)}\n\n` +
      `Use os botões abaixo para ajustar.`;

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: configKeyboard(chatId, config),
    }).catch(() => undefined);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !ctx.from) {
      await next();
      return;
    }

    const pending = await env.SPAM_KV.get<PrivatePendingAction>(
      configPendingKey(ctx.from.id),
      "json"
    );
    if (!pending) {
      await next();
      return;
    }

    if (pending.action !== "set_rules_url") {
      await env.SPAM_KV.delete(configPendingKey(ctx.from.id));
      await next();
      return;
    }

    const url = (ctx.message.text ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      await ctx.reply("❌ Link inválido. Envie uma URL começando com http:// ou https://");
      return;
    }

    const isAdmin = await isAdminInChat(ctx.api, pending.chatId, ctx.from.id);
    if (!isAdmin) {
      await env.SPAM_KV.delete(configPendingKey(ctx.from.id));
      await ctx.reply("❌ Você não é admin desse grupo.");
      return;
    }

    await saveConfig(env.SPAM_KV, pending.chatId, { rulesUrl: url });
    await env.SPAM_KV.delete(configPendingKey(ctx.from.id));
    await ctx.reply("✅ Link de regras atualizado.");
    await openPrivateConfigPanel(ctx.from.id, pending.chatId);
  });

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
        "❌ Uso:\n" +
          "• <code>/setlogchannel @canal</code> — canal público\n" +
          "• <code>/setlogchannel -100xxxxxxxxx</code> — canal privado (ID numérico)",
        { parse_mode: "HTML" }
      );
      return;
    }

    const resolved = await resolveChannelId(ctx.api, input);
    if ("error" in resolved) {
      await ctx.reply(`❌ ${resolved.error}`, { parse_mode: "HTML" });
      return;
    }

    const chatTitle = (ctx.chat as { title: string }).title;
    try {
      await ctx.api.sendMessage(
        resolved.id,
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

    await setLogChannel(env.SPAM_KV, ctx.chat.id, resolved.id);
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply("✅ Canal de logs do grupo configurado.");
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
    await ctx.reply(had ? "✅ Canal de logs do grupo removido." : "ℹ️ Nenhum canal de logs estava configurado.");
  });

  // ── /setgloballog ──────────────────────────────────────────────────────────
  //
  // Configures the bot-wide log channel that receives events from ALL groups.
  // Only works in private chat (DM) with the bot to prevent misuse.

  bot.command("setgloballog", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply(
        "ℹ️ Este comando só pode ser usado em conversa privada com o bot.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const text = ctx.message?.text ?? "";
    const match = /^\/setgloballog(?:@\S+)?\s+(\S+)/i.exec(text);
    const input = match?.[1];

    if (!input) {
      await ctx.reply(
        "❌ Uso:\n" +
          "• <code>/setgloballog @canal</code> — canal público\n" +
          "• <code>/setgloballog -100xxxxxxxxx</code> — canal privado (ID numérico)\n\n" +
          "O canal global recebe eventos de <b>todos</b> os grupos onde o bot está.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const resolved = await resolveChannelId(ctx.api, input);
    if ("error" in resolved) {
      await ctx.reply(`❌ ${resolved.error}`, { parse_mode: "HTML" });
      return;
    }

    try {
      await ctx.api.sendMessage(
        resolved.id,
        `🌐 <b>Canal de logs global ativado!</b>\n\n` +
          `Este canal passará a receber os registros de moderação de <b>todos os grupos</b> onde o bot está presente.`,
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

    await setGlobalLogChannel(env.SPAM_KV, resolved.id);
    await ctx.reply("✅ Canal de logs global configurado.");
  });

  // ── /unsetgloballog ────────────────────────────────────────────────────────

  bot.command("unsetgloballog", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("ℹ️ Este comando só pode ser usado em conversa privada com o bot.");
      return;
    }

    const had = await getGlobalLogChannel(env.SPAM_KV);
    await removeGlobalLogChannel(env.SPAM_KV);
    await ctx.reply(had ? "✅ Canal de logs global removido." : "ℹ️ Nenhum canal de logs global estava configurado.");
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
    const chat = ctx.chat ?? ctx.callbackQuery.message?.chat;

    if (!chat) return;

    const allowed = await allowFixedWindow(
      env.SPAM_KV,
      `captcha_click:${chat.id}:${ctx.from.id}`,
      8,
      30
    );
    if (!allowed) {
      await ctx.answerCallbackQuery({ text: "Muitas tentativas. Aguarde." });
      return;
    }

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
      const config = await getConfig(env.SPAM_KV, chat.id);
      if (config.rulesUrl) {
        const rulesKeyboard = new InlineKeyboard().url(
          "📜 Regras do grupo",
          config.rulesUrl
        );
        await ctx.api
          .sendMessage(
            chat.id,
            `✅ <a href="tg://user?id=${targetUserId}">${data.firstName}</a> concluiu o captcha.\n` +
              `Leia as regras no botão abaixo:`,
            {
              parse_mode: "HTML",
              reply_markup: rulesKeyboard,
            }
          )
          .catch(() => undefined);
      }
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

  // ── Bot mention → self-introduction ──────────────────────────────────────
  //
  // Rate limiting strategy (all backed by KV):
  //   intro_user:{chatId}:{userId}   — per-user throttle  (10 min)
  //   intro_debounce:{chatId}        — group debounce: only one reply per minute
  //   intro_window:{chatId}:{bucket} — 2-min bucket counter for all mentions
  //   intro_lock:{chatId}            — 1-hour silence when spam detected (> 5/2 min)
  //
  // Mention counting always runs (even when throttled/debounced), so abusers
  // who rotate messages still trip the spam lockout.

  const INTRO_SPAM_LIMIT = 5;          // max mentions per 2-min window before lockout
  const INTRO_WINDOW_SECONDS = 120;    // window size for spam counting
  const INTRO_LOCKOUT_SECONDS = 3600;  // 1 hour lockout on spam
  const INTRO_USER_TTL = 600;          // 10-min per-user throttle
  const INTRO_DEBOUNCE_TTL = 60;       // 60-second group debounce

  bot.on("message", async (ctx) => {
    const { chat, from, message } = ctx;

    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!from || from.is_bot) return;

    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];

    // Detect mention of bot by @username (entity) or by first name in text
    const botUsername = ctx.me.username ?? "";
    const botFirstName = ctx.me.first_name;
    const mentionedByEntity = entities.some(
      (e) =>
        e.type === "mention" &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() ===
          `@${botUsername.toLowerCase()}`
    );
    const nameEscaped = botFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionedByName =
      botFirstName.length >= 3 &&
      new RegExp(`\\b${nameEscaped}\\b`, "i").test(text);

    if (!mentionedByEntity && !mentionedByName) return;

    // ── Always count mention towards spam window ───────────────────────────
    const bucket = Math.floor(Date.now() / 1000 / INTRO_WINDOW_SECONDS);
    const windowKey = `intro_window:${chat.id}:${bucket}`;
    const windowCount =
      parseInt((await env.SPAM_KV.get(windowKey)) ?? "0", 10) + 1;
    await env.SPAM_KV.put(windowKey, String(windowCount), {
      expirationTtl: Math.max(60, INTRO_WINDOW_SECONDS + 10),
    });

    // Trip the lockout if spam threshold exceeded
    if (windowCount > INTRO_SPAM_LIMIT) {
      await env.SPAM_KV.put(`intro_lock:${chat.id}`, "1", {
        expirationTtl: INTRO_LOCKOUT_SECONDS,
      });
      return;
    }

    // ── Check lockout ─────────────────────────────────────────────────────
    if ((await env.SPAM_KV.get(`intro_lock:${chat.id}`)) !== null) return;

    // ── Per-user throttle ─────────────────────────────────────────────────
    const userKey = `intro_user:${chat.id}:${from.id}`;
    if ((await env.SPAM_KV.get(userKey)) !== null) return;

    // ── Group debounce ────────────────────────────────────────────────────
    const debounceKey = `intro_debounce:${chat.id}`;
    if ((await env.SPAM_KV.get(debounceKey)) !== null) return;

    // Set throttles before the API call so concurrent requests don't race
    await Promise.all([
      env.SPAM_KV.put(userKey, "1", { expirationTtl: INTRO_USER_TTL }),
      env.SPAM_KV.put(debounceKey, "1", { expirationTtl: INTRO_DEBOUNCE_TTL }),
    ]);

    let phrase: string;
    try {
      phrase = await generateIntroPhrase(botFirstName, env.GOOGLE_AI_API_KEY, geminiModel);
    } catch {
      phrase = `Oi! Sou o ${botFirstName}, bot de moderação deste grupo. 🤖`;
    }

    await ctx.reply(phrase).catch(() => undefined);
  });

  // ── Rules request detection ───────────────────────────────────────────────

  const RULES_REQUEST_PATTERN =
    /\b(regras?\s*do\s*grupo|regras?\s*da\s*comunidade|quais?\s*s[aã]o\s*as\s*regras?|onde\s*(est[aá]|ficam?|t[eê]m?)\s*as\s*regras?|tem\s*regras?\s*aqui|regras?\s*do\s*chat|ver\s*as?\s*regras?|link\s*(das?|de)\s*regras?)\b/i;

  bot.on("message", async (ctx) => {
    const { chat, from, message } = ctx;

    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!from || from.is_bot) return;

    const text = message.text ?? message.caption ?? "";
    if (!RULES_REQUEST_PATTERN.test(text)) return;

    const config = await getConfig(env.SPAM_KV, chat.id);
    if (!config.rulesUrl) return;

    const rulesKeyboard = new InlineKeyboard().url("📜 Regras do grupo", config.rulesUrl);
    await ctx.reply("📜 Aqui estão as regras do grupo:", {
      reply_markup: rulesKeyboard,
      parse_mode: "HTML",
    });
  });

  // ── Content analysis: spam + offensive (one Gemini call, throttled) ────────

  bot.on("message", async (ctx) => {
    const { chat, from, message } = ctx;

    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!from || from.is_bot) return;

    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const links = extractLinks(text, entities);
    const compactText = text.replace(/\s+/g, "").trim();

    // Skip only truly empty/noise messages. Short text can still be spam (BET, golpe, links).
    if (compactText.length < 3 && links.length === 0) return;

    try {
      const member = await ctx.getChatMember(from.id);
      if (member.status === "administrator" || member.status === "creator") return;
    } catch { /* proceed */ }

    // ── Anti-promotion check (before Gemini, no API cost) ──────────────────

    if (containsTelegramPromotion(text, entities)) {
      const groupConfig = await getConfig(env.SPAM_KV, chat.id);
      if (groupConfig.antiPromotion) {
        const chatTitle = (chat as { title: string }).title;
        const userMention = from.username
          ? `@${from.username}`
          : `<a href="tg://user?id=${from.id}">${from.first_name}</a>`;

        try { await ctx.deleteMessage(); } catch { /* no permission */ }

        const action = groupConfig.antiPromotionAction;

        if (action === "warn") {
          const warnCount = await addWarn(env.SPAM_KV, chat.id, from.id);

          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `📢 <b>DIVULGAÇÃO BLOQUEADA</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `📊 Avisos: <b>${warnCount}/${groupConfig.maxWarns}</b>\n` +
            `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
          );

          if (warnCount >= groupConfig.maxWarns) {
            try {
              await applyPunishment(ctx.api, chat.id, from.id, groupConfig.punishment);
              await clearWarns(env.SPAM_KV, chat.id, from.id);
              await ctx.reply(
                `🚫 ${userMention} atingiu <b>${warnCount}/${groupConfig.maxWarns}</b> avisos.\n` +
                  `Punição: <b>${PUNISHMENT_LABEL[groupConfig.punishment]}</b>\n` +
                  `📝 Motivo: <i>divulgação de grupo/canal</i>`,
                { parse_mode: "HTML" }
              );
            } catch {
              await ctx.reply(
                `⛔ ${userMention} atingiu o limite de avisos. Não tenho permissão para aplicar a punição.`,
                { parse_mode: "HTML" }
              );
            }
          } else {
            await ctx.reply(
              `⚠️ ${userMention} recebeu um aviso por divulgação de grupo/canal.\n` +
                `📊 Avisos: <b>${warnCount}/${groupConfig.maxWarns}</b>`,
              { parse_mode: "HTML" }
            );
          }
        } else if (action === "ban") {
          try {
            await ctx.api.banChatMember(chat.id, from.id);
            await ctx.reply(
              `🚫 ${userMention} foi banido por divulgação de grupo/canal.`,
              { parse_mode: "HTML" }
            );
          } catch {
            await ctx.reply(
              `⛔ Não tenho permissão para banir ${userMention}.`,
              { parse_mode: "HTML" }
            );
          }
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `📢 <b>DIVULGAÇÃO — BAN</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
          );
        } else if (action === "kick") {
          try {
            await ctx.api.banChatMember(chat.id, from.id);
            await ctx.api.unbanChatMember(chat.id, from.id);
            await ctx.reply(
              `🚫 ${userMention} foi removido por divulgação de grupo/canal.`,
              { parse_mode: "HTML" }
            );
          } catch {
            await ctx.reply(
              `⛔ Não tenho permissão para remover ${userMention}.`,
              { parse_mode: "HTML" }
            );
          }
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `📢 <b>DIVULGAÇÃO — KICK</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
          );
        } else {
          // action === "delete" — message already deleted above
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `📢 <b>DIVULGAÇÃO APAGADA</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
          );
        }
        return; // Stop processing — no need for Gemini analysis
      }
    }
    // ── Heuristic pre-check (free, runs even when user is throttled) ──────────
    // Regex-based patterns catch high-confidence spam without spending API quota.
    // If confident enough, act immediately and skip Gemini entirely.

    const chatTitle = (chat as { title: string }).title;
    const userMention = from.username
      ? `@${from.username}`
      : `<a href="tg://user?id=${from.id}">${from.first_name}</a>`;

    const heuristic = heuristicAnalysis(text, links);
    if (heuristic.isSpam && heuristic.spamConfidence >= spamThreshold) {
      try { await ctx.deleteMessage(); } catch { /* no permission */ }

      const warnings = await incrementWarnings(env.SPAM_KV, chat.id, from.id);

      await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
        `🗑️ <b>SPAM REMOVIDO</b>\n\n` +
        `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
        `📋 Categoria: <i>${esc(heuristic.spamCategory)}</i>\n` +
        `📊 Confiança: <b>${Math.round(heuristic.spamConfidence * 100)}%</b>  Aviso spam: <b>${warnings}/${maxWarnings}</b>\n` +
        `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
      );

      if (warnings >= maxWarnings) {
        try {
          await ctx.banChatMember(from.id);
          await ctx.reply(`🚫 ${userMention} foi banido por spam repetido.`, { parse_mode: "HTML" });
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `🚫 <b>BAN POR SPAM</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `📊 Avisos de spam: <b>${warnings}/${maxWarnings}</b>`
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
            `📋 Categoria: <i>${heuristic.spamCategory}</i>\n` +
            `📊 Aviso spam ${warnings}/${maxWarnings}`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // ── Throttle + Gemini analysis ────────────────────────────────────────────

    if (await isThrottled(env.SPAM_KV, chat.id, from.id)) return;

    const geminiSlot = await reserveGeminiChatSlot(
      env.SPAM_KV,
      chat.id,
      geminiMaxCallsPerMinute
    );
    if (!geminiSlot) return;

    let analysis: Awaited<ReturnType<typeof analyzeContent>>;
    try {
      analysis = await analyzeContent(text, links, env.GOOGLE_AI_API_KEY, geminiModel);
    } catch (err) {
      console.error("Gemini analysis failed:", err);
      return;
    }

    // Mark user as recently checked — regardless of result
    await setThrottle(env.SPAM_KV, chat.id, from.id, throttleSeconds);

    // ── Spam (takes priority over offensive) ─────────────────────────────────

    if (analysis.isSpam && analysis.spamConfidence >= spamThreshold) {
      try { await ctx.deleteMessage(); } catch { /* no permission */ }

      const warnings = await incrementWarnings(env.SPAM_KV, chat.id, from.id);

      await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
        `🗑️ <b>SPAM REMOVIDO</b>\n\n` +
        `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
        `📋 Categoria: <i>${esc(analysis.spamCategory)}</i>\n` +
        `📊 Confiança: <b>${Math.round(analysis.spamConfidence * 100)}%</b>  Aviso spam: <b>${warnings}/${maxWarnings}</b>\n` +
        `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
      );

      if (warnings >= maxWarnings) {
        try {
          await ctx.banChatMember(from.id);
          await ctx.reply(`🚫 ${userMention} foi banido por spam repetido.`, { parse_mode: "HTML" });
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `🚫 <b>BAN POR SPAM</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `📊 Avisos de spam: <b>${warnings}/${maxWarnings}</b>`
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
            `📋 Categoria: <i>${analysis.spamCategory}</i>\n` +
            `📊 Aviso spam ${warnings}/${maxWarnings}`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // ── Offensive content (uses the /warn system, per-group configurable) ─────

    if (analysis.isOffensive && analysis.offensiveConfidence >= offensiveThreshold) {
      const groupConfig = await getConfig(env.SPAM_KV, chat.id);
      if (!groupConfig.offensiveDetection) return;

      try { await ctx.deleteMessage(); } catch { /* no permission */ }

      const warnCount = await addWarn(env.SPAM_KV, chat.id, from.id);

      await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
        `🤬 <b>CONTEÚDO OFENSIVO REMOVIDO</b>\n\n` +
        `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
        `📋 Categoria: <i>${esc(analysis.offensiveCategory)}</i>\n` +
        `📊 Confiança: <b>${Math.round(analysis.offensiveConfidence * 100)}%</b>\n` +
        `📊 Avisos: <b>${warnCount}/${groupConfig.maxWarns}</b>\n` +
        `✂️ Trecho: <i>${esc(text.slice(0, 120))}${text.length > 120 ? "…" : ""}</i>`
      );

      if (warnCount >= groupConfig.maxWarns) {
        try {
          await applyPunishment(ctx.api, chat.id, from.id, groupConfig.punishment);
          await clearWarns(env.SPAM_KV, chat.id, from.id);
          await ctx.reply(
            `🚫 ${userMention} atingiu <b>${warnCount}/${groupConfig.maxWarns}</b> avisos.\n` +
              `Punição: <b>${PUNISHMENT_LABEL[groupConfig.punishment]}</b>\n` +
              `📝 Motivo: <i>conteúdo ofensivo (automático)</i>`,
            { parse_mode: "HTML" }
          );
          await sendLog(ctx.api, env.SPAM_KV, chat.id, chatTitle,
            `🚫 <b>PUNIÇÃO APLICADA (OFENSIVO)</b>\n\n` +
            `👤 Usuário: ${ulink(from.id, from.first_name)} <code>${from.id}</code>\n` +
            `⚖️ Punição: <b>${PUNISHMENT_LABEL[groupConfig.punishment]}</b>\n` +
            `📊 Avisos: <b>${warnCount}/${groupConfig.maxWarns}</b>`
          );
        } catch {
          await ctx.reply(
            `⛔ ${userMention} atingiu o limite de avisos. Não tenho permissão para aplicar a punição — remova manualmente.`,
            { parse_mode: "HTML" }
          );
        }
      } else {
        await ctx.reply(
          `⚠️ ${userMention} recebeu um aviso automático por conteúdo ofensivo.\n` +
            `📋 Categoria: <i>${analysis.offensiveCategory}</i>\n` +
            `📊 Avisos: <b>${warnCount}/${groupConfig.maxWarns}</b>`,
          { parse_mode: "HTML" }
        );
      }
    }
  });

  return bot;
}

// ── Exports ────────────────────────────────────────────────────────────────────

export default {
  // Webhook: called by Telegram on every update
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }
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
