// Skill supply: the single source of content is core buildSkillMarkdown (the full operating
// discipline); this file only fills the DSH host-copy slots and registers in the
// SkillProvider shape (the template is the harness's own skill-badge plugin).
// The skills service is an optional dependency (present in the base bundle by default, yet
// still probed via ctx.get with graceful degradation).
import { buildSkillMarkdown } from '@openagentnetwork/connector-core';
import { DSH_HOST_HINTS } from './tools.js';
import {
  HOST_BUNDLED_SKILL_RANK,
  type HostSkillCandidate,
  type HostSkillDefinition,
  type HostSkillRuntime,
} from './host-types.js';

/** Register the OAN skill provider; the disposer is reclaimed by the host along with the plugin fiber */
export function registerOanSkill(skills: HostSkillRuntime): void {
  const definition = buildOanSkillDefinition();
  const candidate: HostSkillCandidate = {
    name: definition.name,
    description: definition.description,
    invocation: definition.invocation,
    source: definition.source,
    provider: definition.provider,
    // Literal value of BUNDLED_SKILL_RANK is 600 (skill/src/index.ts:74-83; lower ranks win)
    rank: HOST_BUNDLED_SKILL_RANK,
    locator: 'oan-skill',
  };
  skills.registerProvider(() => ({
    name: 'oan',
    list: () => Promise.resolve([candidate]),
    get: (requested) => Promise.resolve(requested.name === candidate.name ? definition : undefined),
  }));
}

/** DSH slot assembly: the wake mechanism = a followup note starting a new turn + the system-prompt badge while items are pending */
export function buildOanSkillDefinition(): HostSkillDefinition {
  const { name, description, body } = buildSkillMarkdown({
    howToPair: DSH_HOST_HINTS.howToPair,
    ...(DSH_HOST_HINTS.howToRecover ? { howToRecover: DSH_HOST_HINTS.howToRecover } : {}),
    ...(DSH_HOST_HINTS.howToUpdate ? { howToUpdate: DSH_HOST_HINTS.howToUpdate } : {}),
    wakeMechanism:
      'a plugin note arrives as a new turn ("N pending OAN items — call oan_inbox"); a system-prompt badge ' +
      'also stays visible while items are pending, so even a compacted conversation keeps the reminder. ' +
      'On that turn, work the inbox:',
  });
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'oan',
    content: body,
  };
}
