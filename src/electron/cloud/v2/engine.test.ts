import { describe, expect, it } from "vitest"
import { acceptFetchedEntity, applyPull, buildEntity, buildPush, detectLocalChanges, planPull, TOMBSTONE_TTL_MS, type ItemsState } from "./engine"
import { payloadHash, SYNC_SCHEMA_VERSION, type DeviceJournal, type JournalEntry, type SyncEntity } from "./entity"
import { hlcCompare, hlcDeviceId, hlcFromParts, hlcWallMs } from "./hlc"

const NOW = 1750000000000

function entry(overrides: Partial<JournalEntry> & { id: string; hlc: string }): JournalEntry {
    return { type: "project", schema: SYNC_SCHEMA_VERSION, deletedAt: null, payloadHash: "h", ...overrides }
}

function journal(deviceId: string, entries: JournalEntry[]): DeviceJournal {
    return { version: 1, deviceId, writtenAt: NOW, entries }
}

function entityOf(journalEntry: JournalEntry, payload: unknown): SyncEntity {
    return { id: journalEntry.id, type: journalEntry.type, schema: journalEntry.schema, hlc: journalEntry.hlc, deletedAt: null, payloadHash: payloadHash(payload), payload }
}

// ----- local change detection -----

describe("engine — detectLocalChanges", () => {
    it("assigns a fresh HLC to new items and keeps it stable while unchanged (idempotent)", () => {
        const first = detectLocalChanges({ items: {}, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const state = first.items.project.p1
        expect(hlcDeviceId(state.hlc)).toBe("A")
        expect(state.hash).toBe(payloadHash({ name: "P" }))

        // re-running with the same input changes NOTHING (migration/detection is idempotent)
        const second = detectLocalChanges({ items: first.items, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW + 999, lastHlc: first.lastHlc, seedMode: false })
        expect(second.items).toEqual(first.items)
        expect(second.lastHlc).toBe(first.lastHlc)
    })

    it("bumps the HLC when the content changed", () => {
        const first = detectLocalChanges({ items: {}, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const second = detectLocalChanges({ items: first.items, current: { project: { p1: { name: "P2" } } }, deviceId: "A", nowMs: NOW + 1, lastHlc: first.lastHlc, seedMode: false })
        expect(hlcCompare(second.items.project.p1.hlc, first.items.project.p1.hlc)).toBeGreaterThan(0)
    })

    it("seed mode (v1 → v2 migration) versions items by their OWN modified time, not 'now'", () => {
        const modified = NOW - 1000 * 60 * 60 * 24 * 30
        const result = detectLocalChanges({
            items: {},
            current: { project: { p1: { name: "P", modified } } },
            deviceId: "A",
            nowMs: NOW,
            lastHlc: null,
            seedMode: true,
            seedWallMs: (_type, payload) => (payload as any).modified || 0
        })
        expect(hlcWallMs(result.items.project.p1.hlc)).toBe(modified)
    })

    it("seed mode clamps future timestamps to now (a skewed clock can't pre-win conflicts)", () => {
        const result = detectLocalChanges({ items: {}, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: true, seedWallMs: () => NOW + 999999 })
        expect(hlcWallMs(result.items.project.p1.hlc)).toBe(NOW)
    })

    it("folds seed HLCs into lastHlc: a post-migration edit outranks the seed even after a clock rollback", () => {
        const modified = NOW - 1000
        const seeded = detectLocalChanges({ items: {}, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: true, seedWallMs: () => modified })
        const seedHlc = seeded.items.project.p1.hlc
        expect(seeded.lastHlc).toBe(seedHlc)

        // the wall clock went BACKWARDS below the seed's wall time (NTP correction, VM restore…):
        // the edit must STILL version strictly above the seed, or peers would keep the old content
        const edited = detectLocalChanges({ items: seeded.items, current: { project: { p1: { name: "edited" } } }, deviceId: "A", nowMs: modified - 5000, lastHlc: seeded.lastHlc, seedMode: false })
        expect(hlcCompare(edited.items.project.p1.hlc, seedHlc)).toBeGreaterThan(0)

        // same-ms variant: an edit in the exact same wall ms as the seed must not produce a tie
        const sameMs = detectLocalChanges({ items: seeded.items, current: { project: { p1: { name: "edited" } } }, deviceId: "A", nowMs: modified, lastHlc: seeded.lastHlc, seedMode: false })
        expect(hlcCompare(sameMs.items.project.p1.hlc, seedHlc)).toBeGreaterThan(0)
    })

    it("a locally deleted item becomes an explicit tombstone (never inferred remotely)", () => {
        const first = detectLocalChanges({ items: {}, current: { project: { p1: { name: "P" }, p2: { name: "Q" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const second = detectLocalChanges({ items: first.items, current: { project: { p1: { name: "P" } } }, deviceId: "A", nowMs: NOW + 1, lastHlc: first.lastHlc, seedMode: false })
        expect(second.items.project.p2.deleted).toBe(true)
        expect(second.items.project.p2.hash).toBeNull()
        expect(hlcCompare(second.items.project.p2.hlc, first.items.project.p2.hlc)).toBeGreaterThan(0)
    })

    it("wipe guard: a type dropping from many items to zero is NOT mass-tombstoned", () => {
        const items: ItemsState = {
            project: {
                p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "h1" },
                p2: { hlc: hlcFromParts(NOW, 1, "A"), hash: "h2" },
                p3: { hlc: hlcFromParts(NOW, 2, "A"), hash: "h3" }
            }
        }
        const result = detectLocalChanges({ items, current: { project: {} }, deviceId: "A", nowMs: NOW + 1, lastHlc: null, seedMode: false })
        expect(result.skippedWipeTypes).toEqual(["project"])
        expect(result.items.project.p1.deleted).toBeUndefined()
    })

    it("deleting the last one or two items is still a normal deletion (guard only trips on 3+)", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "h1" }, p2: { hlc: hlcFromParts(NOW, 1, "A"), hash: "h2" } } }
        const result = detectLocalChanges({ items, current: { project: {} }, deviceId: "A", nowMs: NOW + 1, lastHlc: null, seedMode: false })
        expect(result.skippedWipeTypes).toEqual([])
        expect(result.items.project.p1.deleted).toBe(true)
    })

    it("re-creating a tombstoned item revives it with a newer HLC", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: null, deleted: true } } }
        const result = detectLocalChanges({ items, current: { project: { p1: { name: "back" } } }, deviceId: "A", nowMs: NOW + 1, lastHlc: hlcFromParts(NOW, 0, "A"), seedMode: false })
        expect(result.items.project.p1.deleted).toBeUndefined()
        expect(hlcCompare(result.items.project.p1.hlc, hlcFromParts(NOW, 0, "A"))).toBeGreaterThan(0)
    })

    it("compacts tombstones older than the TTL", () => {
        const old = hlcFromParts(NOW - TOMBSTONE_TTL_MS - 1, 0, "A")
        const fresh = hlcFromParts(NOW - 1000, 0, "A")
        const items: ItemsState = { project: { gone: { hlc: old, hash: null, deleted: true }, recent: { hlc: fresh, hash: null, deleted: true } } }
        const result = detectLocalChanges({ items, current: { project: {} }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        expect(result.items.project.gone).toBeUndefined()
        expect(result.items.project.recent).toBeDefined()
    })

    it("noDeleteTypes: absence never tombstones (atomic settings / unparsable files), edits still sync", () => {
        const items: ItemsState = { "settings-atomic": { drawSettings: { hlc: hlcFromParts(NOW, 0, "A"), hash: payloadHash({ size: 1 }) } } }
        const result = detectLocalChanges({
            items,
            current: { "settings-atomic": { scriptureSettings: { versesPerSlide: 4 } } }, // drawSettings vanished
            deviceId: "A",
            nowMs: NOW + 1,
            lastHlc: hlcFromParts(NOW, 0, "A"),
            seedMode: false,
            noDeleteTypes: ["settings-atomic"]
        })
        expect(result.items["settings-atomic"].drawSettings.deleted).toBeUndefined() // NOT tombstoned
        expect(result.items["settings-atomic"].scriptureSettings.hash).toBe(payloadHash({ versesPerSlide: 4 })) // new item still tracked
        expect(result.skippedWipeTypes).toEqual([]) // suppression is not the wipe guard
    })

    it("noDeleteTypes only shields the listed types; others tombstone normally", () => {
        const items: ItemsState = {
            show: { s1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "h" } },
            project: { p1: { hlc: hlcFromParts(NOW, 1, "A"), hash: "h" } }
        }
        const result = detectLocalChanges({ items, current: { show: {}, project: {} }, deviceId: "A", nowMs: NOW + 1, lastHlc: null, seedMode: false, noDeleteTypes: ["show"] })
        expect(result.items.show.s1.deleted).toBeUndefined()
        expect(result.items.project.p1.deleted).toBe(true)
    })

    it("noDeleteTypes still compacts expired tombstones", () => {
        const items: ItemsState = { show: { gone: { hlc: hlcFromParts(NOW - TOMBSTONE_TTL_MS - 1, 0, "A"), hash: null, deleted: true } } }
        const result = detectLocalChanges({ items, current: { show: {} }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false, noDeleteTypes: ["show"] })
        expect(result.items.show.gone).toBeUndefined()
    })
})

// ----- pull planning -----

describe("engine — planPull", () => {
    it("fetches a remote item that is newer than the local one", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "old" } } }
        const remote = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), payloadHash: "new" })
        const plan = planPull(items, [journal("B", [remote])], "A")
        expect(plan.fetches).toEqual([{ type: "project", id: "p1", deviceId: "B", entry: remote }])
    })

    it("does nothing when the local version wins or is identical", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW + 5, 0, "A"), hash: "mine" } } }
        const plan = planPull(items, [journal("B", [entry({ id: "p1", hlc: hlcFromParts(NOW, 0, "B") })])], "A")
        expect(plan.fetches).toEqual([])
        expect(plan.deletes).toEqual([])
        expect(plan.adoptions).toEqual([])
    })

    it("adopts the remote version WITHOUT downloading when the content hash is identical", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "same" } } }
        const remote = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), payloadHash: "same" })
        const plan = planPull(items, [journal("B", [remote])], "A")
        expect(plan.fetches).toEqual([])
        expect(plan.adoptions).toEqual([{ type: "project", id: "p1", entry: remote }])
    })

    it("a remote tombstone deletes a live local item, and is only adopted when nothing exists", () => {
        const dead = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), deletedAt: hlcFromParts(NOW + 1, 0, "B"), payloadHash: null })
        const withLocal: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "x" } } }
        expect(planPull(withLocal, [journal("B", [dead])], "A").deletes).toHaveLength(1)
        expect(planPull({}, [journal("B", [dead])], "A").adoptions).toHaveLength(1)
    })

    it("a LOCAL tombstone newer than the remote copy wins (deletion is not resurrected)", () => {
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW + 5, 0, "A"), hash: null, deleted: true } } }
        const plan = planPull(items, [journal("B", [entry({ id: "p1", hlc: hlcFromParts(NOW, 0, "B") })])], "A")
        expect(plan.fetches).toEqual([])
    })

    it("skips (read-only) entries written by a newer schema instead of touching them", () => {
        const future = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), schema: SYNC_SCHEMA_VERSION + 1 })
        const plan = planPull({}, [journal("B", [future])], "A")
        expect(plan.fetches).toEqual([])
        expect(plan.skippedNewerSchema).toEqual([{ type: "project", id: "p1" }])
    })

    it("with several journals announcing the same item, fetches from the WINNER's namespace", () => {
        const older = entry({ id: "p1", hlc: hlcFromParts(NOW, 0, "B") })
        const newer = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "C") })
        const plan = planPull({}, [journal("B", [older]), journal("C", [newer])], "A")
        expect(plan.fetches).toEqual([{ type: "project", id: "p1", deviceId: "C", entry: newer }])
    })

    it("ignores its own journal and reports the max remote HLC observed", () => {
        const own = entry({ id: "p1", hlc: hlcFromParts(NOW + 9, 0, "A") })
        const other = entry({ id: "p2", hlc: hlcFromParts(NOW + 3, 0, "B") })
        const plan = planPull({}, [journal("A", [own]), journal("B", [other])], "A")
        expect(plan.fetches.map((fetch) => fetch.id)).toEqual(["p2"])
        expect(plan.maxRemoteHlc).toBe(other.hlc)
    })
})

