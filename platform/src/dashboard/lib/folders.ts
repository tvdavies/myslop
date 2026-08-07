import type { FolderSummary } from "@/types/api";

export interface NestedFolder {
  folder: FolderSummary;
  depth: number;
}

export function folderById(folders: FolderSummary[], id: string | null | undefined): FolderSummary | null {
  return folders.find((folder) => folder.id === id) ?? null;
}

export function folderPath(folders: FolderSummary[], folder: FolderSummary): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let current: FolderSummary | null = folder;
  while (current && !visited.has(current.id)) {
    names.unshift(current.name);
    visited.add(current.id);
    current = folderById(folders, current.parentId);
  }
  return names.join(" / ");
}

export function nestedFolders(
  folders: FolderSummary[],
  parentId: string | null = null,
  depth = 0,
  visited = new Set<string>(),
): NestedFolder[] {
  return folders
    .filter((folder) => (folder.parentId || null) === parentId && !visited.has(folder.id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((folder) => {
      const nextVisited = new Set(visited).add(folder.id);
      return [{ folder, depth }, ...nestedFolders(folders, folder.id, depth + 1, nextVisited)];
    });
}

export function descendantFolderIds(folders: FolderSummary[], folderId: string): Set<string> {
  const descendants = new Set(folderId ? [folderId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && descendants.has(folder.parentId) && !descendants.has(folder.id)) {
        descendants.add(folder.id);
        changed = true;
      }
    }
  }
  return descendants;
}

export function availableFolderOptions(folders: FolderSummary[], excludedId = ""): NestedFolder[] {
  const excluded = descendantFolderIds(folders, excludedId);
  return nestedFolders(folders).filter(({ folder }) => !excluded.has(folder.id));
}
