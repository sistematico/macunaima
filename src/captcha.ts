export interface CaptchaData {
  messageId: number;
  correct: number;
  expiresAt: number;
  chatId: number;
  userId: number;
  firstName: string;
}

export interface CaptchaChallenge {
  question: string;
  correct: number;
  options: number[];
}

export function captchaKey(chatId: number, userId: number): string {
  return `captcha:${chatId}:${userId}`;
}

export function generateCaptcha(): CaptchaChallenge {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const correct = a + b;

  const wrongs = new Set<number>();
  while (wrongs.size < 3) {
    const offset = Math.floor(Math.random() * 6) + 1; // 1–6, never 0
    const candidate =
      Math.random() < 0.5 ? correct + offset : correct - offset;
    if (candidate > 0 && candidate !== correct) wrongs.add(candidate);
  }

  // Shuffle correct answer among wrong ones
  const options = [...wrongs, correct].sort(() => Math.random() - 0.5);
  return { question: `Quanto é ${a} + ${b}?`, correct, options };
}
