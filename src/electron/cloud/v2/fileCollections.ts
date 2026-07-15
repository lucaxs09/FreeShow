// ----- FreeShow -----
// Sync v2: pure logic for FILE-BACKED collections (Shows/*.show, Bibles/*.fsb).
//
// Pure module (no I/O, no Electron). Each item lives as its own JSON file with the shape
// `[id, value]`, named after the item's display name (v1 convention: save.ts). v1 tracked these
// by FILE NAME, so renaming an item lost its whole sync history (BUG-6) and a bible's content
// could silently stop traveling (BUG-4). v2 tracks them by the immutable `id` inside the file:
// this module turns a folder listing into an id → payload map (change detection input) and turns
// pulled changes back into concrete write/delete file operations (executed by fileCollectionsIO).
//
// Name normalization: FreeShow itself treats the FILE NAME as the item's real name (loadShows
// overrides `show.name` with the file name), and a rename may only rename the file without
// rewriting its content. Reading therefore overrides `payload.name` with the file's base name —
// so a rename changes the payload hash and syncs like any other edit (this is what fixes BUG-6).

export type ParsedFileEntry =
    | { kind: "item"; id: string; value: Record<string, unknown> }
    // readable JSON but not a FreeShow `[id, value]` entry — some foreign file in the folder.
    // Never written by FreeShow, so no synced id can hide in it: safe to ignore entirely.
    | { kind: "foreign" }
    // unreadable/corrupt: a synced item's id COULD live here, so deletions for the whole type
    // must be suppressed this run (we can't tell "deleted" from "unreadable")
    | { kind: "invalid" }

export function parseFileEntry(raw: string): ParsedFileEntry {
    if (!raw) return { kind: "invalid" }

    let parsed: unknown = null
    try {
        parsed = JSON.parse(raw)
    } catch {
        // same recovery as utils/files parseJSON: try to trim a truncated trailing write
        try {
            parsed = JSON.parse(raw.slice(0, raw.indexOf("}}]") + 3))
        } catch {
            return { kind: "invalid" }
        }
    }

    if (!Array.isArray(parsed) || parsed.length < 2) return { kind: "foreign" }
    const [id, value] = parsed as [unknown, unknown]
    if (typeof id !== "string" || !id) return { kind: "foreign" }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "foreign" }
    return { kind: "item", id, value: value as Record<string, unknown> }
}

// strip characters that can break out of the folder or are illegal on Windows; cap the length.
// v1 wrote names raw — sanitizing only matters for names arriving FROM another device/OS.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const MAX_BASE_NAME_LENGTH = 150

export function sanitizeFileBaseName(name: string): string {
    return name
        .replace(UNSAFE_NAME_CHARS, "")
        .slice(0, MAX_BASE_NAME_LENGTH)
        .replace(/[. ]+$/, "") // Windows: no trailing dots/spaces
        .trim()
}

export function fileBaseName(payload: unknown, id: string): string {
    const name = (payload as any)?.name
    const base = typeof name === "string" ? sanitizeFileBaseName(name) : ""
    return base || id
}

export interface FileEntryInput {
    fileName: string
    mtimeMs: number
    parsed: ParsedFileEntry
}

export interface FileCollection {
    items: { [id: string]: unknown } // payloads with `name` normalized to the file's base name
    fileNameById: { [id: string]: string } // which disk file currently represents each id
    // EVERY disk file carrying each id (winner + stale leftovers of a failed rename cleanup),
    // so planFileApply can sweep the leftovers when a pulled change touches that id
    allFileNamesById: { [id: string]: string[] }
    invalidCount: number // unreadable files → the caller must suppress deletions for this type
}

function baseNameOf(fileName: string, extension: string): string {
    return fileName.slice(0, fileName.length - extension.length)
}

function hasExtension(fileName: string, extension: string): boolean {
    return fileName.toLowerCase().endsWith(extension.toLowerCase()) && fileName.length > extension.length
}

