/** Keep obvious validation-only commands out of pre-agent dependency setup. */
export function resolveRepositoryCommands(input: {
  setupCommand?: string | null;
  testCommand?: string | null;
}) {
  const setup = input.setupCommand?.trim() || null;
  const check = input.testCommand?.trim() || null;
  // Deliberately match only a single known command. Never split or rewrite
  // shell scripts, pipelines, quoted arguments or install-and-build scripts.
  const validationOnly = Boolean(
    setup &&
      /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:build|test|typecheck|lint)|(?:turbo|(?:pnpm\s+exec|npx)\s+turbo)\s+run\s+(?:build|test|typecheck|lint))$/.test(
        setup,
      ),
  );
  return {
    setupCommand: validationOnly ? null : setup,
    testCommand: validationOnly
      ? [setup, check === setup ? null : check].filter(Boolean).join(" && ")
      : check,
    deferredSetup: validationOnly,
  };
}
