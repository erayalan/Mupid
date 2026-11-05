const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|registration[_-]?key|contact[_-]?value|sealed|vault|bearer|credential)/i;

/** Deep-clone replacing sensitive values; safe for logs, transcripts, inspector output. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Single-line JSON log with redaction and UTC timestamp. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...(redact(fields) as Record<string, unknown>) });
  process.stdout.write(line + '\n');
}

export function logError(event: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
  logEvent(event, { ...fields, error: message, code });
}