// ----- fetched item validation -----

describe("engine — acceptFetchedEntity (stale S3 object guard)", () => {
    const announced = entry({ id: "p1", hlc: hlcFromParts(NOW + 5, 0, "B") })

    it("accepts an item matching or newer than its journal entry", () => {
        expect(acceptFetchedEntity(announced, entityOf(announced, { name: "P" }))).toBe(true)
        const newer = { ...entityOf(announced, { name: "P" }), hlc: hlcFromParts(NOW + 9, 0, "B") }
        expect(acceptFetchedEntity(announced, newer)).toBe(true)
    })

    it("rejects a stale item file older than announced (journal was uploaded, item not yet)", () => {
        const stale = { ...entityOf(announced, { name: "old" }), hlc: hlcFromParts(NOW, 0, "B") }
        expect(acceptFetchedEntity(announced, stale)).toBe(false)
    })

    it("rejects mismatched ids/types, tombstones, empty payloads and newer schemas", () => {
        expect(acceptFetchedEntity(announced, null)).toBe(false)
        expect(acceptFetchedEntity(announced, { ...entityOf(announced, { a: 1 }), id: "other" })).toBe(false)
        expect(acceptFetchedEntity(announced, { ...entityOf(announced, { a: 1 }), deletedAt: announced.hlc })).toBe(false)
        expect(acceptFetchedEntity(announced, { ...entityOf(announced, { a: 1 }), payload: null })).toBe(false)
        expect(acceptFetchedEntity(announced, { ...entityOf(announced, { a: 1 }), schema: SYNC_SCHEMA_VERSION + 1 })).toBe(false)
    })
})

