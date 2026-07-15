// Regression tests for the sync v2 orchestrator (syncDataV2). Only the I/O boundaries are
// mocked (electron-store writes, network provider, state file persistence); the merge logic
// (engine/entity/registry/adapters) runs for real.
//
// Critical regression covered: a FAILED local store write must never mark pulled items as
// applied — otherwise the next sync would read their absence from the store as a local
// deletion and propagate a tombstone (team-wide delete of an item nobody deleted).

import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { payloadHash, type DeviceJournal, type SyncEntity } from "./entity"
import { hlcFromParts } from "./hlc"
import { itemFileName, journalFileName, registryFileName } from "./naming"

const mocks = vi.hoisted(() => ({
    _store: {} as any,
    safeStoreSet: vi.fn(),
    sendMain: vi.fn(),
    loadState: vi.fn(),
    saveState: vi.fn(),
    getChurchAppsSyncManager: vi.fn(),
    getDataFolderPath: vi.fn(),
    loadShows: vi.fn()
}))

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0-test" } }))
vi.mock("../../data/store", () => ({ _store: mocks._store, getStore: () => ({}), safeStoreSet: mocks.safeStoreSet }))
vi.mock("../../IPC/main", () => ({ sendMain: mocks.sendMain }))
vi.mock("../../utils/helpers", () => ({ clone: (value: any) => JSON.parse(JSON.stringify(value)), getMachineId: () => "devA" }))
vi.mock("../../utils/files", () => ({ getDataFolderPath: mocks.getDataFolderPath, loadShows: mocks.loadShows }))
vi.mock("../ChurchAppsSyncManager", () => ({ getChurchAppsSyncManager: mocks.getChurchAppsSyncManager }))
vi.mock("./state", () => ({ loadState: mocks.loadState, saveState: mocks.saveState }))

import { syncDataV2 } from "./syncV2Manager"

const SYNC_ARGS = { id: "churchApps" as const, churchId: "church1", teamId: "team1", method: "merge" as const }

// remote device B announces one live project "p1"
const PAYLOAD = { name: "From B" }
const HLC_B = hlcFromParts(Date.now() - 60000, 0, "devB")
const JOURNAL_B: DeviceJournal = { version: 1, deviceId: "devB", writtenAt: 1, entries: [{ id: "p1", type: "project", schema: 1, hlc: HLC_B, deletedAt: null, payloadHash: payloadHash(PAYLOAD) }] }
const ENTITY_P1: SyncEntity = { id: "p1", type: "project", schema: 1, hlc: HLC_B, deletedAt: null, payloadHash: payloadHash(PAYLOAD), payload: PAYLOAD }

let persistedState: any
let uploadJsonFile: ReturnType<typeof vi.fn>
let tempRoot: string
let showsFolder: string
let biblesFolder: string

function uploadedJournals(): DeviceJournal[] {
    return uploadJsonFile.mock.calls.filter(([, fileName]) => fileName === journalFileName("devA")).map(([, , content]) => JSON.parse(content as string))
}

beforeEach(() => {
    vi.clearAllMocks()

    // real (temp) folders for the file-backed collections — the disk layer runs for real
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-sync-v2-mgr-"))
    showsFolder = path.join(tempRoot, "Shows")
    biblesFolder = path.join(tempRoot, "Bibles")
    fs.mkdirSync(showsFolder)
    fs.mkdirSync(biblesFolder)
    mocks.getDataFolderPath.mockImplementation((id: string) => (id === "shows" ? showsFolder : id === "scriptures" ? biblesFolder : path.join(tempRoot, id)))

    // device A: fresh post-migration state, empty local stores
    persistedState = { version: 1, deviceId: "devA", lastHlc: null, migratedAt: 1, seededTypes: [], registry: null, items: {}, lastJournalHash: null }
    mocks.loadState.mockImplementation(async () => JSON.parse(JSON.stringify(persistedState)))
    mocks.saveState.mockImplementation(async (_id: string, _church: string, _team: string, state: any) => {
        persistedState = JSON.parse(JSON.stringify(state))
    })

    mocks._store.PROJECTS = { store: { projects: {}, folders: {}, projectTemplates: {} } }
    mocks._store.SYNCED_SETTINGS = { store: {} }
    mocks._store.SHOWS = { store: {} }
    mocks.safeStoreSet.mockImplementation(async (store: any, newData: any) => {
        store.store = newData
        return true
    })

    // registry already lists both devices with a fresh lastSeenAt (no registry upload this run)
    const registry = {
        version: 1,
        devices: [
            { deviceId: "devA", addedAt: 1, lastSeenAt: Date.now() },
            { deviceId: "devB", addedAt: 1, lastSeenAt: Date.now() }
        ]
    }

    uploadJsonFile = vi.fn(async () => true)
    mocks.getChurchAppsSyncManager.mockReturnValue({
        getJsonFile: vi.fn(async (_church: string, _team: string, fileName: string) => {
            if (fileName === registryFileName()) return { status: "ok", data: registry }
            if (fileName === journalFileName("devB")) return { status: "ok", data: JOURNAL_B }
            if (fileName === itemFileName("devB", "project", "p1")) return { status: "ok", data: ENTITY_P1 }
            return { status: "not_found" }
        }),
        uploadJsonFile
    })
})

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
})

