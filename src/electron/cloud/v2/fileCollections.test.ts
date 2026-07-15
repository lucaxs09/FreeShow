import { describe, expect, it } from "vitest"
import { buildFileCollection, fileBaseName, parseFileEntry, planFileApply, sanitizeFileBaseName, type FileEntryInput } from "./fileCollections"

const item = (fileName: string, id: string, value: Record<string, unknown>, mtimeMs = 0): FileEntryInput => ({ fileName, mtimeMs, parsed: { kind: "item", id, value } })

describe("fileCollections — parseFileEntry", () => {
    it("parses a FreeShow [id, value] entry", () => {
        expect(parseFileEntry(JSON.stringify(["show1", { name: "Song", slides: {} }]))).toEqual({ kind: "item", id: "show1", value: { name: "Song", slides: {} } })
    })

    it("recovers a truncated trailing write (same trick as utils/files parseJSON)", () => {
        const valid = JSON.stringify(["show1", { slides: { a: { group: null } } }]) // ends in "}}]"
        const truncated = valid + '","garbage after the trailing marker'
        expect(parseFileEntry(truncated)).toMatchObject({ kind: "item", id: "show1" })
    })

    it("unreadable content is 'invalid' (a synced id could hide in it)", () => {
        expect(parseFileEntry("")).toEqual({ kind: "invalid" })
        expect(parseFileEntry("{ not json")).toEqual({ kind: "invalid" })
    })

    it("readable JSON that is not a FreeShow entry is 'foreign' (safe to ignore)", () => {
        expect(parseFileEntry(JSON.stringify({ some: "object" }))).toEqual({ kind: "foreign" })
        expect(parseFileEntry(JSON.stringify(["id-only"]))).toEqual({ kind: "foreign" })
        expect(parseFileEntry(JSON.stringify([42, {}]))).toEqual({ kind: "foreign" })
        expect(parseFileEntry(JSON.stringify(["id", "not-an-object"]))).toEqual({ kind: "foreign" })
    })
})

describe("fileCollections — file names", () => {
    it("sanitizes cross-OS unsafe characters, Windows trailing dots and very long names", () => {
        expect(sanitizeFileBaseName('A/B\\C:D*E?F"G<H>I|J')).toBe("ABCDEFGHIJ")
        expect(sanitizeFileBaseName("Grace... ")).toBe("Grace")
        expect(sanitizeFileBaseName("x".repeat(400)).length).toBe(150)
        expect(sanitizeFileBaseName("Sublime Gracia (Amazing Grace)")).toBe("Sublime Gracia (Amazing Grace)")
    })

    it("falls back to the id when the name is missing or fully unsafe", () => {
        expect(fileBaseName({ name: "Song" }, "id1")).toBe("Song")
        expect(fileBaseName({}, "id1")).toBe("id1")
        expect(fileBaseName({ name: "///" }, "id1")).toBe("id1")
        expect(fileBaseName(null, "id1")).toBe("id1")
    })
})

describe("fileCollections — buildFileCollection", () => {
    it("maps files by the id INSIDE them (not the file name) and normalizes name to the file name", () => {
        const collection = buildFileCollection([item("Renamed.show", "s1", { name: "Old Name", slides: {} })], ".show")
        expect(collection.items).toEqual({ s1: { name: "Renamed", slides: {} } }) // ← the rename now changes the payload (fixes BUG-6)
        expect(collection.fileNameById).toEqual({ s1: "Renamed.show" })
    })

    it("ignores foreign files, counts invalid ones, filters by extension case-insensitively", () => {
        const entries: FileEntryInput[] = [item("a.show", "s1", { name: "a" }), item("B.SHOW", "s2", { name: "B" }), item("skip.txt", "s3", { name: "skip" }), { fileName: "broken.show", mtimeMs: 0, parsed: { kind: "invalid" } }, { fileName: "foreign.show", mtimeMs: 0, parsed: { kind: "foreign" } }]
        const collection = buildFileCollection(entries, ".show")
        expect(Object.keys(collection.items).sort()).toEqual(["s1", "s2"])
        expect(collection.invalidCount).toBe(1)
    })

    it("duplicate ids: the file whose name matches its inner name wins (a copy keeps the original inner name)", () => {
        const entries = [item("Song copy.show", "s1", { name: "Song" }, 999), item("Song.show", "s1", { name: "Song" }, 1)]
        const collection = buildFileCollection(entries, ".show")
        expect(collection.fileNameById.s1).toBe("Song.show")
    })

    it("duplicate ids: a fresh rename beats its stale leftover (newest mtime when both are self-consistent)", () => {
        const entries = [item("Old.show", "s1", { name: "Old" }, 100), item("New.show", "s1", { name: "New" }, 200)]
        expect(buildFileCollection(entries, ".show").fileNameById.s1).toBe("New.show")
    })

    it("duplicate ids: fully deterministic fallback (lexicographic)", () => {
        const entries = [item("b.show", "s1", { name: "x" }, 5), item("a.show", "s1", { name: "x" }, 5)]
        expect(buildFileCollection(entries, ".show").fileNameById.s1).toBe("a.show")
    })

    it("also reports EVERY file carrying each id (so pulled changes can sweep rename leftovers)", () => {
        const entries = [item("Old.show", "s1", { name: "Old" }, 100), item("New.show", "s1", { name: "New" }, 200), item("Other.show", "s2", { name: "Other" })]
        const collection = buildFileCollection(entries, ".show")
        expect(collection.allFileNamesById.s1.sort()).toEqual(["New.show", "Old.show"])
        expect(collection.allFileNamesById.s2).toEqual(["Other.show"])
    })

    it("applies the adapter skip filter (legacy 'deleted: true' placeholders)", () => {
        const entries = [item("gone.show", "s1", { name: "gone", deleted: true }), item("live.show", "s2", { name: "live" })]
        const collection = buildFileCollection(entries, ".show", (payload) => !!(payload as any)?.deleted)
        expect(Object.keys(collection.items)).toEqual(["s2"])
    })
})

