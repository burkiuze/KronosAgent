import type { AgentDefinition } from './definitions.js';

/**
 * The learning review (after Hermes' background review): once a turn is over, a separate agent
 * reads the conversation and updates memory and skills, so lessons are kept without the main
 * conversation being interrupted or its context spent.
 */
export const LEARNING_REVIEWER: AgentDefinition = {
  name: 'learning-review',
  description: 'Reviews a finished turn and updates memory and skills.',
  source: 'builtin',
  tools: ['memory', 'skills_list', 'skill_view', 'skill_manage'],
  prompt: [
    'You maintain the memory and skill library of an AI agent. Read the conversation you are given and decide what is worth keeping for future sessions. Act when there is real signal; when there is none, reply "Nothing to save." and stop.',
    '',
    'Memory — two stores, one fact goes to exactly one:',
    '- memory target "user": who the user is, their stated preferences and ways of working;',
    '- memory target "memory": facts about the environment — project conventions, paths, tool quirks, config gotchas.',
    'Keep entries short. Do not store what is already there, transient task details or secrets.',
    '',
    'Skills — how to do a class of task well for this user:',
    '- Signals: the user corrected your style, format, verbosity, workflow or approach ("stop doing X", "too long", "always run the tests first"); a non-trivial technique, fix or debugging path emerged; a skill that was used turned out wrong or incomplete.',
    '- Prefer, in order: patch a skill used in this conversation; patch an existing skill covering the class (skills_list, then skill_view before editing it); add a reference file to such a skill; create a new skill named for the class of task — never for today\'s ticket, error message or PR.',
    '- A skill is a procedure: steps in order with the concrete commands, the decision points, and pitfalls written as a general rule plus one clause of why. No dates, ticket numbers or narratives of this session.',
    '- A user preference lives in exactly one place: the skill that governs the task, or the "user" memory when no skill owns it — never both.',
    '',
    'Never capture: environment problems the user can fix (missing binaries, credentials, installs); claims that a tool "does not work"; errors that went away; one-off tasks; approaches that never worked. Never delete a skill.',
  ].join('\n'),
};

/** Correction or preference language that makes a turn worth reviewing even when it was short. */
const SIGNALS = /\b(don'?t|do not|stop|never|always|instead|wrong|too (long|verbose|short)|remember|prefer|i (hate|like|want)|from now on)\b|yapma|asla|her zaman|yanlış|hatırla|bundan sonra|tercih|istemiyorum|çok uzun|şöyle yap/i;

export function hasLearningSignal(userText: string): boolean {
  return SIGNALS.test(userText);
}
