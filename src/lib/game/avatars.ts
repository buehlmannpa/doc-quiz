/**
 * Icons der Teilnehmenden. Zunächst Emoji (Entscheid in CLAUDE.md). Gespeichert wird nur der Index 0 bis 63.
 * Alle Emoji sind einzelne Zeichen ohne Hautfarbe, damit sie überall gleich aussehen.
 */
export const AVATARS: readonly string[] = [
  "🏍️", "🏁", "🔥", "⚡", "🚀", "🦅", "🦁", "🐯",
  "🐻", "🦊", "🐺", "🐼", "🐨", "🐸", "🐵", "🦄",
  "🐙", "🦈", "🐬", "🦉", "🐝", "🦋", "🐢", "🐲",
  "🌞", "🌈", "⭐", "🌙", "❄️", "🌊", "🍀", "🌵",
  "🌻", "🍄", "🍕", "🍔", "🍟", "🌮", "🍩", "🍪",
  "🍓", "🍒", "🍋", "🥑", "🍺", "☕", "🎸", "🎧",
  "🎮", "🎯", "🎲", "⚽", "🏀", "🏆", "🎩", "👑",
  "💎", "🧭", "⛰️", "🏔️", "🚲", "🛵", "🏎️", "🚁",
];

export function avatarEmoji(index: number): string {
  return AVATARS[index] ?? "🏍️";
}
