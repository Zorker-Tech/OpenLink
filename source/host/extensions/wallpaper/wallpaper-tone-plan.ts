export interface WallpaperTonePlan {
  readonly tone: string;
  readonly msUntilNextBoundary: number;
}

export function parseTonePlan(stdout: string): WallpaperTonePlan | undefined {
  const words = stdout.trim().split(/\s+/);
  if (words.length !== 2) return undefined;
  const [tone, seconds] = words;
  if (tone === undefined || seconds === undefined || !/^[a-z]+$/.test(tone) || !/^\d+$/.test(seconds)) return undefined;
  return { tone, msUntilNextBoundary: Number(seconds) * 1_000 };
}
