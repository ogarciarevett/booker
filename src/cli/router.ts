/** Where a command writes its lines; `main.ts` points these at stdout and stderr. */
export interface CommandOutput {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/**
 * One `pnpm booker` command. `name` may have several words (`agent sync`); `run` receives the
 * arguments after the name and resolves to the process exit code.
 */
export interface Command<Context extends CommandOutput> {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: readonly string[], context: Context) => Promise<number>;
}

/** Exit code for a command line that names no known command. */
export const USAGE_EXIT_CODE = 2;

const HELP_ARGUMENTS = new Set(["help", "--help", "-h"]);
const HELP_SUMMARY = "Shows this help";

export function usage(
  commands: readonly { readonly name: string; readonly summary: string }[],
): string[] {
  const rows = [...commands, { name: "help", summary: HELP_SUMMARY }];
  const width = Math.max(...rows.map(({ name }) => name.length));
  return [
    "Usage: pnpm booker <command>",
    "",
    "Commands:",
    ...rows.map(({ name, summary }) => `  ${name.padEnd(width)}  ${summary}`),
  ];
}

function nameMatches(name: string, argv: readonly string[]): boolean {
  return name.split(" ").every((word, index) => argv[index] === word);
}

/**
 * Runs the command whose name starts `argv`, preferring the longest such name, so `agent sync`
 * wins over `agent`. With no arguments or an unknown command it prints usage to stderr and
 * returns 2; `help`, `--help`, or `-h` print usage to stdout and return 0.
 */
export async function runCommand<Context extends CommandOutput>(
  argv: readonly string[],
  commands: readonly Command<Context>[],
  context: Context,
): Promise<number> {
  const first = argv[0];
  if (first !== undefined && HELP_ARGUMENTS.has(first)) {
    for (const line of usage(commands)) context.stdout(line);
    return 0;
  }

  const command = commands
    .filter((candidate) => nameMatches(candidate.name, argv))
    .sort((a, b) => b.name.split(" ").length - a.name.split(" ").length)[0];
  if (command === undefined) {
    if (first !== undefined) context.stderr(`Unknown command "${first}".`);
    for (const line of usage(commands)) context.stderr(line);
    return USAGE_EXIT_CODE;
  }
  return await command.run(argv.slice(command.name.split(" ").length), context);
}
