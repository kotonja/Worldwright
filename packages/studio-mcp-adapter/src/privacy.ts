export function isUnsafePresentationCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) || /\p{Cf}/u.test(character);
}

export function containsLocalAbsolutePath(value: string): boolean {
  return (
    /[a-zA-Z]:[\\/]/u.test(value) ||
    /(?:file:\/\/|\\\\[^\\\s]+\\)/iu.test(value) ||
    /(?:^|[\s=:'"([{},;])\/(?!\/)\S/u.test(value) ||
    /(?:^|[\s=:'"([{},;])\\(?!\\)\S/u.test(value) ||
    /\/(?:Applications|Library|Users|Volumes|etc|home|media|mnt|opt|private|root|run|srv|tmp|usr|var)\//u.test(
      value,
    )
  );
}

export function replaceUnsafePresentationCharacters(value: string): string {
  return [...value]
    .map((character) => (isUnsafePresentationCharacter(character) ? ' ' : character))
    .join('');
}

export function removeUnsafePresentationCharacters(value: string): string {
  return [...value].filter((character) => !isUnsafePresentationCharacter(character)).join('');
}

export function isBoundedCompilerDiagnosticPointer(value: string): boolean {
  if (value.length === 0) return true;
  if (
    value.length > 1024 ||
    [...value].some((character) => isUnsafePresentationCharacter(character)) ||
    !/^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/u.test(value)
  ) {
    return false;
  }
  const allowedRoots = new Set([
    'adapter',
    'compilerVersion',
    'diagnostics',
    'finalSnapshotHash',
    'initialSnapshotHash',
    'manifest',
    'measurements',
    'nodes',
    'operations',
    'preconditions',
    'projectId',
    'rollback',
    'rootNodeId',
    'schemaVersion',
    'snapshot',
    'source',
    'summary',
    'target',
    'unmanagedRoots',
  ]);
  const decodedSegments = value
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (decodedSegments.some((segment) => containsLocalAbsolutePath(segment))) return false;
  const firstSegment = decodedSegments[0]!;
  return allowedRoots.has(firstSegment);
}
