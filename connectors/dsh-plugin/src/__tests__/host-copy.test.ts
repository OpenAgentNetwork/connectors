// Agent-facing host copy must never hand the user a bare `dsh …` command.
//
// Observed in production: after an update the agent told its user to restart with `dsh web`,
// which only exists when the harness was installed globally. The standard install path is
// npx-based (`npx @deepseek-ai/dsh web`), so the bare form fails for most users — and the
// agent has no way to know which install they have, it simply repeats whatever our copy says.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOanSkillDefinition } from '../skill.js';
import { DSH_HOST_HINTS } from '../tools.js';

/** A `dsh web` / `dsh plugin` invocation that is not written as `npx @deepseek-ai/dsh …` */
const BARE_DSH_COMMAND = /(?<!@deepseek-ai\/)\bdsh\s+(web|plugin|--profile)\b/;

function offendingLines(text: string): string[] {
  return text.split('\n').filter((line) => BARE_DSH_COMMAND.test(line));
}

function readRepoFile(relativeToPackage: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToPackage, import.meta.url)), 'utf-8');
}

describe('DSH agent-facing copy', () => {
  it('gives every host command in the hint slots as the npx form', () => {
    for (const [slot, copy] of Object.entries(DSH_HOST_HINTS)) {
      if (typeof copy !== 'string') continue;
      expect(BARE_DSH_COMMAND.test(copy), `${slot} hands the user a bare dsh command: ${copy}`).toBe(false);
    }
  });

  it('gives every host command in the bundled skill as the npx form', () => {
    const offending = offendingLines(buildOanSkillDefinition().content);
    expect(offending, `skill lines hand the user a bare dsh command:\n${offending.join('\n')}`).toEqual([]);
  });

  it('gives every host command in the package README as the npx form', () => {
    const offending = offendingLines(readRepoFile('../../README.md'));
    expect(offending, `README lines hand the user a bare dsh command:\n${offending.join('\n')}`).toEqual([]);
  });

  // The onboarding doc an agent reads when joining over the protocol (served as /skill.md);
  // it led with the bare form until 2026-08-16, which is where the habit came from
  it('gives every host command in the onboarding doc as the npx form', () => {
    const offending = offendingLines(readRepoFile('../../../../docs/oan-skill.md'));
    expect(offending, `onboarding-doc lines hand the user a bare dsh command:\n${offending.join('\n')}`).toEqual([]);
  });
});
