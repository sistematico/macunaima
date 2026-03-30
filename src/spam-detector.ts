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

NOT spam: normal conversation, questions, legitimate news, opinions, bot commands.

━━ 2. OFFENSIVE CONTENT ━━
Be EXTREMELY conservative — only flag content that is CLEARLY and UNAMBIGUOUSLY offensive.
A false positive (removing a normal message) is far worse than a false negative.

Flag offensive ONLY if the message contains:
- Explicit hate speech clearly targeting race, ethnicity, religion, gender or sexual orientation
- Direct, credible personal threats of physical violence against a named person
- Highly explicit sexual content (graphic descriptions, not just innuendo)
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
  return JSON.parse(result.response.text().trim()) as ContentAnalysis;
}