describe("fileCollections — planFileApply", () => {
    it("writes a new item to '<name><ext>' with the [id, value] content", () => {
        const planned = planFileApply({ changes: [{ id: "s1", payload: { name: "Song", slides: {} } }], fileNameById: {}, extension: ".show" })
        expect(planned).toEqual([{ id: "s1", write: { fileName: "Song.show", content: JSON.stringify(["s1", { name: "Song", slides: {} }]) }, remove: [] }])
    })

    it("a pulled rename writes the new file and removes the old one", () => {
        const planned = planFileApply({ changes: [{ id: "s1", payload: { name: "New" } }], fileNameById: { s1: "Old.show" }, extension: ".show" })
        expect(planned[0].write?.fileName).toBe("New.show")
        expect(planned[0].remove).toEqual(["Old.show"])
    })

    it("an unchanged name rewrites in place without removals", () => {
        const planned = planFileApply({ changes: [{ id: "s1", payload: { name: "Same" } }], fileNameById: { s1: "Same.show" }, extension: ".show" })
        expect(planned[0]).toEqual({ id: "s1", write: { fileName: "Same.show", content: JSON.stringify(["s1", { name: "Same" }]) }, remove: [] })
    })

    it("NEVER clobbers a different item that owns the target file name (disambiguates with the id)", () => {
        const planned = planFileApply({ changes: [{ id: "s2", payload: { name: "Song" } }], fileNameById: { s1: "Song.show" }, extension: ".show" })
        expect(planned[0].write?.fileName).toBe("Song (s2).show")
    })

    it("two writes in the same batch cannot target the same file", () => {
        const planned = planFileApply({
            changes: [
                { id: "a", payload: { name: "Same" } },
                { id: "b", payload: { name: "Same" } }
            ],
            fileNameById: {},
            extension: ".show"
        })
        expect(planned[0].write?.fileName).toBe("Same.show")
        expect(planned[1].write?.fileName).toBe("Same (b).show")
    })

    it("a remote tombstone removes the id's file; no file → nothing to remove (still a success)", () => {
        const planned = planFileApply({
            changes: [
                { id: "s1", payload: null },
                { id: "ghost", payload: null }
            ],
            fileNameById: { s1: "Song.show" },
            extension: ".show"
        })
        expect(planned).toEqual([
            { id: "s1", remove: ["Song.show"] },
            { id: "ghost", remove: [] }
        ])
    })

    it("REGRESSION: a delete + a create reusing the same file name never unlink the fresh write (team-wide loss)", () => {
        // device A deleted show X ("Song.show"); device B created a NEW show Y reusing the title
        // "Song". The pull batches the write (Y) before the delete (X) — exactly like the manager
        // does — and X's tombstone must NOT remove the file Y just wrote.
        const planned = planFileApply({
            changes: [
                { id: "Y", payload: { name: "Song" } }, // writes first (fetched before deletes)
                { id: "X", payload: null }
            ],
            fileNameById: { X: "Song.show" },
            extension: ".show"
        })
        expect(planned[0]).toEqual({ id: "Y", write: { fileName: "Song.show", content: JSON.stringify(["Y", { name: "Song" }]) }, remove: [] })
        expect(planned[1]).toEqual({ id: "X", remove: [] }) // the path is already logically replaced by Y's write
    })

    it("REGRESSION: a name swap between two items (X: A→B, Y: C→A) never unlinks a same-batch write", () => {
        const planned = planFileApply({
            changes: [
                { id: "X", payload: { name: "B" } },
                { id: "Y", payload: { name: "A" } }
            ],
            fileNameById: { X: "A.show", Y: "C.show" },
            extension: ".show"
        })
        expect(planned[0].write?.fileName).toBe("B.show")
        expect(planned[0].remove).toEqual([]) // "A.show" is written by Y in this same batch
        expect(planned[1].write?.fileName).toBe("A.show")
        expect(planned[1].remove).toEqual(["C.show"])
    })

    it("sweeps the stale leftover of a failed rename cleanup (same id on two disk files)", () => {
        // a previous run renamed Song→Hymn but the unlink of "Song.show" failed; the retry sees
        // the id already at "Hymn.show" and must still clean the orphan carrying the same id
        const planned = planFileApply({
            changes: [{ id: "s1", payload: { name: "Hymn" } }],
            fileNameById: { s1: "Hymn.show" },
            allFileNamesById: { s1: ["Hymn.show", "Song.show"] },
            extension: ".show"
        })
        expect(planned[0].write?.fileName).toBe("Hymn.show")
        expect(planned[0].remove).toEqual(["Song.show"])
    })

    it("a remote tombstone sweeps EVERY disk file carrying the id, not just the winner", () => {
        const planned = planFileApply({
            changes: [{ id: "s1", payload: null }],
            fileNameById: { s1: "New.show" },
            allFileNamesById: { s1: ["New.show", "Old.show"] },
            extension: ".show"
        })
        expect(planned[0].remove.sort()).toEqual(["New.show", "Old.show"])
    })

    it("an id whose own file is being replaced does not block its own name", () => {
        // s1 currently at "Song.show" and stays "Song": target equals its own current file
        const planned = planFileApply({ changes: [{ id: "s1", payload: { name: "Song" } }], fileNameById: { s1: "Song.show" }, extension: ".show" })
        expect(planned[0].write?.fileName).toBe("Song.show")
        expect(planned[0].remove).toEqual([])
    })

    // REGRESSION hardening: the 2-way cases above (delete+create, name-swap) proved the fix works
    // for one collision. A three-way collision in the same batch (delete X + rename B→"Same" +
    // create C→"Same") exercises the disambiguation ("taken" set) and the writeTargets filter
    // together. Who "wins" the contested name depends on processing order (first id encountered
    // claims it, per the `taken` set) — that's expected and fine. What must hold regardless of
    // order is the safety invariant: every write actually lands, and no remove ever unlinks a
    // path some change in the same batch just wrote.
    it.each([
        [
            "delete-first order",
            [
                { id: "X", payload: null },
                { id: "B", payload: { name: "Same" } },
                { id: "C", payload: { name: "Same" } }
            ]
        ],
        [
            "create-first order",
            [
                { id: "C", payload: { name: "Same" } },
                { id: "B", payload: { name: "Same" } },
                { id: "X", payload: null }
            ]
        ]
    ])("REGRESSION: a three-way name collision (delete X + rename B→name + create C→name) never aniquilates a write — %s", (_label, changes) => {
        const planned = planFileApply({
            changes,
            fileNameById: { X: "Same.show", B: "Bee.show" },
            extension: ".show"
        })
        const byId = Object.fromEntries(planned.map((change) => [change.id, change]))

        // both B and C get a real, distinct file (one claims "Same.show", the other is
        // disambiguated by its own id) — neither is silently dropped
        expect(byId.B.write?.fileName).toBeTruthy()
        expect(byId.C.write?.fileName).toBeTruthy()
        expect(byId.B.write?.fileName).not.toBe(byId.C.write?.fileName)
        expect([byId.B.write?.fileName, byId.C.write?.fileName]).toContain("Same.show")

        // the safety invariant the crash was about: no remove (X's tombstone, or the loser's
        // old-name cleanup) ever targets a path this same batch just wrote
        const writeTargets = new Set(planned.map((change) => change.write?.fileName).filter(Boolean))
        for (const change of planned) for (const removed of change.remove) expect(writeTargets.has(removed)).toBe(false)
    })
})
