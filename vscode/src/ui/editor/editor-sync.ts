export interface ReloadableDocument {
  uri: { scheme: string; fsPath: string };
  isDirty: boolean;
}

export function reloadOpenEditors(
  documents: readonly ReloadableDocument[],
  absPath: string,
  revert: (uri: { scheme: string; fsPath: string }) => void,
): number {
  let reloaded = 0; // counter of reloaded editors
  for (const doc of documents) {
    if (doc.uri.scheme !== "file" || doc.uri.fsPath !== absPath || doc.isDirty) {
      continue;
    }
    revert(doc.uri);
    reloaded++;
  }
  return reloaded;
}
