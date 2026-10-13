/** One argument for a POSIX shell's `-c`: single-quoted, so nothing in it is expanded. */
export function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}
