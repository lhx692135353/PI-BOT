/** Supplemental credential-format detection. Memory remains untrusted source data.
 * Pattern matches are a defence in depth check, never an intent classifier or
 * evidence that unmatched content is safe. Ownership/revision/tool permissions
 * are enforced independently by the storage API.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string; severity: "high" | "medium" }> = [
  // API keys
  { pattern: /\bsk-ant-api\S{10,}\b/, id: "anthropic_api_key", severity: "high" },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: "openrouter_api_key", severity: "high" },
  { pattern: /\bsk-\S{20,}\b/, id: "openai_api_key", severity: "high" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key", severity: "high" },
  // Tokens
  { pattern: /\bghp_\S{10,}\b/, id: "github_personal_token", severity: "high" },
  { pattern: /\bghu_\S{10,}\b/, id: "github_user_token", severity: "high" },
  { pattern: /\bxoxb-\S{10,}\b/, id: "slack_bot_token", severity: "high" },
  { pattern: /\bxapp-\S{10,}\b/, id: "slack_app_token", severity: "high" },
  { pattern: /\bntn_\S{10,}\b/, id: "notion_token", severity: "high" },
  { pattern: /\bBearer\s+\S{20,}\b/, id: "bearer_auth_token", severity: "high" },
  // SSH keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: "private_key_block", severity: "high" },
  // Inline secret assignments (likely accidental paste)
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: "password_assignment", severity: "medium" },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: "secret_assignment", severity: "medium" },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: "token_assignment", severity: "medium" },
];

/** Returns a credential warning, or null when none of these formats matched. */
export function scanContent(content: string): string | null {
  // Check secret patterns
  for (const { pattern, id, severity } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory. Use an .env file or secrets manager instead.`;
    }
  }

  return null;
}

/**
 * Scan content for secrets only (no threat patterns).
 * Returns an array of matched secret IDs, or empty array if none found.
 * Useful for non-blocking warnings (e.g., pre-fill checks in interviews).
 */
export function scanSecrets(content: string): string[] {
  const found: string[] = [];
  for (const { pattern, id } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      found.push(id);
    }
  }
  return found;
}