// point remote device B's journal at a single arbitrary entity instead of the default project
function remoteAnnounces(type: string, id: string, payload: unknown) {
    const hlc = hlcFromParts(Date.now() - 60000, 1, "devB")
    const journal: DeviceJournal = { version: 1, deviceId: "devB", writtenAt: 1, entries: [{ id, type, schema: 1, hlc, deletedAt: null, payloadHash: payloadHash(payload) }] }
    const entity: SyncEntity = { id, type, schema: 1, hlc, deletedAt: null, payloadHash: payloadHash(payload), payload }

    const registry = {
        version: 1,
        devices: [
            { deviceId: "devA", addedAt: 1, lastSeenAt: Date.now() },
            { deviceId: "devB", addedAt: 1, lastSeenAt: Date.now() }
        ]
    }
    mocks.getChurchAppsSyncManager.mockReturnValue({
        getJsonFile: vi.fn(async (_church: string, _team: string, fileName: string) => {
            if (fileName === registryFileName()) return { status: "ok", data: registry }
            if (fileName === journalFileName("devB")) return { status: "ok", data: journal }
            if (fileName === itemFileName("devB", type, id)) return { status: "ok", data: entity }
            return { status: "not_found" }
        }),
        uploadJsonFile
    })
}

describe("syncDataV2 — store write failures (critical: no phantom tombstones)", () => {
    it("baseline: a pulled item is applied to the store and marked as applied in the state", async () => {
        const result = await syncDataV2(SYNC_ARGS)

        expect(result.success).toBe(true)
        expect(mocks._store.PROJECTS.store.projects.p1).toEqual(PAYLOAD)
        expect(persistedState.items.project.p1).toMatchObject({ hlc: HLC_B, hash: payloadHash(PAYLOAD) })
        expect(mocks.sendMain).toHaveBeenCalled()
    })

    it("a FAILED store write does not mark the pulled item as applied, and the next sync never tombstones it", async () => {
        mocks.safeStoreSet.mockResolvedValue(false) // e.g. EPERM on a read-only file: store keeps its old data

        const first = await syncDataV2(SYNC_ARGS)
        expect(first.success).toBe(false)
        // store and state must stay CONSISTENT: item neither in the store nor marked applied
        expect(mocks._store.PROJECTS.store.projects.p1).toBeUndefined()
        expect(persistedState.items.project?.p1).toBeUndefined()

        // next sync still can't write. Before the fix, the state said "p1 is live" while the
        // store didn't have it → detected as a local deletion → a devA-authored tombstone was
        // pushed and deleted p1 for the WHOLE team. No uploaded journal may contain that.
        await syncDataV2(SYNC_ARGS)
        const journals = uploadedJournals()
        for (const journal of journals) {
            expect(journal.entries.filter((entry) => entry.id === "p1" && entry.deletedAt)).toEqual([])
        }
        expect(persistedState.items.project?.p1?.deleted).toBeUndefined()
    })

    it("recovers after a failed write: the next sync re-applies the same pull", async () => {
        mocks.safeStoreSet.mockResolvedValueOnce(false) // fails once, then works again

        await syncDataV2(SYNC_ARGS)
        expect(mocks._store.PROJECTS.store.projects.p1).toBeUndefined()

        const second = await syncDataV2(SYNC_ARGS)
        expect(second.success).toBe(true)
        expect(mocks._store.PROJECTS.store.projects.p1).toEqual(PAYLOAD)
        expect(persistedState.items.project.p1).toMatchObject({ hlc: HLC_B, hash: payloadHash(PAYLOAD) })
    })
})

