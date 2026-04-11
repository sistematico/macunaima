import type { Api, Bot, Context, InlineKeyboard as IKType } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MessageEntity, User } from "grammy/types";
import type { Env } from "./index";
import { sendLog, ulink, esc } from "./logger";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Punishment = "ban" | "kick" | "mute";
export type AntiPromotionAction = "warn" | "ban" | "kick" | "delete";

export interface GroupConfig {
  maxWarns: number;
  punishment: Punishment;
  /** Whether the bot should detect and remove spam/scam messages (default: true) */
  spamDetection: boolean;
  /** Whether the bot should auto-warn for offensive content (default: true) */
  offensiveDetection: boolean;
  /** Whether the bot should block promotion of other groups/channels (default: true) */
  antiPromotion: boolean;
  /** Action to take when promotion is detected (default: "warn") */
  antiPromotionAction: AntiPromotionAction;
  /** Optional URL for group rules button shown after captcha approval */
  rulesUrl: string | null;
  /** Whether non-admin commands should be deleted in group chats */
  deleteNonAdminCommands: boolean;
}

/** Per-user, per-chat warn data stored in KV. */
export interface WarnData {
  count: number;
  /** Reasons for each warn, in chronological order (newest last). */
  reasons: string[];
}

/** Entry in the cross-group user index. */
interface WarnIndexEntry {
  chatId: number;
  title: string;
}

const DEFAULT_CONFIG: GroupConfig = {
  maxWarns: 3,
  punishment: "ban",
  spamDetection: true,
  offensiveDetection: true,
  antiPromotion: true,
  antiPromotionAction: "warn",
  rulesUrl: null,
  deleteNonAdminCommands: false,
};

// ── KV key helpers ─────────────────────────────────────────────────────────────

const warnKey   = (chatId: number, userId: number) => `warns:${chatId}:${userId}`;
const idxKey    = (userId: number)                 => `warnidx:${userId}`;
const configKey = (chatId: number)                 => `group_config:${chatId}`;

// ── Config helpers ─────────────────────────────────────────────────────────────

export async function saveConfig(
  kv: KVNamespace,
  chatId: number,
  patch: Partial<GroupConfig>
): Promise<GroupConfig> {
  const updated = { ...(await getConfig(kv, chatId)), ...patch };
  await kv.put(configKey(chatId), JSON.stringify(updated));
  return updated;
}

export async function getConfig(
  kv: KVNamespace,
  chatId: number
): Promise<GroupConfig> {
  return (await kv.get<GroupConfig>(configKey(chatId), "json")) ?? { ...DEFAULT_CONFIG };
}

// ── Warn data helpers ──────────────────────────────────────────────────────────

async function readWarnData(kv: KVNamespace, chatId: number, userId: number): Promise<WarnData> {
  const raw = await kv.get(warnKey(chatId, userId));
  if (!raw) return { count: 0, reasons: [] };
  // Backward-compat: old format was a plain number string
  if (/^\d+$/.test(raw.trim())) return { count: parseInt(raw, 10), reasons: [] };
  try {
    return JSON.parse(raw) as WarnData;
  } catch {
    return { count: 0, reasons: [] };
  }
}

async function writeWarnData(kv: KVNamespace, chatId: number, userId: number, data: WarnData): Promise<void> {
  if (data.count <= 0) {
    await kv.delete(warnKey(chatId, userId));
  } else {
    await kv.put(warnKey(chatId, userId), JSON.stringify(data));
  }
}

/** Update the cross-group user index (add or remove a chatId entry). */
async function updateUserIndex(
  kv: KVNamespace,
  userId: number,
  chatId: number,
  title: string,
  hasWarns: boolean
): Promise<void> {
  const raw = await kv.get(idxKey(userId));
  let entries: WarnIndexEntry[] = [];
  try { if (raw) entries = JSON.parse(raw) as WarnIndexEntry[]; } catch { /* ignore */ }

  entries = entries.filter((e) => e.chatId !== chatId);
  if (hasWarns) entries.push({ chatId, title });

  if (entries.length === 0) {
    await kv.delete(idxKey(userId));
  } else {
    await kv.put(idxKey(userId), JSON.stringify(entries));
  }
}

