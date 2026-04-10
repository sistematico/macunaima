import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry } from "./retry";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ContentAnalysis {
  isSpam: boolean;
  spamConfidence: number;
  spamCategory: string;
  isOffensive: boolean;
  offensiveConfidence: number;
  offensiveCategory: string;
  reason: string;
}

const DEFAULT_ANALYSIS: ContentAnalysis = {
  isSpam: false,
  spamConfidence: 0,
  spamCategory: "legitimate",
  isOffensive: false,
  offensiveConfidence: 0,
  offensiveCategory: "clean",
  reason: "Sem sinais de abuso",
};

const SPAM_OR_SCAM_PATTERN =
  /\b(bet|bets|cassino|aposta|apostas|slot|roleta|tigrinho|jogo\s*do\s*tigre|golpe|golpista|fraude|phishing|hacke|cart[aã]o\s*clonado|pix\s*gr[aá]tis|renda\s*extra|trader|forex|cripto|bitcoin|sinal\s*vip|grupo\s*vip|empr[eé]stimo\s*f[aá]cil)\b/i;

const ADULT_PATTERN =
  /\b(onlyfans|privacy|conte[úu]do\s*adulto|pack\s*vip|nudes?|sexo|er[oó]tico|acompanhante|escort|gp\b|garota\s*de\s*programa|massagem\s*sensual|webcam\s*adulta|porn[oô])\b/i;

