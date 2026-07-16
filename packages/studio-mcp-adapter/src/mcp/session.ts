import { STUDIO_MCP_SESSION_DISCOVERY_TIMEOUT_MS } from '../constants.js';
import { StudioAdapterError, compareCodePoints, studioDiagnostic } from '../diagnostics.js';
import { inspectJsonCompatibility } from '../json.js';
import {
  containsLocalAbsolutePath,
  isUnsafePresentationCharacter,
  removeUnsafePresentationCharacters,
  replaceUnsafePresentationCharacters,
} from '../privacy.js';
import type { StudioMcpClient } from './client.js';

export interface StudioSessionSummary {
  readonly studioId: string;
  readonly displayName: string;
  readonly active: boolean;
}

export interface StudioStateSummary {
  readonly playState: string;
  readonly availableDataModelTypes: readonly string[];
  readonly editAvailable: boolean;
  readonly playtesting: boolean;
}

export interface StudioSandboxProbe {
  readonly studioId: string;
  readonly placeName: string;
  readonly placeId: number;
  readonly gameId: number;
  readonly dataModelMode: string;
  readonly playtesting: boolean;
  readonly editExecutionAvailable: boolean;
}

type StudioSessionClient = Pick<
  StudioMcpClient,
  'listStudioSessionsText' | 'selectStudioSessionById'
>;

const SESSION_DISCOVERY_POLL_INTERVAL_MS = 250;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseError(path: string, message: string): StudioAdapterError {
  return new StudioAdapterError([studioDiagnostic('studio.response_invalid', path, message)]);
}

function parseJsonText(text: string, path: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    if (inspectJsonCompatibility(value) !== undefined) throw new Error('not JSON-compatible');
    return value;
  } catch {
    throw responseError(path, 'Studio returned malformed JSON session data.');
  }
}

function readOneAlias(
  value: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): unknown {
  const present = aliases.filter((alias) => Object.hasOwn(value, alias));
  return present.length === 1 ? value[present[0]!] : undefined;
}

export function sanitizeStudioDisplayName(value: string): string {
  if (containsLocalAbsolutePath(removeUnsafePresentationCharacters(value))) {
    return 'Redacted Studio';
  }
  const withoutControls = replaceUnsafePresentationCharacters(value);
  const replaced = withoutControls.replace(/\s+/gu, ' ').trim();
  if (replaced.length === 0) return 'Unnamed Studio';
  return replaced.length <= 128 ? replaced : `${replaced.slice(0, 125)}...`;
}

function validateStudioId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    containsLocalAbsolutePath(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => isUnsafePresentationCharacter(character))
  ) {
    throw responseError(path, 'Studio returned an invalid session ID.');
  }
  return value;
}

function readSession(entry: unknown, index: number): StudioSessionSummary {
  const path = `/sessions/${index}`;
  if (!isRecord(entry)) throw responseError(path, 'Studio returned an invalid session entry.');
  const studioId = validateStudioId(
    readOneAlias(entry, ['id', 'studio_id', 'studioId']),
    `${path}/id`,
  );
  const name = readOneAlias(entry, [
    'name',
    'studio_name',
    'studioName',
    'place_name',
    'placeName',
  ]);
  const active = readOneAlias(entry, ['active', 'is_active', 'isActive']);
  if (typeof name !== 'string' || name.length > 1024 || typeof active !== 'boolean') {
    throw responseError(path, 'Studio returned an invalid session name or active status.');
  }
  return Object.freeze({ studioId, displayName: sanitizeStudioDisplayName(name), active });
}

/** Parse the strict JSON payload returned inside list_roblox_studios text content. */
export function parseStudioSessionListText(text: string): readonly StudioSessionSummary[] {
  const parsed = parseJsonText(text, '/sessions');
  let entries: unknown;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed)) {
    entries = readOneAlias(parsed, ['studios', 'sessions']);
  }
  if (!Array.isArray(entries) || entries.length > 128) {
    throw responseError('/sessions', 'Studio returned an invalid or oversized session list.');
  }
  const sessions = entries.map((entry, index) => readSession(entry, index));
  const byId = new Map<string, StudioSessionSummary>();
  for (const session of sessions) {
    if (byId.has(session.studioId)) {
      throw responseError('/sessions', 'Studio returned duplicate session IDs.');
    }
    byId.set(session.studioId, session);
  }
  return Object.freeze(
    [...sessions].sort((left, right) => compareCodePoints(left.studioId, right.studioId)),
  );
}

