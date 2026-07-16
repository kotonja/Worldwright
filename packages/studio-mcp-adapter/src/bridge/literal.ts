/**
 * Encodes inert data as the shortest Luau long-bracket literal whose closing
 * delimiter is absent from the data. The caller must still validate the data
 * contract before embedding it in a fixed program.
 */
export function encodeLuauLongBracketLiteral(value: string): string {
  for (let equalsCount = 0; ; equalsCount += 1) {
    const equals = '='.repeat(equalsCount);
    const closing = `]${equals}]`;
    if (!value.includes(closing)) return `[${equals}[${value}]${equals}]`;
  }
}
