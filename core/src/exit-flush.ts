/**
 * Exit flush (spec D6): when the window goes away, everything the user never decided
 * resolves to the AGENT's new code — the rule the user chose ("thoát VS Code → dùng code
 * mới của agents, dọn cache").
 *
 * Accepting only the *pending* hunk ids is deliberate: a hunk the user already rejected must
 * stay rejected, and a hunk already accepted stays as it is. For a change with no hunks
 * (binary, framing-only) the id list is empty, which resolves the set without touching any
 * decision. The store then writes the resolved bytes, advances the baseline and marks the
 * set `resolved`; `pruneResolved(0)` drops those records so the next start is genuinely
 * clean (this is what finally empties the ~200 historical entries).
 *
 * Pure of `vscode`: the store and the workspace list arrive as parameters, so the rule is
 * unit-testable and `src/extension.ts` only wires it.
 */
import type { ChangeSet } from "./types";

export interface FlushStore {
  listChangeSets(workspace: string): ChangeSet[];
  accept(changeId: string, hunkIds?: string[]): unknown;
  pruneResolved(maxAgeMs?: number): void;
}

export interface FlushResult {
  /** Changes this flush resolved (and therefore wrote / pruned). */
  accepted: number;
  workspaces: number;
}

export function flushPendingReviews(store: FlushStore, workspaces: string[]): FlushResult {
  const result: FlushResult = { accepted: 0, workspaces: workspaces.length };
  for (const workspace of workspaces) {
    for (const cs of store.listChangeSets(workspace)) {
      const pending = cs.hunks.filter((h) => h.decision === "pending").map((h) => h.id);
      store.accept(cs.id, pending);
      result.accepted++;
    }
  }
  store.pruneResolved(0);
  return result;
}