async function waitForStudioSessions(
  client: StudioSessionClient,
  ready: (sessions: readonly StudioSessionSummary[]) => boolean,
): Promise<readonly StudioSessionSummary[]> {
  const deadline = Date.now() + STUDIO_MCP_SESSION_DISCOVERY_TIMEOUT_MS;
  let latestValid: readonly StudioSessionSummary[] = Object.freeze([]);
  let latestError: StudioAdapterError | undefined;
  for (;;) {
    const callBudget = deadline - Date.now();
    if (callBudget <= 0) {
      if (latestError !== undefined) throw latestError;
      return latestValid;
    }
    try {
      latestValid = parseStudioSessionListText(await client.listStudioSessionsText(callBudget));
      latestError = undefined;
      if (ready(latestValid)) return latestValid;
    } catch (error) {
      if (!(error instanceof StudioAdapterError)) throw error;
      if (
        error.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'studio.tool_call_failed' && diagnostic.path === '/client',
        )
      ) {
        throw error;
      }
      latestError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (latestError !== undefined) throw latestError;
      return latestValid;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(SESSION_DISCOVERY_POLL_INTERVAL_MS, remaining));
    });
  }
}

/**
 * Studio registers open sessions asynchronously after the stdio handshake.
 * Wait within a fixed bound so a just-connected client does not report a false
 * empty list while still returning an actual empty list when no Studio exists.
 */
export function listStudioSessions(
  client: StudioSessionClient,
): Promise<readonly StudioSessionSummary[]> {
  return waitForStudioSessions(client, (sessions) => sessions.length > 0);
}

function sessionNotFound(studioId: string): StudioAdapterError {
  return new StudioAdapterError([
    studioDiagnostic(
      'studio.session_not_found',
      '/studioId',
      'The requested Studio session is not connected.',
      { relatedId: studioId },
    ),
  ]);
}

/** Select one exact Studio ID and verify the server reports that same session active. */
export async function selectStudioSession(
  client: StudioSessionClient,
  studioId: string,
): Promise<StudioSessionSummary> {
  validateStudioId(studioId, '/studioId');
  const before = await waitForStudioSessions(client, (sessions) =>
    sessions.some((session) => session.studioId === studioId),
  );
  if (!before.some((session) => session.studioId === studioId)) throw sessionNotFound(studioId);
  await client.selectStudioSessionById(studioId);
  const after = await waitForStudioSessions(client, (sessions) => {
    const active = sessions.filter((session) => session.active);
    return active.length === 1 && active[0]?.studioId === studioId;
  });
  const selected = after.find((session) => session.studioId === studioId);
  if (selected === undefined) throw sessionNotFound(studioId);
  const active = after.filter((session) => session.active);
  if (active.length !== 1 || active[0]?.studioId !== studioId) {
    throw responseError(
      '/sessions',
      'Studio did not confirm the explicitly selected session as the only active target.',
    );
  }
  return selected;
}

/** Auto-selection is intentionally read-only and succeeds only with one connected Studio. */
export async function selectReadOnlyStudioSession(
  client: StudioSessionClient,
  studioId?: string,
): Promise<StudioSessionSummary> {
  if (studioId !== undefined) return selectStudioSession(client, studioId);
  const sessions = await listStudioSessions(client);
  if (sessions.length === 0) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.session_not_found', '/sessions', 'No Studio session is connected.'),
    ]);
  }
  if (sessions.length > 1) {
    throw new StudioAdapterError(
      sessions.map((session, index) =>
        studioDiagnostic(
          'studio.session_ambiguous',
          `/sessions/${index}`,
          `Candidate Studio: ${session.displayName} (${session.studioId}).`,
          { relatedId: session.studioId },
        ),
      ),
    );
  }
  return selectStudioSession(client, sessions[0]!.studioId);
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 64)
  ) {
    return undefined;
  }
  return value;
}

