import type { Api, Bot, Context } from "grammy";
import type { MessageEntity, User } from "grammy/types";
import type { Env } from "./index";
import { sendLog, ulink, esc } from "./logger";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Punishment = "ban" | "kick" | "mute";
export type AntiPromotionAction = "warn" | "ban" | "kick" | "delete";

export interface GroupConfig {
  maxWarns: number;
  punishment: Punishment;
  /** Whether the bot should auto-warn for offensive content (default: true) */
  offensiveDetection: boolean;
  /** Whether the bot should block promotion of other groups/channels (default: true) */
  antiPromotion: boolean;
  /** Action to take when promotion is detected (default: "warn") */
  antiPromotionAction: AntiPromotionAction;
}

const DEFAULT_CONFIG: GroupConfig = {
  maxWarns: 3,
  punishment: "ban",
  offensiveDetection: true,
  antiPromotion: true,
  antiPromotionAction: "warn",
};

// ── KV helpers ─────────────────────────────────────────────────────────────────

const warnKey = (chatId: number, userId: number) =>
  `warns:${chatId}:${userId}`;
const configKey = (chatId: number) => `group_config:${chatId}`;

async function saveConfig(
  kv: KVNamespace,
  chatId: number,
  patch: Partial<GroupConfig>
): Promise<GroupConfig> {
  const updated = { ...(await getConfig(kv, chatId)), ...patch };
  await kv.put(configKey(chatId), JSON.stringify(updated));
  return updated;
}

