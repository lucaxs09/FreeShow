// ----- FreeShow -----
// Sync v2: disk I/O for file-backed collections (Shows/*.show, Bibles/*.fsb).
//
// Deliberately thin: every decision (parsing, duplicate resolution, name normalization, which
// files to write/delete) lives in the pure fileCollections.ts. This module only lists, reads,
// writes and deletes files, reporting failures explicitly so the orchestrator never marks a
// change as applied when the disk said no (that would fabricate tombstones on the next run).
//
// Uses bare `fs` (not utils/files) on purpose: those helpers swallow errors into "" / [], which
// is exactly what sync must NOT do — an unreadable folder is not an empty one.

import fs from "fs"
import path from "path"
import { parseFileEntry, type FileEntryInput, type PlannedFileChange } from "./fileCollections"

export interface FileCollectionRead {
    // false = the folder exists but could not be listed: local changes for this type must be
    // skipped entirely this run (we can't see the files, so nothing may be inferred from absence)
    healthy: boolean
    entries: FileEntryInput[]
}

export async function readFileCollectionEntries(folderPath: string, extension: string): Promise<FileCollectionRead> {
    let fileNames: string[]
    try {
        fileNames = await fs.promises.readdir(folderPath)
    } catch (err: any) {
        // a missing folder is a valid empty collection (fresh install); anything else is unhealthy
        if (err?.code === "ENOENT") return { healthy: true, entries: [] }
        console.error("Sync v2: could not list folder:", folderPath, err)
        return { healthy: false, entries: [] }
    }

    const entries: FileEntryInput[] = []
    for (const fileName of fileNames) {
        if (!fileName.toLowerCase().endsWith(extension.toLowerCase())) continue

        const filePath = path.join(folderPath, fileName)
        try {
            const stat = await fs.promises.stat(filePath)
            if (!stat.isFile()) continue
            const raw = await fs.promises.readFile(filePath, "utf8")
            entries.push({ fileName, mtimeMs: stat.mtimeMs, parsed: parseFileEntry(raw) })
        } catch (err) {
            // unreadable file: a synced id could live in it → parseFileEntry("") = "invalid",
            // which makes the caller suppress deletions for this type this run
            console.error("Sync v2: could not read file:", filePath, err)
            entries.push({ fileName, mtimeMs: 0, parsed: parseFileEntry("") })
        }
    }

    return { healthy: true, entries }
}

// Executes one planned change (write + removals). Success ONLY when everything succeeded:
// a failed removal after a rename would leave two files with the same id, and reporting success
// would let the stale one win a future duplicate resolution — so the whole change is retried.
export async function executeFileChanges(folderPath: string, planned: PlannedFileChange[]): Promise<{ id: string; success: boolean }[]> {
    const results: { id: string; success: boolean }[] = []

    // defense in depth (planFileApply already guarantees this): never unlink a path that another
    // change in the same batch writes — the written content is the desired final state of that
    // path, and unlinking it would silently destroy a just-applied item
    const writeTargets = new Set(planned.map((change) => change.write?.fileName).filter(Boolean) as string[])

    for (const change of planned) {
        let success = true

        if (change.write) {
            try {
                await fs.promises.mkdir(folderPath, { recursive: true })
                await fs.promises.writeFile(path.join(folderPath, change.write.fileName), change.write.content)
            } catch (err) {
                console.error("Sync v2: could not write file:", change.write.fileName, err)
                success = false
            }
        }

        if (success) {
            for (const fileName of change.remove) {
                if (writeTargets.has(fileName)) continue // see writeTargets above
                try {
                    await fs.promises.unlink(path.join(folderPath, fileName))
                } catch (err: any) {
                    if (err?.code === "ENOENT") continue // already gone: that's the goal
                    console.error("Sync v2: could not delete file:", fileName, err)
                    success = false
                }
            }
        }

        results.push({ id: change.id, success })
    }

    return results
}