// ----- applying pulled data -----

describe("engine — applyPull", () => {
    it("applies fetched payloads to state and store changes (hash recomputed locally)", () => {
        const remote = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), payloadHash: "whatever-was-announced" })
        const result = applyPull({ items: {}, fetched: [{ entry: remote, entity: entityOf(remote, { name: "P" }) }], deletes: [], adoptions: [] })
        expect(result.storeChanges.project.p1).toEqual({ name: "P" })
        expect(result.items.project.p1).toEqual({ hlc: remote.hlc, hash: payloadHash({ name: "P" }) })
    })

    it("applies remote deletions as null store changes + tombstone state", () => {
        const dead = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), deletedAt: hlcFromParts(NOW + 1, 0, "B"), payloadHash: null })
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "x" } } }
        const result = applyPull({ items, fetched: [], deletes: [{ type: "project", id: "p1", entry: dead }], adoptions: [] })
        expect(result.storeChanges.project.p1).toBeNull()
        expect(result.items.project.p1.deleted).toBe(true)
    })

    it("adoptions update only the version, never the store", () => {
        const remote = entry({ id: "p1", hlc: hlcFromParts(NOW + 1, 0, "B"), payloadHash: "same" })
        const items: ItemsState = { project: { p1: { hlc: hlcFromParts(NOW, 0, "A"), hash: "same" } } }
        const result = applyPull({ items, fetched: [], deletes: [], adoptions: [{ type: "project", id: "p1", entry: remote }] })
        expect(result.storeChanges.project).toBeUndefined()
        expect(result.items.project.p1.hlc).toBe(remote.hlc)
        expect(result.items.project.p1.hash).toBe("same")
    })
})

