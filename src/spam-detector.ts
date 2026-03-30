import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry } from "./retry";

export interface SpamAnalysis {
  isSpam: boolean;
  reason: string;
  confidence: number;
  category: string;
}

const SPAM_PROMPT = `You are a spam detection system for a Telegram group moderation bot.

Analyze the message below and determine whether it is spam.

SPAM indicators:
- Unsolicited advertising or promotional content
- Phishing or credential harvesting attempts
- Cryptocurrency / investment / forex scams or pump-and-dump schemes
- Fake giveaways, prizes, or lottery scams
- MLM or pyramid scheme recruitment
- Suspicious or obfuscated links (bit.ly, t.me/+XXX invite floods, etc.)
- Adult content solicitation
- Message flooding / repetitive content
- Job scams ("easy money", "work from home" with suspicious links)

NOT spam:
- Normal conversation or questions
- Sharing legitimate news articles
- Personal opinions or reactions
- Commands or replies to the bot

Message to analyze:
"""
{{MESSAGE}}
"""
{{LINKS_SECTION}}
Respond ONLY with a valid JSON object (no markdown, no extra text):
{"isSpam": <boolean>, "confidence": <0.0–1.0>, "category": "<category or 'legitimate'>", "reason": "<one sentence explanation>"}`;

export async function analyzeMessage(
  text: string,
  links: string[],
  apiKey: string,
  model: string
): Promise<SpamAnalysis> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json" },
  });

  const linksSection =
    links.length > 0
      ? `\nLinks found in message:\n${links.map((l) => `- ${l}`).join("\n")}\n`
      : "";

  const prompt = SPAM_PROMPT.replace("{{MESSAGE}}", text).replace(
    "{{LINKS_SECTION}}",
    linksSection
  );

  const result = await withRetry(() => generativeModel.generateContent(prompt));
  const responseText = result.response.text().trim();

  const parsed = JSON.parse(responseText) as SpamAnalysis;
  return parsed;
}
