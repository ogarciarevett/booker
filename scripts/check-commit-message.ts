// Entry point for the lefthook commit-msg hook: node scripts/check-commit-message.ts <message-file>
// Exit codes: 0 accepted, 1 rejected, 2 usage or read error.
import { readFileSync } from "node:fs";
import { isAcceptedCommitMessage } from "./commit-message.ts";

const messageFile = process.argv[2];

if (messageFile === undefined) {
  console.error("Usage: node scripts/check-commit-message.ts <message-file>");
  process.exit(2);
}

let message: string;
try {
  message = readFileSync(messageFile, "utf8");
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`Cannot read commit message file "${messageFile}": ${reason}`);
  process.exit(2);
}

if (!isAcceptedCommitMessage(message)) {
  console.error("Commit message must follow Conventional Commits: <type>(<scope>)?: <summary>");
  process.exit(1);
}
