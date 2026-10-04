/**
 * What the console says when a project has no checkout for an agent.
 *
 * The button opens Repositories, which lives in the top bar. The
 * sentence names that place so the button is also a direction.
 */
export const REPOSITORY_SETUP_MESSAGE =
  "This project has no repositories, so agents cannot run. Open Repositories in the top bar and add one.";

export const REPOSITORY_SETUP_ACTION = "Add a repository";

/**
 * True only when a repository list was read and came back empty.
 *
 * Null is unknown: the list has not arrived, or the read failed. A
 * failed load is the same answer. Either one must leave starting work
 * available, because an empty list and a missing list are different
 * claims.
 */
export function repositoriesMissing(
  repos: readonly { id: string }[] | null,
  loadFailed: boolean,
): boolean {
  return repos !== null && repos.length === 0 && !loadFailed;
}