describe("syncDataV2 — file-backed collections (shows / bibles)", () => {
    it("a pulled show is written to Shows/<name>.show as [id, value] and the caches refresh", async () => {
        const payload = { name: "Song B", slides: {}, timestamps: { modified: 5 } }
        remoteAnnounces("show", "s1", payload)

        const result = await syncDataV2(SYNC_ARGS)

        expect(result.success).toBe(true)
        const written = JSON.parse(fs.readFileSync(path.join(showsFolder, "Song B.show"), "utf8"))
        expect(written).toEqual(["s1", payload])
        expect(persistedState.items.show.s1).toMatchObject({ hash: payloadHash(payload) })
        expect(mocks.loadShows).toHaveBeenCalledWith(false, ["Song B"])
        expect(result.changedFiles).toContain("SHOWS")
    })

    it("a pulled bible is written to Bibles/<name>.fsb (real content, no more ghost bibles)", async () => {
        const payload = { name: "RV1960", books: [{ chapters: [] }] }
        remoteAnnounces("bible", "b1", payload)

        const result = await syncDataV2(SYNC_ARGS)

        expect(result.success).toBe(true)
        expect(JSON.parse(fs.readFileSync(path.join(biblesFolder, "RV1960.fsb"), "utf8"))).toEqual(["b1", payload])
        expect(persistedState.items.bible.b1).toMatchObject({ hash: payloadHash(payload) })
    })

    it("a local show seeds/pushes by its immutable ID, and a file rename keeps that id (fixes v1 BUG-6)", async () => {
        fs.writeFileSync(path.join(showsFolder, "Original.show"), JSON.stringify(["s9", { name: "Original", slides: {}, timestamps: { modified: 7 } }]))

        await syncDataV2(SYNC_ARGS)
        const first = uploadedJournals().at(-1)!
        const firstEntry = first.entries.find((entry) => entry.type === "show")!
        expect(firstEntry.id).toBe("s9")
        expect(firstEntry.deletedAt).toBeNull()

        // the user renames the FILE only (FreeShow may not rewrite the content on rename)
        fs.renameSync(path.join(showsFolder, "Original.show"), path.join(showsFolder, "Renamed.show"))

        await syncDataV2(SYNC_ARGS)
        const second = uploadedJournals().at(-1)!
        const entries = second.entries.filter((entry) => entry.type === "show")
        expect(entries).toHaveLength(1)
        expect(entries[0].id).toBe("s9") // same identity: full history preserved
        expect(entries[0].deletedAt).toBeNull() // and NOT a delete+create
        expect(entries[0].payloadHash).not.toBe(firstEntry.payloadHash) // the rename itself syncs
    })

    it("an UNREADABLE shows folder never fabricates data: pull is retried, nothing marked applied", async () => {
        const payload = { name: "Song B", slides: {} }
        remoteAnnounces("show", "s1", payload)
        mocks.getDataFolderPath.mockImplementation((id: string) => {
            if (id === "shows") return path.join(tempRoot, "not-a-folder") // a FILE blocks the folder
            return id === "scriptures" ? biblesFolder : path.join(tempRoot, id)
        })
        fs.writeFileSync(path.join(tempRoot, "not-a-folder"), "x")

        const first = await syncDataV2(SYNC_ARGS)
        expect(first.success).toBe(false)
        expect(persistedState.items.show?.s1).toBeUndefined() // not marked applied
        expect(persistedState.seededTypes).not.toContain("show") // must still seed for real later

        // no uploaded journal may tombstone the show we never applied
        for (const journal of uploadedJournals()) {
            expect(journal.entries.filter((entry) => entry.type === "show")).toEqual([])
        }

        // the folder is fixed → the same pull is re-applied
        fs.rmSync(path.join(tempRoot, "not-a-folder"))
        mocks.getDataFolderPath.mockImplementation((id: string) => (id === "shows" ? showsFolder : id === "scriptures" ? biblesFolder : path.join(tempRoot, id)))
        const second = await syncDataV2(SYNC_ARGS)
        expect(second.success).toBe(true)
        expect(fs.existsSync(path.join(showsFolder, "Song B.show"))).toBe(true)
    })

    it("an unparsable .show file suppresses show deletions this run (its id could live there)", async () => {
        // devA's state believes s2 is live, but the only file on disk is unreadable
        const hlc = hlcFromParts(Date.now() - 5000, 0, "devA")
        persistedState.items = { show: { s2: { hlc, hash: "h2", pushedHash: "h2" } } }
        persistedState.seededTypes = ["show"]
        fs.writeFileSync(path.join(showsFolder, "broken.show"), "{ definitely not json")

        await syncDataV2(SYNC_ARGS)

        expect(persistedState.items.show.s2.deleted).toBeUndefined()
        for (const journal of uploadedJournals()) {
            expect(journal.entries.filter((entry) => entry.id === "s2" && entry.deletedAt)).toEqual([])
        }
    })

    it("a genuinely deleted show file becomes an explicit tombstone", async () => {
        const hlc = hlcFromParts(Date.now() - 5000, 0, "devA")
        persistedState.items = { show: { s2: { hlc, hash: "h2", pushedHash: "h2" } } }
        persistedState.seededTypes = ["show"]
        // shows folder is empty and perfectly readable → s2 was deleted locally (1 item: no wipe guard)

        await syncDataV2(SYNC_ARGS)

        expect(persistedState.items.show.s2.deleted).toBe(true)
        const journal = uploadedJournals().at(-1)!
        expect(journal.entries.find((entry) => entry.id === "s2")?.deletedAt).toBeTruthy()
    })
})