// Turn a folder listing into the id → payload map. Duplicate ids (a user file copy, or a stale
// leftover of a failed rename) resolve deterministically to ONE representative file:
//   1. the file whose name matches the name INSIDE it (a copy keeps the original inner name, so
//      the original file wins; a rename leftover matches itself, so this alone can't decide),
//   2. then the most recently modified file (a fresh rename beats its stale leftover),
//   3. then the lexicographically first (full determinism).
// The losing duplicates are ignored, never deleted.
export function buildFileCollection(entries: FileEntryInput[], extension: string, skip?: (payload: unknown) => boolean): FileCollection {
    const collection: FileCollection = { items: {}, fileNameById: {}, allFileNamesById: {}, invalidCount: 0 }

    const byId = new Map<string, FileEntryInput[]>()
    for (const entry of [...entries].sort((a, b) => (a.fileName < b.fileName ? -1 : 1))) {
        if (!hasExtension(entry.fileName, extension)) continue
        if (entry.parsed.kind === "invalid") {
            collection.invalidCount++
            continue
        }
        if (entry.parsed.kind === "foreign") continue
        if (!byId.has(entry.parsed.id)) byId.set(entry.parsed.id, [])
        byId.get(entry.parsed.id)!.push(entry)
    }

    for (const [id, candidates] of byId) {
        const score = (entry: FileEntryInput) => {
            const parsed = entry.parsed as { kind: "item"; id: string; value: Record<string, unknown> }
            const innerName = typeof parsed.value.name === "string" ? sanitizeFileBaseName(parsed.value.name) : ""
            return innerName && innerName === baseNameOf(entry.fileName, extension) ? 1 : 0
        }
        let winner = candidates[0]
        for (const candidate of candidates.slice(1)) {
            if (score(candidate) > score(winner)) winner = candidate
            else if (score(candidate) === score(winner) && candidate.mtimeMs > winner.mtimeMs) winner = candidate
        }

        const value = (winner.parsed as { kind: "item"; value: Record<string, unknown> }).value
        // normalize the name to the file's base name (see module header — this is what makes renames sync)
        const payload = { ...value, name: baseNameOf(winner.fileName, extension) }
        if (skip?.(payload)) continue

        collection.items[id] = payload
        collection.fileNameById[id] = winner.fileName
        collection.allFileNamesById[id] = candidates.map((candidate) => candidate.fileName)
    }

    return collection
}

// one pulled change translated to disk operations. State for the id is only updated when EVERY
// operation succeeded (a failed write/delete is retried on the next sync — never a phantom apply).
export interface PlannedFileChange {
    id: string
    write?: { fileName: string; content: string }
    remove: string[] // file names to delete (old name after a rename, or the file of a tombstoned id)
}

export interface FileApplyInput {
    // pulled winners: payload to write, or null = remote tombstone (delete the file)
    changes: { id: string; payload: unknown | null }[]
    fileNameById: { [id: string]: string } // current disk state (from buildFileCollection)
    // every disk file carrying each id (from buildFileCollection): lets a change also sweep the
    // stale leftover of a rename whose old-file removal failed on a previous run (which the
    // retry could never clean by itself — the retry only sees the id's current winner file)
    allFileNamesById?: { [id: string]: string[] }
    extension: string
}

export function planFileApply(input: FileApplyInput): PlannedFileChange[] {
    const planned: PlannedFileChange[] = []

    // ALL disk files carrying the id, not just the winner (see allFileNamesById above)
    const filesOf = (id: string): string[] => {
        const existing = input.fileNameById[id]
        const all = input.allFileNamesById?.[id] ?? []
        return existing && !all.includes(existing) ? [...all, existing] : all
    }

    // file names already used by OTHER ids (collision guard: never clobber a different item)
    const taken = new Set<string>()
    for (const [id, fileName] of Object.entries(input.fileNameById)) {
        if (!input.changes.some((change) => change.id === id)) taken.add(fileName)
    }

    for (const change of input.changes) {
        if (change.payload === null || change.payload === undefined) {
            planned.push({ id: change.id, remove: filesOf(change.id) })
            continue
        }

        let fileName = fileBaseName(change.payload, change.id) + input.extension
        // another item already owns that file name → disambiguate with the (unique) id
        if (taken.has(fileName)) fileName = `${fileBaseName(change.payload, change.id)} (${change.id})${input.extension}`
        taken.add(fileName)

        planned.push({
            id: change.id,
            write: { fileName, content: JSON.stringify([change.id, change.payload]) },
            remove: filesOf(change.id).filter((name) => name !== fileName)
        })
    }

    // A remove must NEVER target a path that any change in this batch writes: the written content
    // IS the desired final state of that path, so the old occupant is already logically replaced.
    // Without this, delete-X + create-Y-reusing-X's-name (or a name swap between two items) would
    // unlink the freshly written file — and its absence on the next run would read as a local
    // deletion, tombstoning the brand-new item for the whole team.
    const writeTargets = new Set(planned.map((change) => change.write?.fileName).filter(Boolean) as string[])
    for (const change of planned) change.remove = change.remove.filter((name) => !writeTargets.has(name))

    return planned
}
