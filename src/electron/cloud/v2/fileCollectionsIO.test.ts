// Real-filesystem tests for the thin disk layer (temp folders, no mocks): what matters here is
// the FAILURE reporting — a change that didn't fully reach the disk must be reported as failed
// so the orchestrator retries it instead of marking it applied (phantom-tombstone protection).

import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { executeFileChanges, readFileCollectionEntries } from "./fileCollectionsIO"

let folder: string
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "fs-sync-v2-test-"))
})
afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
})

const write = (name: string, content: string) => fs.writeFileSync(path.join(folder, name), content)

describe("fileCollectionsIO — readFileCollectionEntries", () => {
    it("reads and parses only files with the extension", async () => {
        write("Song.show", JSON.stringify(["s1", { name: "Song" }]))
        write("skip.txt", "nope")
        write("broken.show", "{ not json")

        const result = await readFileCollectionEntries(folder, ".show")
        expect(result.healthy).toBe(true)
        expect(result.entries.map((entry) => [entry.fileName, entry.parsed.kind]).sort()).toEqual([
            ["Song.show", "item"],
            ["broken.show", "invalid"]
        ])
        expect(result.entries.find((entry) => entry.fileName === "Song.show")?.mtimeMs).toBeGreaterThan(0)
    })

    it("a missing folder is a valid empty collection (fresh install)", async () => {
        const result = await readFileCollectionEntries(path.join(folder, "does-not-exist"), ".show")
        expect(result).toEqual({ healthy: true, entries: [] })
    })

    it("an unlistable folder is UNHEALTHY, never 'empty' (that difference prevents mass tombstones)", async () => {
        const filePath = path.join(folder, "file-not-folder")
        fs.writeFileSync(filePath, "x")
        const result = await readFileCollectionEntries(filePath, ".show")
        expect(result.healthy).toBe(false)
    })

    it("ignores subfolders even when their name matches the extension", async () => {
        fs.mkdirSync(path.join(folder, "weird.show"))
        write("real.show", JSON.stringify(["s1", { name: "real" }]))
        const result = await readFileCollectionEntries(folder, ".show")
        expect(result.entries.map((entry) => entry.fileName)).toEqual(["real.show"])
    })
})

describe("fileCollectionsIO — executeFileChanges", () => {
    it("writes, renames (write + remove) and deletes; reports success per change", async () => {
        write("Old.show", JSON.stringify(["s1", { name: "Old" }]))
        write("Bye.show", JSON.stringify(["s2", { name: "Bye" }]))

        const results = await executeFileChanges(folder, [
            { id: "s1", write: { fileName: "New.show", content: JSON.stringify(["s1", { name: "New" }]) }, remove: ["Old.show"] },
            { id: "s2", remove: ["Bye.show"] },
            { id: "s3", write: { fileName: "Created.show", content: JSON.stringify(["s3", { name: "Created" }]) }, remove: [] }
        ])

        expect(results).toEqual([
            { id: "s1", success: true },
            { id: "s2", success: true },
            { id: "s3", success: true }
        ])
        expect(fs.readdirSync(folder).sort()).toEqual(["Created.show", "New.show"])
        expect(JSON.parse(fs.readFileSync(path.join(folder, "New.show"), "utf8"))).toEqual(["s1", { name: "New" }])
    })

    it("removing an already-missing file is a success (the goal state is reached)", async () => {
        const results = await executeFileChanges(folder, [{ id: "s1", remove: ["ghost.show"] }])
        expect(results).toEqual([{ id: "s1", success: true }])
    })

    it("creates the folder when writing into a missing one", async () => {
        const nested = path.join(folder, "sub")
        const results = await executeFileChanges(nested, [{ id: "s1", write: { fileName: "a.show", content: "[]" }, remove: [] }])
        expect(results[0].success).toBe(true)
        expect(fs.existsSync(path.join(nested, "a.show"))).toBe(true)
    })

    it("REGRESSION (defense in depth): never unlinks a path written in the same batch", async () => {
        // planFileApply already guarantees this; this guard protects the disk even if a future
        // change breaks that guarantee (a delete + a create reusing the same file name)
        write("Song.show", JSON.stringify(["X", { name: "Song" }]))

        const results = await executeFileChanges(folder, [
            { id: "Y", write: { fileName: "Song.show", content: JSON.stringify(["Y", { name: "Song" }]) }, remove: [] },
            { id: "X", remove: ["Song.show"] }
        ])

        expect(results).toEqual([
            { id: "Y", success: true },
            { id: "X", success: true }
        ])
        expect(JSON.parse(fs.readFileSync(path.join(folder, "Song.show"), "utf8"))).toEqual(["Y", { name: "Song" }])
    })

    it("a failed write is reported as FAILED and does not run the removals (no phantom apply)", async () => {
        write("Old.show", "old")
        // writing under a path where a FILE blocks the folder creation → write fails
        const blocked = path.join(folder, "Old.show", "impossible")
        const results = await executeFileChanges(blocked, [{ id: "s1", write: { fileName: "x.show", content: "[]" }, remove: ["Old.show"] }])
        expect(results).toEqual([{ id: "s1", success: false }])
        expect(fs.existsSync(path.join(folder, "Old.show"))).toBe(true) // removal skipped
    })
})