describe("syncDataV2 — atomic settings and new store types", () => {
    it("a pulled atomic setting lands on its SYNCED_SETTINGS key (newest HLC wins wholesale)", async () => {
        mocks._store.SYNCED_SETTINGS = { store: { drawSettings: { size: 1 }, scriptures: { kjv: { name: "KJV" } } } }
        remoteAnnounces("settings-atomic", "drawSettings", { size: 99 })

        const result = await syncDataV2(SYNC_ARGS)

        expect(result.success).toBe(true)
        expect(mocks._store.SYNCED_SETTINGS.store.drawSettings).toEqual({ size: 99 })
        expect(mocks._store.SYNCED_SETTINGS.store.scriptures).toEqual({ kjv: { name: "KJV" } }) // untouched
    })

    it("local atomic settings are announced but their absence is never a deletion", async () => {
        mocks._store.SYNCED_SETTINGS = { store: { drawSettings: { size: 4 } } }

        await syncDataV2(SYNC_ARGS)
        const journal = uploadedJournals().at(-1)!
        expect(journal.entries.find((entry) => entry.type === "settings-atomic" && entry.id === "drawSettings")).toBeTruthy()

        // the key vanishes locally (e.g. older app version) → no tombstone may be pushed
        mocks._store.SYNCED_SETTINGS = { store: {} }
        await syncDataV2(SYNC_ARGS)
        for (const uploaded of uploadedJournals()) {
            expect(uploaded.entries.filter((entry) => entry.id === "drawSettings" && entry.deletedAt)).toEqual([])
        }
    })

    it("a pulled overlay lands in the OVERLAYS store root", async () => {
        mocks._store.OVERLAYS = { store: {} }
        remoteAnnounces("overlay", "o1", { name: "Lower third" })

        const result = await syncDataV2(SYNC_ARGS)

        expect(result.success).toBe(true)
        expect(mocks._store.OVERLAYS.store.o1).toEqual({ name: "Lower third" })
        delete mocks._store.OVERLAYS
    })
})

describe("syncDataV2 — unknown entity types (mixed-fleet rollout)", () => {
    it("entities of a type this build has no adapter for are ignored, never marked applied", async () => {
        remoteAnnounces("future-widget", "w1", { name: "from a newer build" })

        const result = await syncDataV2(SYNC_ARGS)
        expect(result.success).toBe(true)
        // NOT phantom-applied: once this device gets the adapter, w1 must arrive as a normal
        // pull instead of being read as "present in state but missing locally" (= tombstone)
        expect(persistedState.items["future-widget"]).toBeUndefined()

        await syncDataV2(SYNC_ARGS)
        for (const journal of uploadedJournals()) {
            expect(journal.entries.filter((entry) => entry.type === "future-widget")).toEqual([])
        }
    })
})
