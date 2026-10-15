// Conventional Commits check shared by the commit-msg hook and its tests.

const CONVENTIONAL_SUBJECT =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9-]+\))?!?: \S/;

// Subjects that git writes on its own (merge, revert, autosquash) are accepted as-is.
const GIT_GENERATED_SUBJECT = /^(Merge |Revert "|fixup! |squash! |amend! )/;

export const isAcceptedCommitMessage = (message: string): boolean => {
  const subject = message.split("\n", 1)[0] ?? "";
  return CONVENTIONAL_SUBJECT.test(subject) || GIT_GENERATED_SUBJECT.test(subject);
};
