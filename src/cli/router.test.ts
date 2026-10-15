import { describe, expect, it } from "vitest";
import { type Command, type CommandOutput, runCommand, usage } from "./router.ts";

interface Recorded extends CommandOutput {
  readonly out: string[];
  readonly err: string[];
}

function output(): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/** A command that records the arguments it received and exits with `exitCode`. */
function recordingCommand(name: string, exitCode = 0) {
  const received: (readonly string[])[] = [];
  const command: Command<Recorded> = {
    name,
    summary: `Runs ${name}`,
    run: async (args) => {
      received.push(args);
      return exitCode;
    },
  };
  return { command, received };
}

describe("runCommand", () => {
  it("runs the matching command with the remaining arguments and returns its exit code", async () => {
    const serve = recordingCommand("serve", 0);
    const call = recordingCommand("call", 3);
    const io = output();

    const exitCode = await runCommand(
      ["call", "--to", "+15550100"],
      [serve.command, call.command],
      io,
    );

    expect(exitCode).toBe(3);
    expect(call.received).toEqual([["--to", "+15550100"]]);
    expect(serve.received).toEqual([]);
    expect(io.err).toEqual([]);
  });

  it("matches a command of several words, preferring the longest name", async () => {
    const agent = recordingCommand("agent");
    const agentSync = recordingCommand("agent sync");
    const io = output();

    await runCommand(["agent", "sync", "--dry-run"], [agent.command, agentSync.command], io);
    await runCommand(["agent", "status"], [agent.command, agentSync.command], io);

    expect(agentSync.received).toEqual([["--dry-run"]]);
    expect(agent.received).toEqual([["status"]]);
  });

  it("prints usage to stderr and exits 2 when no command is given", async () => {
    const serve = recordingCommand("serve");
    const io = output();

    const exitCode = await runCommand([], [serve.command], io);

    expect(exitCode).toBe(2);
    expect(io.err).toEqual(usage([serve.command]));
    expect(io.out).toEqual([]);
  });

  it("names an unknown command, prints usage to stderr, and exits 2", async () => {
    const serve = recordingCommand("serve");
    const io = output();

    const exitCode = await runCommand(["serv"], [serve.command], io);

    expect(exitCode).toBe(2);
    expect(io.err).toEqual(['Unknown command "serv".', ...usage([serve.command])]);
    expect(serve.received).toEqual([]);
  });

  it.each(["help", "--help", "-h"])("prints usage to stdout and exits 0 for %s", async (flag) => {
    const serve = recordingCommand("serve");
    const io = output();

    const exitCode = await runCommand([flag], [serve.command], io);

    expect(exitCode).toBe(0);
    expect(io.out).toEqual(usage([serve.command]));
    expect(io.err).toEqual([]);
  });
});

describe("usage", () => {
  it("lists every command with its summary, aligned", () => {
    const commands = [recordingCommand("serve").command, recordingCommand("agent sync").command];

    expect(usage(commands)).toEqual([
      "Usage: pnpm booker <command>",
      "",
      "Commands:",
      "  serve       Runs serve",
      "  agent sync  Runs agent sync",
      "  help        Shows this help",
    ]);
  });
});
