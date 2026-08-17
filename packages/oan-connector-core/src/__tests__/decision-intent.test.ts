import { describe, expect, it } from 'vitest';
import { parseDecisionIntent } from '../decision-intent.js';

describe('parseDecisionIntent', () => {
  it.each(['y', 'Y', 'yes', 'YES', 'accept', 'approve', 'confirm', 'agree', 'ok', 'okay', '是', '同意', '接受', '确认'])(
    'treats %s as affirmative',
    (text) => {
      expect(parseDecisionIntent(text)).toBe(true);
    },
  );

  it.each(['n', 'N', 'no', 'NO', 'reject', 'decline', 'deny', 'disagree', '否', '拒绝', '不同意'])(
    'treats %s as negative',
    (text) => {
      expect(parseDecisionIntent(text)).toBe(false);
    },
  );

  it('tolerates surrounding whitespace and trailing punctuation', () => {
    expect(parseDecisionIntent('  yes.  ')).toBe(true);
    expect(parseDecisionIntent('no!')).toBe(false);
  });

  it('returns null for ambiguous free text rather than guessing', () => {
    expect(parseDecisionIntent('maybe later')).toBeNull();
    expect(parseDecisionIntent('')).toBeNull();
    expect(parseDecisionIntent('yes but only if...')).toBeNull();
  });
});
