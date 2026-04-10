import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry } from "./retry";

export interface ProfileCheckResult {
  flagged: boolean;
  confidence: number;
  reason: string;
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function parseProfileResult(raw: string): ProfileCheckResult | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parseCandidate = (value: string): ProfileCheckResult | null => {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return {
        flagged: Boolean(parsed.flagged),
        confidence: clamp01(parsed.confidence),
        reason: String(parsed.reason ?? "Classificação automática"),
      };
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(cleaned);
  if (direct) return direct;

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return parseCandidate(match[0]);
}

// ── Telegram helpers ───────────────────────────────────────────────────────────

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
}

interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
}

interface UserProfilePhotos {
  total_count: number;
  photos: PhotoSize[][];
}

interface TelegramFile {
  file_path?: string;
}

interface TelegramChat {
  bio?: string;
}

async function telegramGet<T>(
  botToken: string,
  method: string,
  params: Record<string, string | number>
): Promise<T | null> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  );
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}?${qs}`
  );
  const json = (await res.json()) as TelegramResponse<T>;
  return json.ok && json.result !== undefined ? json.result : null;
}

async function fetchPhotoAsBase64(
  botToken: string,
  fileId: string
): Promise<{ data: string; mimeType: string } | null> {
  const file = await telegramGet<TelegramFile>(botToken, "getFile", {
    file_id: fileId,
  });
  if (!file?.file_path) return null;

  const res = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
  );
  if (!res.ok) return null;

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  return { data: btoa(binary), mimeType: "image/jpeg" };
}

// ── Profile photo check (Gemini Vision) ───────────────────────────────────────

const PHOTO_PROMPT = `Analyze this Telegram profile photo and determine if it belongs to an account that promotes adult content, sexual services, prostitution, escort services, or explicit content sales (e.g. OnlyFans, adult webcam).

Look for:
- Sexually explicit or highly suggestive poses/clothing
- Nudity or near-nudity in a provocative context
- Visual cues typical of adult content promotion
- Overlay text advertising paid sexual content

Do NOT flag:
- Fitness/gym photos with normal workout clothing
- Beach or pool photos in regular swimwear
- Professional or casual portraits

Respond ONLY with valid JSON (no markdown):
{"flagged": <boolean>, "confidence": <0.0-1.0>, "reason": "<one sentence in Portuguese>"}`;

export async function checkProfilePhoto(
  botToken: string,
  userId: number,
  apiKey: string,
  model: string
): Promise<ProfileCheckResult> {
  const photos = await telegramGet<UserProfilePhotos>(
    botToken,
    "getUserProfilePhotos",
    { user_id: userId, limit: 1 }
  );

  if (!photos?.total_count || !photos.photos[0]?.length) {
    return { flagged: false, confidence: 0, reason: "Sem foto de perfil" };
  }

  // Use the largest available size
  const sizes = photos.photos[0];
  const largest = sizes[sizes.length - 1];
  if (!largest) return { flagged: false, confidence: 0, reason: "Sem foto" };

  const imageData = await fetchPhotoAsBase64(botToken, largest.file_id);
  if (!imageData) {
    return { flagged: false, confidence: 0, reason: "Não foi possível baixar a foto" };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json" },
  });

  const result = await withRetry(() =>
    generativeModel.generateContent([
      { inlineData: imageData },
      { text: PHOTO_PROMPT },
    ])
  );

  return (
    parseProfileResult(result.response.text()) ?? {
      flagged: false,
      confidence: 0,
      reason: "Resposta inválida do modelo",
    }
  );
}

// ── Profile text check (name + username + bio) ────────────────────────────────

const ADULT_NAME_PATTERN =
  /onlyfans|privacy\.com|privacy|adult|xxx|nsfw|escort|acompanhante|gp\b|garota\s*de\s*programa|pack\s*vip|conte[úu]do\s*adulto|nude|sexo|er[oó]tico|massagem\s*sensual|camgirl/i;

const TEXT_PROMPT = `Analyze this Telegram profile and determine if it belongs to an account that promotes adult content, sexual services, prostitution, escort services, or explicit content sales.

Indicators of adult/spam profiles:
- References to OnlyFans, Privacy, or similar platforms
- Offering "packs", "vídeos exclusivos", "conteúdo adulto/privado"
- Words like acompanhante, GP, escort, massagem sensual, stripper
- Emojis heavily associated with adult solicitation (🔞💦👅🍆🍑 in suggestive context)
- Phone/contact for "serviços" without specifying what
- Offers of paid sexual or erotic content

Do NOT flag:
- Normal bios mentioning profession, hobbies, city
- Fitness, modeling, or entertainment pages without explicit adult content

Profile:
{{PROFILE}}

Respond ONLY with valid JSON (no markdown):
{"flagged": <boolean>, "confidence": <0.0-1.0>, "reason": "<one sentence in Portuguese>"}`;

export async function checkProfileText(
  firstName: string,
  username: string | undefined,
  bio: string | undefined,
  apiKey: string,
  model: string
): Promise<ProfileCheckResult> {
  // Fast path: regex check on name/username before hitting the API
  const combined = [firstName, username ?? "", bio ?? ""].join(" ");
  if (ADULT_NAME_PATTERN.test(combined)) {
    return {
      flagged: true,
      confidence: 0.92,
      reason: "Perfil com padrão de conteúdo adulto/erótico",
    };
  }

  // Nothing meaningful to analyze
  if (!bio && !username) {
    return { flagged: false, confidence: 0, reason: "Sem bio ou username" };
  }

  const profileText = [
    `Nome: ${firstName}`,
    username ? `Username: @${username}` : null,
    bio ? `Bio: ${bio}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json" },
  });

  const result = await withRetry(() =>
    generativeModel.generateContent(
      TEXT_PROMPT.replace("{{PROFILE}}", profileText)
    )
  );

  return (
    parseProfileResult(result.response.text()) ?? {
      flagged: false,
      confidence: 0,
      reason: "Resposta inválida do modelo",
    }
  );
}

// ── Bio fetcher ───────────────────────────────────────────────────────────────

export async function fetchUserBio(
  botToken: string,
  userId: number
): Promise<string | undefined> {
  const chat = await telegramGet<TelegramChat>(botToken, "getChat", {
    chat_id: userId,
  });
  return chat?.bio;
}