// ----- push planning -----

describe("engine — buildPush", () => {
    it("publishes only self-authored winners; items superseded by another device drop out (own-namespace compaction)", () => {
        const items: ItemsState = {
            project: {
                mine: { hlc: hlcFromParts(NOW, 0, "A"), hash: "h1", pushedHash: "h1" },
                theirs: { hlc: hlcFromParts(NOW, 0, "B"), hash: "h2" } // remote-authored winner
            }
        }
        const push = buildPush(items, "A", { nowMs: NOW })
        expect(push.journal.entries.map((journalEntry) => journalEntry.id)).toEqual(["mine"])
    })

    it("uploads only items whose current hash was never pushed", () => {
        const items: ItemsState = {
            project: {
                pushed: { hlc: hlcFromParts(NOW, 0, "A"), hash: "h1", pushedHash: "h1" },
                dirty: { hlc: hlcFromParts(NOW, 1, "A"), hash: "h2", pushedHash: "h1" },
                fresh: { hlc: hlcFromParts(NOW, 2, "A"), hash: "h3" }
            }
        }
        const push = buildPush(items, "A", { nowMs: NOW })
        expect(push.uploads.map((upload) => upload.id).sort()).toEqual(["dirty", "fresh"])
    })

    it("tombstones travel in the journal only (no item file upload)", () => {
        const items: ItemsState = { project: { dead: { hlc: hlcFromParts(NOW, 0, "A"), hash: null, deleted: true } } }
        const push = buildPush(items, "A", { nowMs: NOW })
        expect(push.uploads).toEqual([])
        expect(push.journal.entries[0]).toMatchObject({ id: "dead", deletedAt: hlcFromParts(NOW, 0, "A"), payloadHash: null })
    })

    it("buildEntity mirrors the item state", () => {
        const state = { hlc: hlcFromParts(NOW, 0, "A"), hash: "h" }
        expect(buildEntity("project", "p1", state, { name: "P" })).toEqual({ id: "p1", type: "project", schema: SYNC_SCHEMA_VERSION, hlc: state.hlc, deletedAt: null, payloadHash: "h", payload: { name: "P" } })
    })
})