export async function getWarnCount(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<number> {
  return parseInt((await kv.get(warnKey(chatId, userId))) ?? "0", 10);
}

export async function addWarn(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<number> {
  const next = (await getWarnCount(kv, chatId, userId)) + 1;
  await kv.put(warnKey(chatId, userId), String(next));
  return next;
}

async function removeWarn(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<number> {
  const current = await getWarnCount(kv, chatId, userId);
  const next = Math.max(0, current - 1);
  if (next === 0) await kv.delete(warnKey(chatId, userId));
  else await kv.put(warnKey(chatId, userId), String(next));
  return next;
}

export async function clearWarns(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<void> {
  await kv.delete(warnKey(chatId, userId));
}

export async function getConfig(
  kv: KVNamespace,
  chatId: number
): Promise<GroupConfig> {
  return (
    (await kv.get<GroupConfig>(configKey(chatId), "json")) ?? {
      ...DEFAULT_CONFIG,
    }
  );
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export const PUNISHMENT_LABEL: Record<Punishment, string> = {
  ban: "banido permanentemente",
  kick: "removido do grupo",
  mute: "silenciado permanentemente",
};

export const ANTI_PROMOTION_ACTION_LABEL: Record<AntiPromotionAction, string> = {
  warn: "apagar + avisar",
  ban: "apagar + banir",
  kick: "apagar + expulsar",
  delete: "somente apagar",
};

function mention(user: User): string {
  return `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
}

/**
 * Strips "/command[@bot] [mention]" from the message text and returns the rest
 * as the warn reason.
 */
function parseReason(text: string, entities: MessageEntity[]): string {
  const cmdMatch = /^\/\w+(?:@\S+)?\s*/i.exec(text);
  const cmdEnd = cmdMatch?.[0].length ?? 0;
  let result = text.slice(cmdEnd);

  // If the first remaining entity is a mention, strip it too
  for (const e of entities) {
    if (e.type !== "mention" && e.type !== "text_mention") continue;
    if (e.offset - cmdEnd === 0) {
      result = result.slice(e.length).trimStart();
      break;
    }
  }

  return result.trim();
}

/**
 * Resolves the target user from:
 *  1. The replied-to message
 *  2. A text_mention entity (clickable, carries User object)
 *  3. A @username mention (resolved via getChat)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveTarget(ctx: any): Promise<User | null> {
  // 1. Reply
  const reply = ctx.message?.reply_to_message;
  if (reply?.from && !reply.from.is_bot) return reply.from as User;

  const entities: MessageEntity[] = ctx.message?.entities ?? [];
  const text: string = ctx.message?.text ?? "";

  for (const e of entities) {
    // 2. Clickable mention (text_mention carries the full User object)
    if (e.type === "text_mention") {
      if (!e.user.is_bot) return e.user;
      continue;
    }

    // 3. Plain @username — resolve via Telegram
    if (e.type === "mention") {
      const username = text.slice(e.offset + 1, e.offset + e.length);
      try {
        const chat = await (ctx.api as Context["api"]).getChat(
          `@${username}`
        );
        if (chat.type === "private") {
          return {
            id: chat.id,
            first_name: chat.first_name,
            is_bot: false,
          } as User;
        }
      } catch {
        /* unknown or private username */
      }
    }
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isAdmin(ctx: any, userId: number): Promise<boolean> {
  try {
    const m = await ctx.getChatMember(userId);
    return m.status === "administrator" || m.status === "creator";
  } catch {
    return false;
  }
}

export async function applyPunishment(
  api: Api,
  chatId: number,
  userId: number,
  p: Punishment
): Promise<void> {
  if (p === "ban") {
    await api.banChatMember(chatId, userId);
  } else if (p === "kick") {
    await api.banChatMember(chatId, userId);
    await api.unbanChatMember(chatId, userId);
  } else {
    // mute: strip all send permissions
    await api.restrictChatMember(chatId, userId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    });
  }
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerWarnCommands(bot: Bot, env: Env): void {
  const kv = env.SPAM_KV;

  const groupOnly = async (ctx: Context): Promise<boolean> => {
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return false;
    return true;
  };

  const requireAdmin = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from) return false;
    if (await isAdmin(ctx, ctx.from.id)) return true;
    await ctx.reply("❌ Apenas administradores podem usar este comando.");
    return false;
  };

  // ── /warn ──────────────────────────────────────────────────────────────────

  bot.command("warn", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply(
        "❌ Responda a uma mensagem ou mencione o usuário.\n" +
          "Exemplos:\n" +
          "• <code>/warn motivo</code> (respondendo a mensagem)\n" +
          "• <code>/warn @usuário motivo</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (await isAdmin(ctx, target.id)) {
      await ctx.reply("❌ Não é possível advertir um administrador.");
      return;
    }

    const reason = parseReason(
      ctx.message?.text ?? "",
      ctx.message?.entities ?? []
    );

    // Delete both messages silently
    const replied = ctx.message?.reply_to_message;
    if (replied) {
      await ctx.api
        .deleteMessage(ctx.chat!.id, replied.message_id)
        .catch(() => undefined);
    }
    await ctx.deleteMessage().catch(() => undefined);

    const config = await getConfig(kv, ctx.chat!.id);
    const warnCount = await addWarn(kv, ctx.chat!.id, target.id);
    const chatTitle = (ctx.chat as { title: string }).title;
    const admin = ctx.from!;

    if (warnCount >= config.maxWarns) {
      try {
        await applyPunishment(ctx.api, ctx.chat!.id, target.id, config.punishment);
        await clearWarns(kv, ctx.chat!.id, target.id);
      } catch {
        /* no permission */
      }
      await ctx.reply(
        `🚫 ${mention(target)} atingiu <b>${warnCount}/${config.maxWarns}</b> avisos.\n` +
          `Punição: <b>${PUNISHMENT_LABEL[config.punishment]}</b>` +
          (reason ? `\n📝 Motivo: <i>${reason}</i>` : ""),
        { parse_mode: "HTML" }
      );
      await sendLog(ctx.api, kv, ctx.chat!.id, chatTitle,
        `🚫 <b>PUNIÇÃO APLICADA</b>\n\n` +
        `👤 Usuário: ${ulink(target.id, target.first_name)} <code>${target.id}</code>\n` +
        `👮 Admin: ${ulink(admin.id, admin.first_name)}\n` +
        `⚖️ Punição: <b>${PUNISHMENT_LABEL[config.punishment]}</b>\n` +
        `📊 Avisos: <b>${warnCount}/${config.maxWarns}</b>` +
        (reason ? `\n📝 Motivo: <i>${esc(reason)}</i>` : "")
      );
    } else {
      await ctx.reply(
        `⚠️ ${mention(target)} recebeu um aviso.\n` +
          `📊 Avisos: <b>${warnCount}/${config.maxWarns}</b>` +
          (reason ? `\n📝 Motivo: <i>${reason}</i>` : ""),
        { parse_mode: "HTML" }
      );
      await sendLog(ctx.api, kv, ctx.chat!.id, chatTitle,
        `⚠️ <b>AVISO APLICADO</b>\n\n` +
        `👤 Usuário: ${ulink(target.id, target.first_name)} <code>${target.id}</code>\n` +
        `👮 Admin: ${ulink(admin.id, admin.first_name)}\n` +
        `📊 Avisos: <b>${warnCount}/${config.maxWarns}</b>` +
        (reason ? `\n📝 Motivo: <i>${esc(reason)}</i>` : "")
      );
    }
  });

  // ── /unwarn ────────────────────────────────────────────────────────────────

  bot.command("unwarn", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply("❌ Responda a uma mensagem ou mencione o usuário.");
      return;
    }

    await ctx.deleteMessage().catch(() => undefined);

    const warnCount = await removeWarn(kv, ctx.chat!.id, target.id);
    const config = await getConfig(kv, ctx.chat!.id);
    const chatTitle = (ctx.chat as { title: string }).title;

    await ctx.reply(
      `✅ Um aviso de ${mention(target)} foi removido.\n` +
        `📊 Avisos: <b>${warnCount}/${config.maxWarns}</b>`,
      { parse_mode: "HTML" }
    );
    await sendLog(ctx.api, kv, ctx.chat!.id, chatTitle,
      `✅ <b>AVISO REMOVIDO</b>\n\n` +
      `👤 Usuário: ${ulink(target.id, target.first_name)} <code>${target.id}</code>\n` +
      `👮 Admin: ${ulink(ctx.from!.id, ctx.from!.first_name)}\n` +
      `📊 Avisos restantes: <b>${warnCount}/${config.maxWarns}</b>`
    );
  });

  // ── /resetwarns ────────────────────────────────────────────────────────────

  bot.command("resetwarns", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply("❌ Responda a uma mensagem ou mencione o usuário.");
      return;
    }

    await ctx.deleteMessage().catch(() => undefined);
    await clearWarns(kv, ctx.chat!.id, target.id);

    const config = await getConfig(kv, ctx.chat!.id);
    const chatTitle = (ctx.chat as { title: string }).title;

    await ctx.reply(
      `🔄 Todos os avisos de ${mention(target)} foram zerados.\n` +
        `📊 Avisos: <b>0/${config.maxWarns}</b>`,
      { parse_mode: "HTML" }
    );
    await sendLog(ctx.api, kv, ctx.chat!.id, chatTitle,
      `🔄 <b>AVISOS ZERADOS</b>\n\n` +
      `👤 Usuário: ${ulink(target.id, target.first_name)} <code>${target.id}</code>\n` +
      `👮 Admin: ${ulink(ctx.from!.id, ctx.from!.first_name)}`
    );
  });

  // ── /warns ─────────────────────────────────────────────────────────────────

  bot.command("warns", async (ctx) => {
    if (!await groupOnly(ctx)) return;

    // Default to the caller when no target is specified
    const target = (await resolveTarget(ctx)) ?? ctx.from;
    if (!target) return;

    const warnCount = await getWarnCount(kv, ctx.chat!.id, target.id);
    const config = await getConfig(kv, ctx.chat!.id);

    await ctx.reply(
      `📊 Avisos de ${mention(target)}: <b>${warnCount}/${config.maxWarns}</b>\n` +
        `Punição ao atingir o limite: <i>${PUNISHMENT_LABEL[config.punishment]}</i>`,
      { parse_mode: "HTML" }
    );
  });

  // ── /setwarnlimit ──────────────────────────────────────────────────────────

  bot.command("setwarnlimit", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setwarnlimit(?:@\S+)?\s+(\d+)/i.exec(text);
    const n = match ? parseInt(match[1]!, 10) : NaN;

    if (isNaN(n) || n < 1 || n > 20) {
      await ctx.reply(
        "❌ Uso: <code>/setwarnlimit &lt;1–20&gt;</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    const config = await saveConfig(kv, ctx.chat!.id, { maxWarns: n });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      `✅ Limite de avisos: <b>${config.maxWarns}</b>\n` +
        `Punição atual: <i>${PUNISHMENT_LABEL[config.punishment]}</i>`,
      { parse_mode: "HTML" }
    );
  });

  // ── /setwarnpunishment ─────────────────────────────────────────────────────

  bot.command("setwarnpunishment", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setwarnpunishment(?:@\S+)?\s+(ban|kick|mute)/i.exec(text);
    const punishment = match?.[1]?.toLowerCase() as Punishment | undefined;

    if (!punishment) {
      await ctx.reply(
        "❌ Uso: <code>/setwarnpunishment &lt;ban|kick|mute&gt;</code>\n\n" +
          "• <b>ban</b> — banimento permanente\n" +
          "• <b>kick</b> — remove do grupo (pode voltar)\n" +
          "• <b>mute</b> — silencia permanentemente",
        { parse_mode: "HTML" }
      );
      return;
    }

    const config = await saveConfig(kv, ctx.chat!.id, { punishment });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      `✅ Punição definida: <b>${PUNISHMENT_LABEL[config.punishment]}</b>\n` +
        `Limite atual: <i>${config.maxWarns} avisos</i>`,
      { parse_mode: "HTML" }
    );
  });

  // ── /setoffensive ──────────────────────────────────────────────────────────

  bot.command("setoffensive", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setoffensive(?:@\S+)?\s+(on|off)/i.exec(text);
    const value = match?.[1]?.toLowerCase();

    if (!value) {
      await ctx.reply(
        "❌ Uso: <code>/setoffensive &lt;on|off&gt;</code>\n\n" +
          "• <b>on</b> — ativa detecção automática de conteúdo ofensivo\n" +
          "• <b>off</b> — desativa (spam ainda é detectado normalmente)",
        { parse_mode: "HTML" }
      );
      return;
    }

    const enabled = value === "on";
    await saveConfig(kv, ctx.chat!.id, { offensiveDetection: enabled });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      enabled
        ? "✅ Detecção de conteúdo ofensivo <b>ativada</b>."
        : "✅ Detecção de conteúdo ofensivo <b>desativada</b>.",
      { parse_mode: "HTML" }
    );
  });

  // ── /setantipromotion ─────────────────────────────────────────────────────

  bot.command("setantipromotion", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setantipromotion(?:@\S+)?\s+(on|off)/i.exec(text);
    const value = match?.[1]?.toLowerCase();

    if (!value) {
      const config = await getConfig(kv, ctx.chat!.id);
      await ctx.reply(
        "❌ Uso: <code>/setantipromotion &lt;on|off&gt;</code>\n\n" +
          "• <b>on</b> — bloqueia divulgação de outros grupos/canais\n" +
          "• <b>off</b> — permite links de grupos/canais\n\n" +
          `Status atual: <b>${config.antiPromotion ? "ativado" : "desativado"}</b>\n` +
          `Ação atual: <b>${ANTI_PROMOTION_ACTION_LABEL[config.antiPromotionAction]}</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const enabled = value === "on";
    await saveConfig(kv, ctx.chat!.id, { antiPromotion: enabled });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      enabled
        ? "✅ Anti-divulgação <b>ativada</b>. Links de grupos/canais serão bloqueados."
        : "✅ Anti-divulgação <b>desativada</b>. Links de grupos/canais não serão bloqueados.",
      { parse_mode: "HTML" }
    );
  });

  // ── /setpromotionaction ───────────────────────────────────────────────────

  bot.command("setpromotionaction", async (ctx) => {
    if (!await groupOnly(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setpromotionaction(?:@\S+)?\s+(warn|ban|kick|delete)/i.exec(text);
    const action = match?.[1]?.toLowerCase() as AntiPromotionAction | undefined;

    if (!action) {
      const config = await getConfig(kv, ctx.chat!.id);
      await ctx.reply(
        "❌ Uso: <code>/setpromotionaction &lt;warn|ban|kick|delete&gt;</code>\n\n" +
          "• <b>warn</b> — apaga a mensagem e aplica um aviso (padrão)\n" +
          "• <b>ban</b> — apaga a mensagem e bane o usuário\n" +
          "• <b>kick</b> — apaga a mensagem e expulsa o usuário\n" +
          "• <b>delete</b> — somente apaga a mensagem\n\n" +
          `Ação atual: <b>${ANTI_PROMOTION_ACTION_LABEL[config.antiPromotionAction]}</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const config = await saveConfig(kv, ctx.chat!.id, { antiPromotionAction: action });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      `✅ Ação anti-divulgação definida: <b>${ANTI_PROMOTION_ACTION_LABEL[config.antiPromotionAction]}</b>`,
      { parse_mode: "HTML" }
    );
  });
}