export async function getWarnCount(kv: KVNamespace, chatId: number, userId: number): Promise<number> {
  return (await readWarnData(kv, chatId, userId)).count;
}

export async function getWarnData(kv: KVNamespace, chatId: number, userId: number): Promise<WarnData> {
  return readWarnData(kv, chatId, userId);
}

/** Returns all groups where userId has at least one warn. */
export async function getUserWarnIndex(kv: KVNamespace, userId: number): Promise<WarnIndexEntry[]> {
  const raw = await kv.get(idxKey(userId));
  if (!raw) return [];
  try { return JSON.parse(raw) as WarnIndexEntry[]; } catch { return []; }
}

/** Lists all user IDs that have warns in a given chat. */
export async function listWarnedUsers(kv: KVNamespace, chatId: number): Promise<number[]> {
  const prefix = `warns:${chatId}:`;
  const listed = await kv.list({ prefix });
  return listed.keys
    .map((k) => parseInt(k.name.slice(prefix.length), 10))
    .filter((id) => !isNaN(id));
}

export async function addWarn(
  kv: KVNamespace,
  chatId: number,
  userId: number,
  chatTitle: string = "",
  reason: string = ""
): Promise<number> {
  const data = await readWarnData(kv, chatId, userId);
  data.count++;
  data.reasons.push(reason || "Sem motivo informado");
  if (data.reasons.length > 20) data.reasons = data.reasons.slice(-20); // keep last 20
  await writeWarnData(kv, chatId, userId, data);
  await updateUserIndex(kv, userId, chatId, chatTitle, true);
  return data.count;
}

export async function removeWarn(
  kv: KVNamespace,
  chatId: number,
  userId: number,
  chatTitle: string = ""
): Promise<number> {
  const data = await readWarnData(kv, chatId, userId);
  if (data.count <= 0) return 0;
  data.count--;
  data.reasons.pop();
  await writeWarnData(kv, chatId, userId, data);
  await updateUserIndex(kv, userId, chatId, chatTitle, data.count > 0);
  return data.count;
}

