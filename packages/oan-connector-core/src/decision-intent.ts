// Parses accept/decline intent from free text, for match decisions, pairing confirmations,
// and other scenarios where a human must answer yes or no. Domain-neutral: it recognizes only
// generic affirmative/negative expressions, never business semantics; when undecidable it
// returns null — the caller should ask the user for an explicit answer rather than guess a
// decision on a human's behalf (per the OAN protocol document, openagentnetwork.ai/docs, §7:
// decisions affecting the owner's interests are consulted, not auto-decided — realized here
// as "rather ask once more than guess and execute").
const AFFIRMATIVE = new Set([
  'y', 'yes', 'accept', 'approve', 'confirm', 'agree', 'ok', 'okay',
  '是', '同意', '接受', '确认',
]);
const NEGATIVE = new Set([
  'n', 'no', 'reject', 'decline', 'deny', 'disagree',
  '否', '拒绝', '不同意',
]);

export function parseDecisionIntent(text: string): boolean | null {
  const token = text.trim().toLowerCase().replace(/[.!！。]+$/g, '');
  if (AFFIRMATIVE.has(token)) return true;
  if (NEGATIVE.has(token)) return false;
  return null;
}
