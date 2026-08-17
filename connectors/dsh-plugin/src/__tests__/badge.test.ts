// System-prompt badge: a binary section — content changes only on a 0↔non-zero flip (KV-cache friendly); the wording carries no specific count.
import { describe, expect, it } from 'vitest';
import { OanInboxBadge, OAN_BADGE_SECTION_NAME } from '../badge.js';
import type { HostPromptSection } from '../host-types.js';

describe('OanInboxBadge', () => {
  it('无待办：段内容为空串（段消失）', () => {
    const badge = new OanInboxBadge();
    expect(badge.currentText()).toBe('');
  });

  it('有待办：固定一行，指向 oan_inbox', () => {
    const badge = new OanInboxBadge();
    badge.setPending(true);
    expect(badge.currentText()).toContain('oan_inbox');
  });

  it('只在 0↔非0 翻转时变化：pending 数目变化不改变内容', () => {
    const badge = new OanInboxBadge();
    badge.setPending(true);
    const first = badge.currentText();
    badge.setPending(true); // equivalent to pending going from 1 to 5: still non-zero
    expect(badge.currentText()).toBe(first);
    badge.setPending(false);
    expect(badge.currentText()).toBe('');
    badge.setPending(true);
    expect(badge.currentText()).toBe(first);
  });

  it('register 注册函数形态的 text 段（每次装配求值）', () => {
    const badge = new OanInboxBadge();
    let section: HostPromptSection | undefined;
    badge.register({
      section: (input) => {
        section = input;
        return () => {};
      },
    });
    expect(section?.name).toBe(OAN_BADGE_SECTION_NAME);
    expect(typeof section?.text).toBe('function');
    const textFn = section?.text as (context: unknown) => string;
    expect(textFn({})).toBe('');
    badge.setPending(true);
    expect(textFn({})).toContain('oan_inbox');
  });
});