export async function clearWarns(
  kv: KVNamespace,
  chatId: number,
  userId: number,
  chatTitle: string = ""
): Promise<void> {
  await writeWarnData(kv, chatId, userId, { count: 0, reasons: [] });
  await updateUserIndex(kv, userId, chatId, chatTitle, false);
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export const PUNISHMENT_LABEL: Record<Punishment, string> = {
  ban:  "banido permanentemente",
  kick: "removido do grupo",
  mute: "silenciado permanentemente",
};

export const ANTI_PROMOTION_ACTION_LABEL: Record<AntiPromotionAction, string> = {
  warn:   "apagar + avisar",
  ban:    "apagar + banir",
  kick:   "apagar + expulsar",
  delete: "somente apagar",
};

function mention(user: User): string {
  return `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
}

function reasonsList(reasons: string[]): string {
  if (reasons.length === 0) return "";
  return "\n📝 Motivos:\n" + reasons.map((r, i) => `  ${i + 1}. ${esc(r)}`).join("\n");
}

/** Build the inline keyboard attached to a warn message. */
export function warnKeyboard(chatId: number, userId: number): IKType {
  return new InlineKeyboard().text(
    "↩️ Remover aviso",
    `rwarn_btn:${chatId}:${userId}`
  );
}

/**
 * Strips "/command[@bot] [mention]" from the message text and returns the rest
 * as the warn reason.
 */
function parseReason(text: string, entities: MessageEntity[]): string {
  const cmdMatch = /^\/\w+(?:@\S+)?\s*/i.exec(text);
  const cmdEnd = cmdMatch?.[0].length ?? 0;
  let result = text.slice(cmdEnd);

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
 *  2. A text_mention entity
 *  3. A @username mention (resolved via getChat)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveTarget(ctx: any): Promise<User | null> {
  const reply = ctx.message?.reply_to_message;
  if (reply?.from && !reply.from.is_bot) return reply.from as User;

  const entities: MessageEntity[] = ctx.message?.entities ?? [];
  const text: string = ctx.message?.text ?? "";

  for (const e of entities) {
    if (e.type === "text_mention") {
      if (!e.user.is_bot) return e.user;
      continue;
    }
    if (e.type === "mention") {
      const username = text.slice(e.offset + 1, e.offset + e.length);
      try {
        const chat = await (ctx.api as Context["api"]).getChat(`@${username}`);
        if (chat.type === "private") {
          return { id: chat.id, first_name: chat.first_name, is_bot: false } as User;
        }
      } catch { /* unknown username */ }
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

async function isAdminInChat(api: Api, chatId: number, userId: number): Promise<boolean> {
  try {
    const m = await api.getChatMember(chatId, userId);
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
    await api.restrictChatMember(chatId, userId, {
      can_send_messages:       false,
      can_send_audios:         false,
      can_send_documents:      false,
      can_send_photos:         false,
      can_send_videos:         false,
      can_send_video_notes:    false,
      can_send_voice_notes:    false,
      can_send_polls:          false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    });
  }
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerWarnCommands(bot: Bot, env: Env): void {
  const kv = env.SPAM_KV;

  const inGroup = (ctx: Context) =>
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  const requireAdmin = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from) return false;
    if (await isAdmin(ctx, ctx.from.id)) return true;
    await ctx.reply("❌ Apenas administradores podem usar este comando.");
    return false;
  };

  // ── /warn ──────────────────────────────────────────────────────────────────

  bot.command("warn", async (ctx) => {
    if (!inGroup(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply(
        "❌ Responda a uma mensagem ou mencione o usuário.\n" +
        "Exemplos:\n" +
        "• <code>/warn [motivo]</code> (respondendo a mensagem)\n" +
        "• <code>/warn @usuário [motivo]</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (await isAdmin(ctx, target.id)) {
      await ctx.reply("❌ Não é possível advertir um administrador.");
      return;
    }

    const reason = parseReason(ctx.message?.text ?? "", ctx.message?.entities ?? []);
    const chatTitle = (ctx.chat as { title?: string }).title ?? "";
    const admin = ctx.from!;

    // Delete the replied-to message and the command
    const replied = ctx.message?.reply_to_message;
    if (replied) await ctx.api.deleteMessage(ctx.chat!.id, replied.message_id).catch(() => undefined);
    await ctx.deleteMessage().catch(() => undefined);

    const config = await getConfig(kv, ctx.chat!.id);
    const warnCount = await addWarn(kv, ctx.chat!.id, target.id, chatTitle, reason);

    if (warnCount >= config.maxWarns) {
      try {
        await applyPunishment(ctx.api, ctx.chat!.id, target.id, config.punishment);
        await clearWarns(kv, ctx.chat!.id, target.id, chatTitle);
      } catch { /* no permission */ }

      await ctx.reply(
        `🚫 ${mention(target)} atingiu <b>${warnCount}/${config.maxWarns}</b> avisos.\n` +
        `Punição: <b>${PUNISHMENT_LABEL[config.punishment]}</b>` +
        (reason ? `\n📝 Motivo: <i>${esc(reason)}</i>` : ""),
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
        (reason ? `\n📝 Motivo: <i>${esc(reason)}</i>` : ""),
        {
          parse_mode: "HTML",
          reply_markup: warnKeyboard(ctx.chat!.id, target.id),
        }
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

  // ── /rwarn — remove 1 warn ─────────────────────────────────────────────────

  bot.command(["rwarn", "unwarn"], async (ctx) => {
    if (!inGroup(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply("❌ Responda a uma mensagem ou mencione o usuário.");
      return;
    }

    await ctx.deleteMessage().catch(() => undefined);

    const chatTitle = (ctx.chat as { title?: string }).title ?? "";
    const remaining = await removeWarn(kv, ctx.chat!.id, target.id, chatTitle);
    const config = await getConfig(kv, ctx.chat!.id);

    await ctx.reply(
      `↩️ Um aviso de ${mention(target)} foi removido.\n` +
      `📊 Avisos: <b>${remaining}/${config.maxWarns}</b>`,
      { parse_mode: "HTML" }
    );
    await sendLog(ctx.api, kv, ctx.chat!.id, chatTitle,
      `↩️ <b>AVISO REMOVIDO</b>\n\n` +
      `👤 Usuário: ${ulink(target.id, target.first_name)} <code>${target.id}</code>\n` +
      `👮 Admin: ${ulink(ctx.from!.id, ctx.from!.first_name)}\n` +
      `📊 Avisos restantes: <b>${remaining}/${config.maxWarns}</b>`
    );
  });

  // ── /cwarn — clear all warns ───────────────────────────────────────────────

  bot.command(["cwarn", "resetwarns"], async (ctx) => {
    if (!inGroup(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.reply("❌ Responda a uma mensagem ou mencione o usuário.");
      return;
    }

    await ctx.deleteMessage().catch(() => undefined);

    const chatTitle = (ctx.chat as { title?: string }).title ?? "";
    await clearWarns(kv, ctx.chat!.id, target.id, chatTitle);
    const config = await getConfig(kv, ctx.chat!.id);

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

  // ── /warns — different behaviour per context ───────────────────────────────
  //
  //  Group:   /warns @usuario  →  shows that user's warn count + reasons, then deletes command
  //  Private: /warns @usuario  →  shows all groups where user has warns

  bot.command("warns", async (ctx) => {
    // ── Private: cross-group summary for a user ────────────────────────────
    if (ctx.chat?.type === "private") {
      const target = await resolveTarget(ctx);
      if (!target) {
        await ctx.reply(
          "❌ Mencione o usuário.\nExemplo: <code>/warns @usuario</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const entries = await getUserWarnIndex(kv, target.id);
      if (entries.length === 0) {
        await ctx.reply(
          `✅ ${mention(target)} não possui avisos em nenhum grupo.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Fetch actual counts for each group
      const lines: string[] = [];
      let total = 0;
      for (const entry of entries) {
        const data = await readWarnData(kv, entry.chatId, target.id);
        if (data.count > 0) {
          total += data.count;
          lines.push(`• <b>${esc(entry.title)}</b>: <b>${data.count}</b> aviso(s)${reasonsList(data.reasons)}`);
        }
      }

      if (lines.length === 0) {
        await ctx.reply(`✅ ${mention(target)} não possui avisos ativos.`, { parse_mode: "HTML" });
        return;
      }

      await ctx.reply(
        `📊 <b>Avisos de ${mention(target)}</b>\n\n` +
        lines.join("\n\n") +
        `\n\n<b>Total: ${total} aviso(s)</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── Group: show specific user's warns + delete command ─────────────────
    if (!inGroup(ctx)) return;

    const target = await resolveTarget(ctx);
    if (!target) {
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    await ctx.deleteMessage().catch(() => undefined);

    const data = await readWarnData(kv, ctx.chat!.id, target.id);
    const config = await getConfig(kv, ctx.chat!.id);

    await ctx.reply(
      `📊 Avisos de ${mention(target)}: <b>${data.count}/${config.maxWarns}</b>` +
      reasonsList(data.reasons),
      { parse_mode: "HTML" }
    );
  });

  // ── Inline button: ↩️ Remover aviso ──────────────────────────────────────
  //
  // Callback data format: rwarn_btn:{chatId}:{userId}

  bot.callbackQuery(/^rwarn_btn:(-?\d+):(\d+)$/, async (ctx) => {
    const [, chatIdStr, userIdStr] = ctx.match;
    const chatId = parseInt(chatIdStr!, 10);
    const userId = parseInt(userIdStr!, 10);
    const clicker = ctx.from;

    if (!clicker) {
      await ctx.answerCallbackQuery({ text: "Erro desconhecido." });
      return;
    }

    // Verify the clicker is an admin of that chat
    if (!await isAdminInChat(ctx.api, chatId, clicker.id)) {
      await ctx.answerCallbackQuery({
        text: "❌ Apenas administradores podem remover avisos.",
        show_alert: true,
      });
      return;
    }

    let chatTitle = "";
    try {
      const chatInfo = await ctx.api.getChat(chatId);
      chatTitle = (chatInfo as { title?: string }).title ?? "";
    } catch { /* ignore */ }

    const remaining = await removeWarn(kv, chatId, userId, chatTitle);
    const config = await getConfig(kv, chatId);

    // Update the message to reflect the new count (remove the button when 0 warns left)
    const newText =
      remaining > 0
        ? ctx.callbackQuery.message?.text?.replace(
            /📊 Avisos: \*\*\d+\/\d+\*\*/,
            `📊 Avisos: **${remaining}/${config.maxWarns}**`
          ) ??
          `↩️ Aviso removido. Avisos restantes: <b>${remaining}/${config.maxWarns}</b>`
        : `✅ Todos os avisos foram removidos.`;

    await ctx.editMessageText(newText, {
      parse_mode: "HTML",
      reply_markup: remaining > 0 ? warnKeyboard(chatId, userId) : undefined,
    }).catch(() => undefined);

    await ctx.answerCallbackQuery({
      text: remaining > 0
        ? `↩️ Aviso removido. Restam ${remaining}/${config.maxWarns}.`
        : "✅ Todos os avisos foram removidos.",
    });

    await sendLog(ctx.api, kv, chatId, chatTitle,
      `↩️ <b>AVISO REMOVIDO (botão)</b>\n\n` +
      `👤 Usuário ID: <code>${userId}</code>\n` +
      `👮 Admin: ${ulink(clicker.id, clicker.first_name)}\n` +
      `📊 Avisos restantes: <b>${remaining}/${config.maxWarns}</b>`
    );
  });

  // ── /setwarnlimit ──────────────────────────────────────────────────────────

  bot.command("setwarnlimit", async (ctx) => {
    if (!inGroup(ctx)) return;
    if (!await requireAdmin(ctx)) return;

    const text = ctx.message?.text ?? "";
    const match = /^\/setwarnlimit(?:@\S+)?\s+(\d+)/i.exec(text);
    const n = match ? parseInt(match[1]!, 10) : NaN;

    if (isNaN(n) || n < 1 || n > 20) {
      await ctx.reply("❌ Uso: <code>/setwarnlimit &lt;1–20&gt;</code>", { parse_mode: "HTML" });
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
    if (!inGroup(ctx)) return;
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
    if (!inGroup(ctx)) return;
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

    await saveConfig(kv, ctx.chat!.id, { offensiveDetection: value === "on" });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      value === "on"
        ? "✅ Detecção de conteúdo ofensivo <b>ativada</b>."
        : "✅ Detecção de conteúdo ofensivo <b>desativada</b>.",
      { parse_mode: "HTML" }
    );
  });

  // ── /setantipromotion ─────────────────────────────────────────────────────

  bot.command("setantipromotion", async (ctx) => {
    if (!inGroup(ctx)) return;
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

    await saveConfig(kv, ctx.chat!.id, { antiPromotion: value === "on" });
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      value === "on"
        ? "✅ Anti-divulgação <b>ativada</b>. Links de grupos/canais serão bloqueados."
        : "✅ Anti-divulgação <b>desativada</b>. Links de grupos/canais não serão bloqueados.",
      { parse_mode: "HTML" }
    );
  });

  // ── /setpromotionaction ───────────────────────────────────────────────────

  bot.command("setpromotionaction", async (ctx) => {
    if (!inGroup(ctx)) return;
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
