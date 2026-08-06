const SECRET_PATTERNS: RegExp[] = [
  /(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}/gi,
  /(?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}
