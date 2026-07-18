import type { CriticFinding, CriticFindingCode, CriticSuggestionCode } from './contract-schema.js';

export interface CriticRuleDescriptor {
  readonly severity: CriticFinding['severity'];
  readonly category: CriticFinding['category'];
  readonly message: string;
  readonly suggestionCode: CriticSuggestionCode;
}

const criticRules: Record<CriticFindingCode, CriticRuleDescriptor> = {
  'critic.run_incomplete': {
    severity: 'error',
    category: 'evidence',
    message: 'The playtest run did not complete.',
    suggestionCode: 'rerun-with-complete-evidence',
  },
  'critic.play_simulation_identity_unproved': {
    severity: 'error',
    category: 'identity',
    message: 'The running play simulation identity was not proved.',
    suggestionCode: 'inspect-playtest-state',
  },
  'critic.playtest_start_failed': {
    severity: 'error',
    category: 'playtest_start',
    message: 'Studio playtesting did not start in a verified state.',
    suggestionCode: 'inspect-playtest-state',
  },
  'critic.character_missing': {
    severity: 'error',
    category: 'character',
    message: 'The required solo test character was not observed.',
    suggestionCode: 'inspect-spawn-or-setup',
  },
  'critic.character_dead': {
    severity: 'error',
    category: 'character',
    message: 'The test character did not survive traversal.',
    suggestionCode: 'inspect-collision-volume',
  },
  'critic.character_fell': {
    severity: 'error',
    category: 'character',
    message: 'The test character fell below the permitted floor range.',
    suggestionCode: 'inspect-floor-support',
  },
  'critic.setup_failed': {
    severity: 'error',
    category: 'character',
    message: 'The fixed play-only character setup was not verified.',
    suggestionCode: 'inspect-spawn-or-setup',
  },
  'critic.path_not_successful': {
    severity: 'error',
    category: 'pathfinding',
    message: 'A required path preflight was not successful.',
    suggestionCode: 'inspect-opening-clearance',
  },
  'critic.path_requires_jump': {
    severity: 'error',
    category: 'pathfinding',
    message: 'A required path contains a jump for the non-jumping agent.',
    suggestionCode: 'inspect-collision-volume',
  },
  'critic.arrival_not_reached': {
    severity: 'error',
    category: 'navigation',
    message: 'Independent observation did not verify arrival.',
    suggestionCode: 'inspect-opening-clearance',
  },
  'critic.wrong_floor': {
    severity: 'error',
    category: 'circulation',
    message: 'The character was observed on the wrong floor.',
    suggestionCode: 'inspect-stair-geometry',
  },
  'critic.checkpoint_not_reached': {
    severity: 'error',
    category: 'circulation',
    message: 'A required architectural checkpoint was not reached.',
    suggestionCode: 'inspect-opening-clearance',
  },
  'critic.room_not_reached': {
    severity: 'error',
    category: 'circulation',
    message: 'A required room was not reached.',
    suggestionCode: 'inspect-opening-clearance',
  },
  'critic.floor_not_reached': {
    severity: 'error',
    category: 'circulation',
    message: 'A required floor was not reached.',
    suggestionCode: 'inspect-stair-geometry',
  },
  'critic.stair_not_traversed': {
    severity: 'error',
    category: 'stairs',
    message: 'A required stair run was not traversed.',
    suggestionCode: 'inspect-stair-geometry',
  },
  'critic.head_clearance_blocked': {
    severity: 'error',
    category: 'clearance',
    message: 'Required head clearance was blocked.',
    suggestionCode: 'inspect-collision-volume',
  },
  'critic.body_clearance_blocked': {
    severity: 'error',
    category: 'clearance',
    message: 'Required body clearance was blocked.',
    suggestionCode: 'widen-corridor',
  },
  'critic.support_missing': {
    severity: 'error',
    category: 'clearance',
    message: 'No support surface was observed beneath the character.',
    suggestionCode: 'inspect-floor-support',
  },
  'critic.console_error_new': {
    severity: 'error',
    category: 'console',
    message: 'A new Studio console error was observed.',
    suggestionCode: 'inspect-console-error',
  },
  'critic.console_evidence_incomplete': {
    severity: 'error',
    category: 'evidence',
    message: 'Console evidence was incomplete or ambiguous.',
    suggestionCode: 'rerun-with-complete-evidence',
  },
  'critic.playtest_stop_failed': {
    severity: 'error',
    category: 'playtest_stop',
    message: 'Playtesting could not be stopped safely.',
    suggestionCode: 'inspect-playtest-state',
  },
  'critic.edit_not_restored': {
    severity: 'error',
    category: 'edit_integrity',
    message: 'Studio did not return to stopped Edit mode.',
    suggestionCode: 'inspect-playtest-state',
  },
  'critic.edit_snapshot_changed': {
    severity: 'error',
    category: 'edit_integrity',
    message: 'The lease-bound post-play Edit snapshot changed.',
    suggestionCode: 'restore-edit-snapshot',
  },
  'critic.manifest_not_noop': {
    severity: 'error',
    category: 'edit_integrity',
    message: 'Final Manifest reconciliation was not a no-op.',
    suggestionCode: 'restore-edit-snapshot',
  },
  'critic.console_warning_new': {
    severity: 'warning',
    category: 'console',
    message: 'A new Studio console warning was observed.',
    suggestionCode: 'inspect-console-error',
  },
  'critic.arrival_velocity_high': {
    severity: 'warning',
    category: 'navigation',
    message: 'Arrival was verified with excessive final velocity.',
    suggestionCode: 'inspect-collision-volume',
  },
  'critic.unmanaged_blocker_nearby': {
    severity: 'warning',
    category: 'clearance',
    message: 'An unmanaged nearby blocker was observed.',
    suggestionCode: 'inspect-collision-volume',
  },
  'critic.navigation_ack_uncertain': {
    severity: 'warning',
    category: 'navigation',
    message: 'Navigation acknowledgment was uncertain despite verified arrival.',
    suggestionCode: 'rerun-with-complete-evidence',
  },
  'critic.path_detour_high': {
    severity: 'warning',
    category: 'pathfinding',
    message: 'The successful path was disproportionately indirect.',
    suggestionCode: 'inspect-opening-clearance',
  },
  'critic.capture_unavailable': {
    severity: 'warning',
    category: 'evidence',
    message: 'A nonessential viewport capture was unavailable.',
    suggestionCode: 'rerun-with-complete-evidence',
  },
};

for (const descriptor of Object.values(criticRules)) Object.freeze(descriptor);

/** Immutable, closed Milestone 5 rule registry. */
export const CRITIC_RULES: Readonly<Record<CriticFindingCode, CriticRuleDescriptor>> =
  Object.freeze(criticRules);