/** Parse the documented play state and available data-model list from get_studio_state. */
export function parseStudioStateText(text: string): StudioStateSummary {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    if (text.length > 4096) {
      throw responseError('/state', 'Studio returned an oversized state response.');
    }
    const lines = trimmed.split(/\r?\n/u);
    const mode = /^- Current Studio Mode: ([A-Za-z][A-Za-z0-9 _-]{0,63})$/u.exec(lines[0] ?? '');
    const available = /^- Available DataModels: ([A-Za-z][A-Za-z0-9 ,_-]{0,255})$/u.exec(
      lines[1] ?? '',
    );
    const focused = /^- Focused DataModel in the viewport: ([A-Za-z][A-Za-z0-9 _-]{0,63})$/u.exec(
      lines[2] ?? '',
    );
    const dataModels = available?.[1]
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (
      lines.length !== 3 ||
      mode?.[1] === undefined ||
      focused?.[1] === undefined ||
      dataModels === undefined ||
      dataModels.length === 0 ||
      dataModels.length > 16 ||
      new Set(dataModels).size !== dataModels.length
    ) {
      throw responseError('/state', 'Studio returned an invalid state response.');
    }
    const normalizedPlayState = mode[1].replaceAll(/[_\s-]/gu, '').toLowerCase();
    const stopped = new Set(['edit', 'notrunning', 'stopped']).has(normalizedPlayState);
    return Object.freeze({
      playState: mode[1],
      availableDataModelTypes: Object.freeze(dataModels),
      editAvailable: dataModels.includes('Edit') && focused[1] === 'Edit',
      playtesting: !stopped,
    });
  }

  const parsed = parseJsonText(trimmed, '/state');
  if (!isRecord(parsed)) throw responseError('/state', 'Studio returned an invalid state object.');
  const playState = readOneAlias(parsed, ['play_state', 'playState']);
  const dataModels = readStringArray(
    readOneAlias(parsed, [
      'available_datamodel_types',
      'availableDatamodelTypes',
      'datamodel_types',
      'dataModelTypes',
    ]),
  );
  if (
    typeof playState !== 'string' ||
    playState.length === 0 ||
    playState.length > 64 ||
    dataModels === undefined
  ) {
    throw responseError('/state', 'Studio returned an invalid play state or data-model list.');
  }
  const normalizedPlayState = playState.replaceAll(/[_\s-]/gu, '').toLowerCase();
  const stopped = new Set(['edit', 'notrunning', 'stopped']).has(normalizedPlayState);
  return Object.freeze({
    playState,
    availableDataModelTypes: Object.freeze([...dataModels]),
    editAvailable: dataModels.includes('Edit'),
    playtesting: !stopped,
  });
}

/** Enforce the no-bypass unsaved-place and stopped-Edit mutation gate. */
export function assertSandboxStudioProbe(probe: StudioSandboxProbe): StudioSandboxProbe {
  validateStudioId(probe.studioId, '/probe/studioId');
  if (
    typeof probe.placeName !== 'string' ||
    probe.placeName.length === 0 ||
    probe.placeName.length > 1024 ||
    !Number.isSafeInteger(probe.placeId) ||
    probe.placeId < 0 ||
    !Number.isSafeInteger(probe.gameId) ||
    probe.gameId < 0 ||
    typeof probe.dataModelMode !== 'string' ||
    typeof probe.playtesting !== 'boolean' ||
    typeof probe.editExecutionAvailable !== 'boolean'
  ) {
    throw responseError('/probe', 'Studio returned an invalid sandbox probe.');
  }
  if (probe.placeId !== 0 || probe.gameId !== 0) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.published_place_forbidden',
        '/probe/placeId',
        'Worldwright may mutate only an unsaved local place with PlaceId and GameId equal to zero.',
      ),
    ]);
  }
  if (probe.dataModelMode !== 'Edit' || probe.playtesting || !probe.editExecutionAvailable) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.edit_mode_required',
        '/probe/dataModelMode',
        'Worldwright requires a stopped Studio session with Edit execution available.',
      ),
    ]);
  }
  return Object.freeze({ ...probe, placeName: sanitizeStudioDisplayName(probe.placeName) });
}
