/**
 * Best-effort detection of identifying contact strings in public text
 * (introductions and pair messages). This is a coarse filter, not a
 * guarantee: prose can always conceal identifiers. Agent instructions must
 * prohibit contact sharing through these fields regardless.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { kind: 'url', re: /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+|\b\S+\.(com|net|org|io|me|app|dev)\b/i },
  // Phone: digit runs must NOT be glued to letters (hex participant IDs like
  // p_9f3ac2... routinely contain 7+ consecutive digits and appear in
  // facilitator/agent messages). Boundaries keep those false positives out.
  { kind: 'phone', re: /(?<![A-Za-z0-9_])([(+]?[\d][\d\s().-]{6,}\d)(?![A-Za-z0-9_])/ },
  { kind: 'handle', re: /(^|[\s(])@[\w.]{2,}\b/ },
  { kind: 'messaging_handle', re: /\b(instagram|insta|snapchat|snap|whatsapp|telegram|signal|facebook|fb|tiktok|discord)\s*(?:[:：]\s*|@)[\w.]{2,30}\b/i },
  { kind: 'messaging_handle', re: /\bmy\s+(instagram|insta|snapchat|snap|whatsapp|telegram|signal|facebook|fb|tiktok|discord)\s+is\s+@?[\w.]{2,30}\b/i },
  { kind: 'obfuscated_email', re: /\b\w[\w.]*\s+at\s+[\w-]+\s+dot\s+(com|net|org|io)\b/i },
];

export function detectIdentifiers(text: string): string[] {
  const hits: string[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    if (kind === 'phone') {
      const digits = m[1]?.replace(/\D/g, '') ?? '';
      if (digits.length < 7 || digits.length > 16) continue;
    }
    if (kind === 'url') {
      // "I like cats.com memes" is not contact info; require handle-ish context.
      // Keep the check narrow: only flag when paired with contact verbs/handles.
      if (!/@|contact|reach me|add me|dm|follow|handle|account|profile/i.test(text)) continue;
    }
    hits.push(kind);
  }
  return [...new Set(hits)];
}