// ----- end-to-end merge scenarios (regressions for the v1 failure modes) -----

describe("engine — scenarios (v1 loss cases are structurally impossible)", () => {
    it("#3335-style: two devices with different items each keep BOTH (union, no whole-file overwrite)", () => {
        // A (rich) has 'eng'; B (poor, but newer save) has 'zz'. In v1, B's newer file wiped 'eng'.
        const a = detectLocalChanges({ items: {}, current: { "settings-scriptures": { rv: { name: "RV" }, eng: { name: "KJ" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const b = detectLocalChanges({ items: {}, current: { "settings-scriptures": { rv: { name: "RV" }, zz: { name: "B's" } } }, deviceId: "B", nowMs: NOW + 5000, lastHlc: null, seedMode: false })

        const pushA = buildPush(a.items, "A", { nowMs: NOW })
        // B pulls A's journal: it must fetch 'eng' and must NOT touch its own 'zz'
        const plan = planPull(b.items, [pushA.journal], "B")
        expect(plan.fetches.map((fetch) => fetch.id).sort()).toEqual(["eng"])
        expect(plan.deletes).toEqual([])

        const engEntry = plan.fetches[0].entry
        const applied = applyPull({ items: b.items, fetched: [{ entry: engEntry, entity: entityOf(engEntry, { name: "KJ" }) }], deletes: [], adoptions: plan.adoptions })
        expect(Object.keys({ ...applied.items["settings-scriptures"] }).sort()).toEqual(["eng", "rv", "zz"]) // full union
    })

    it("same 'rv' on both sides with identical content converges by adoption, no download", () => {
        const a = detectLocalChanges({ items: {}, current: { "settings-scriptures": { rv: { name: "RV" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const b = detectLocalChanges({ items: {}, current: { "settings-scriptures": { rv: { name: "RV" } } }, deviceId: "B", nowMs: NOW + 1, lastHlc: null, seedMode: false })
        const plan = planPull(a.items, [buildPush(b.items, "B", { nowMs: NOW }).journal], "A")
        expect(plan.fetches).toEqual([])
        expect(plan.adoptions.map((adoption) => adoption.id)).toEqual(["rv"])
    })

    it("concurrent edits of the SAME item: one deterministic winner, loser stays recoverable in its namespace", () => {
        const base = detectLocalChanges({ items: {}, current: { project: { p1: { name: "base" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })

        // both edit offline: A at NOW+1, B (starting from the same state) at NOW+2
        const editedA = detectLocalChanges({ items: base.items, current: { project: { p1: { name: "A's" } } }, deviceId: "A", nowMs: NOW + 1, lastHlc: base.lastHlc, seedMode: false })
        const editedB = detectLocalChanges({ items: base.items, current: { project: { p1: { name: "B's" } } }, deviceId: "B", nowMs: NOW + 2, lastHlc: base.lastHlc, seedMode: false })

        // A pulls B's journal → B wins (higher HLC), deterministically
        const planA = planPull(editedA.items, [buildPush(editedB.items, "B", { nowMs: NOW + 2 }).journal], "A")
        expect(planA.fetches.map((fetch) => fetch.id)).toEqual(["p1"])

        // after adopting B's version, A's own journal no longer claims p1 — but A's OLD item file
        // still physically exists in A's namespace (recoverable, loss is never silent+permanent)
        const applied = applyPull({ items: editedA.items, fetched: [{ entry: planA.fetches[0].entry, entity: entityOf(planA.fetches[0].entry, { name: "B's" }) }], deletes: [], adoptions: [] })
        expect(buildPush(applied.items, "A", { nowMs: NOW + 3 }).journal.entries).toEqual([])
    })

    it("offline device re-syncing later cannot delete anything by absence (no ledger, no marks — nothing purged)", () => {
        // B has never seen 'newItem' (created by A while B was offline); B's journal simply doesn't mention it
        const a = detectLocalChanges({ items: {}, current: { project: { newItem: { name: "new" } } }, deviceId: "A", nowMs: NOW, lastHlc: null, seedMode: false })
        const planForA = planPull(a.items, [journal("B", [])], "A")
        expect(planForA.deletes).toEqual([]) // absence in B's journal deletes NOTHING
        expect(planForA.fetches).toEqual([])
    })
})