const SUSPICIOUS_LINK_PATTERN =
  /(bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|t\.me\/\+|wa\.me\/|grabify|iplogger|discord\.gg)/i;

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFences) as Record<string, unknown>;
  } catch {
    const match = withoutFences.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function normalizeModelOutput(parsed: Record<string, unknown>): ContentAnalysis {
  return {
    isSpam: Boolean(parsed.isSpam),
    spamConfidence: clamp01(parsed.spamConfidence),
    spamCategory: String(parsed.spamCategory ?? "legitimate"),
    isOffensive: Boolean(parsed.isOffensive),
    offensiveConfidence: clamp01(parsed.offensiveConfidence),
    offensiveCategory: String(parsed.offensiveCategory ?? "clean"),
    reason: String(parsed.reason ?? "Classificação automática"),
  };
}

function heuristicAnalysis(text: string, links: string[]): ContentAnalysis {
  const haystack = `${text} ${links.join(" ")}`;
  const hasAdultSignal = ADULT_PATTERN.test(haystack);
  const hasScamSignal = SPAM_OR_SCAM_PATTERN.test(haystack);
  const hasSuspiciousLink = links.some((l) => SUSPICIOUS_LINK_PATTERN.test(l));

  if (hasAdultSignal) {
    return {
      isSpam: true,
      spamConfidence: 0.9,
      spamCategory: "adult_solicitation",
      isOffensive: true,
      offensiveConfidence: 0.86,
      offensiveCategory: "sexual_explicit",
      reason: "Padrões de conteúdo sexual/erótico detectados",
    };
  }

  if (hasScamSignal || hasSuspiciousLink) {
    return {
      isSpam: true,
      spamConfidence: hasSuspiciousLink ? 0.9 : 0.84,
      spamCategory: hasSuspiciousLink ? "suspicious_link" : "scam_or_bet",
      isOffensive: false,
      offensiveConfidence: 0,
      offensiveCategory: "clean",
      reason: "Padrões de golpe/BET/fraude detectados",
    };
  }

  return { ...DEFAULT_ANALYSIS };
}

function mergeAnalyses(model: ContentAnalysis, fallback: ContentAnalysis): ContentAnalysis {
  return {
    isSpam: model.isSpam || fallback.isSpam,
    spamConfidence: Math.max(model.spamConfidence, fallback.spamConfidence),
    spamCategory:
      model.spamConfidence >= fallback.spamConfidence
        ? model.spamCategory
        : fallback.spamCategory,
    isOffensive: model.isOffensive || fallback.isOffensive,
    offensiveConfidence: Math.max(
      model.offensiveConfidence,
      fallback.offensiveConfidence
    ),
    offensiveCategory:
      model.offensiveConfidence >= fallback.offensiveConfidence
        ? model.offensiveCategory
        : fallback.offensiveCategory,
    reason:
      model.reason && model.reason !== DEFAULT_ANALYSIS.reason
        ? model.reason
        : fallback.reason,
  };
}

// ── Combined prompt ────────────────────────────────────────────────────────────
//
// One call → two results. Halves API usage compared to two separate checks.
//
// The offensive threshold in the prompt is intentionally very strict to
// minimise false positives. Adjust OFFENSIVE_THRESHOLD in wrangler.toml
// (default 0.90) independently from the LLM guidance below.

const PROMPT = `You are a content moderation assistant for a Telegram group bot.
Analyze the message and evaluate it for TWO independent issues.

━━ 1. SPAM ━━
Flag as spam if the message is:
- Unsolicited ads, promotions or commercial offers
- Phishing, credential harvesting or account takeover attempts
- Cryptocurrency / investment / forex scams or pump-and-dump schemes
- Fake giveaways, prizes, lottery or sweepstakes
- MLM / pyramid scheme recruitment
- Suspicious or obfuscated links (bit.ly, t.me/+xxx invite floods, etc.)
- Adult content solicitation or escort/prostitution offers
- Repetitive flooding
- Job scams ("easy money", "work from home" with suspicious links)
- Gambling/BET ads (sports betting, casino, slots, "tigrinho", sure-win tips)
- Fraud/scam terms in Portuguese and English (golpe, fraude, phishing, fake support)

NOT spam: normal conversation, questions, legitimate news, opinions, bot commands.

━━ 2. OFFENSIVE CONTENT ━━
Be EXTREMELY conservative — only flag content that is CLEARLY and UNAMBIGUOUSLY offensive.
A false positive (removing a normal message) is far worse than a false negative.

Flag offensive ONLY if the message contains:
- Explicit hate speech clearly targeting race, ethnicity, religion, gender or sexual orientation
- Direct, credible personal threats of physical violence against a named person
- Highly explicit sexual content (graphic descriptions, not just innuendo)
- Pornographic/erotic solicitation, paid sexual content offers, nudity sales
- Severe, targeted personal harassment aimed at a specific group member

Do NOT flag:
- Profanity, cursing or strong language alone
- Heated political debate or strong opinions
- Dark or morbid humour, sarcasm, irony
- Criticism of companies, public figures, governments or ideas
- Venting or frustration
- Cultural communication differences
- Anything that could plausibly be interpreted as non-offensive

━━ Message ━━
"""
{{MESSAGE}}
"""
{{LINKS}}
Respond with ONLY valid JSON (no markdown, no extra text):
{
  "isSpam": <boolean>,
  "spamConfidence": <0.0–1.0>,
  "spamCategory": "<category or 'legitimate'>",
  "isOffensive": <boolean>,
  "offensiveConfidence": <0.0–1.0>,
  "offensiveCategory": "<category or 'clean'>",
  "reason": "<one sentence>"
}`;

// ── Analyser ───────────────────────────────────────────────────────────────────

export async function analyzeContent(
  text: string,
  links: string[],
  apiKey: string,
  model: string
): Promise<ContentAnalysis> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json" },
  });

  const linksSection =
    links.length > 0
      ? `\nLinks in message:\n${links.map((l) => `- ${l}`).join("\n")}\n`
      : "";

  const prompt = PROMPT.replace("{{MESSAGE}}", text).replace(
    "{{LINKS}}",
    linksSection
  );

  const result = await withRetry(() => generativeModel.generateContent(prompt));
  const fallback = heuristicAnalysis(text, links);
  const parsed = parseJsonObject(result.response.text());
  if (!parsed) return fallback;

  const modelAnalysis = normalizeModelOutput(parsed);
  return mergeAnalyses(modelAnalysis, fallback);
}
