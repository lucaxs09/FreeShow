import { describe, expect, it } from "vitest"
import { SYNCED_SETTINGS_COLLECTIONS } from "../syncLedger"
import { applyPayloadChanges, extractPayloads, getAdapterByType, getSyncV2Adapters, WHOLE_STORE_ID, type StoreAdapter } from "./adapters"

const storeAdapter = (type: string) => getAdapterByType(type) as StoreAdapter

describe("adapters — registry", () => {
    it("covers the three PROJECTS sections and every SYNCED_SETTINGS item-collection", () => {
        const adapters = getSyncV2Adapters()
        const projectSections = adapters.filter((adapter) => adapter.kind === "store" && adapter.storeId === "PROJECTS").map((adapter) => (adapter as StoreAdapter).section)
        expect(projectSections.sort()).toEqual(["folders", "projectTemplates", "projects"])

        const settingsSections = adapters.filter((adapter) => adapter.kind === "store" && adapter.storeId === "SYNCED_SETTINGS").map((adapter) => (adapter as StoreAdapter).section)
        expect(settingsSections.sort()).toEqual([...SYNCED_SETTINGS_COLLECTIONS, null].sort()) // null = the atomic-keys adapter
    })

    it("covers everything else v1 syncs: flat stores, MEDIA, shows and bibles", () => {
        const adapters = getSyncV2Adapters()
        const flatStores = adapters.filter((adapter) => adapter.kind === "store" && adapter.section === null && !adapter.wholeStore && adapter.storeId !== "SYNCED_SETTINGS").map((adapter) => (adapter as StoreAdapter).storeId)
        expect(flatStores.sort()).toEqual(["EVENTS", "OVERLAYS", "STAGE", "TEMPLATES", "THEMES"])

        expect(storeAdapter("store-media")).toMatchObject({ storeId: "MEDIA", wholeStore: true, noDelete: true })

        const fileAdapters = adapters.filter((adapter) => adapter.kind === "files")
        expect(fileAdapters.map((adapter) => (adapter.kind === "files" ? [adapter.type, adapter.folder, adapter.extension] : null))).toEqual([
            ["show", "shows", ".show"],
            ["bible", "scriptures", ".fsb"]
        ])
    })

    it("entity types are flat-file-name friendly and unique", () => {
        const types = getSyncV2Adapters().map((adapter) => adapter.type)
        expect(new Set(types).size).toBe(types.length)
        for (const type of types) expect(type).toMatch(/^[a-zA-Z0-9-]+$/)
    })
})

describe("adapters — extractPayloads", () => {
    const projects = storeAdapter("project")

    it("extracts the id → payload map of its section only", () => {
        const store = { projects: { p1: { name: "P" } }, folders: { f1: { name: "F" } } }
        expect(extractPayloads(projects, store)).toEqual({ p1: { name: "P" } })
    })

    it("skips legacy 'deleted: true' cloud flags and null entries", () => {
        const store = { projects: { p1: { name: "P" }, p2: { name: "old", deleted: true }, p3: null } }
        expect(Object.keys(extractPayloads(projects, store))).toEqual(["p1"])
    })

    it("tolerates missing/garbage sections", () => {
        expect(extractPayloads(projects, undefined)).toEqual({})
        expect(extractPayloads(projects, { projects: "junk" })).toEqual({})
        expect(extractPayloads(projects, { projects: [1, 2] })).toEqual({})
    })

    it("seedWallMs picks the item's own timestamps for migration", () => {
        expect(projects.seedWallMs({ modified: 123 })).toBe(123)
        expect(projects.seedWallMs({ created: 55 })).toBe(55)
        expect(storeAdapter("settings-scriptures").seedWallMs({ timestamps: { modified: 77 } })).toBe(77)
        expect(projects.seedWallMs({ name: "no dates" })).toBe(0)
        expect(projects.seedWallMs(null)).toBe(0)
    })

    it("root-level stores (section null) treat the whole store as the collection", () => {
        const overlays = storeAdapter("overlay")
        expect(extractPayloads(overlays, { o1: { name: "Lower third" }, o2: null })).toEqual({ o1: { name: "Lower third" } })
        expect(extractPayloads(overlays, undefined)).toEqual({})
    })

    it("the atomic-settings adapter only sees NON-collection keys", () => {
        const atomic = storeAdapter("settings-atomic")
        const store = { drawSettings: { size: 10 }, scriptureSettings: { versesPerSlide: 3 }, scriptures: { kjv: { name: "KJV" } }, categories: { song: {} } }
        expect(extractPayloads(atomic, store)).toEqual({ drawSettings: { size: 10 }, scriptureSettings: { versesPerSlide: 3 } })
        expect(atomic.noDelete).toBe(true) // absence must never tombstone (defaults re-fill these keys)
    })

    it("whole-store (MEDIA): one entity for the full store, an empty store is never announced", () => {
        const media = storeAdapter("store-media")
        const store = { "/a.mp4": { rating: 5, modified: 100 }, "/b.mp4": { modified: 300 } }
        expect(extractPayloads(media, store)).toEqual({ [WHOLE_STORE_ID]: store })
        expect(extractPayloads(media, {})).toEqual({}) // a migration tie may never replace a populated peer with {}
        expect(extractPayloads(media, undefined)).toEqual({})
        expect(media.seedWallMs(store)).toBe(300) // most recently touched item decides the seed tie
    })
})

describe("adapters — applyPayloadChanges", () => {
    const scriptures = storeAdapter("settings-scriptures")

    it("creates, replaces and deletes items in its section", () => {
        const store: any = { scriptures: { rv: { name: "RV" }, dead: { name: "bye" } }, drawSettings: { keep: true } }
        const result = applyPayloadChanges(scriptures, store, { eng: { name: "KJ" }, rv: { name: "RV60" }, dead: null })
        expect(result.scriptures).toEqual({ rv: { name: "RV60" }, eng: { name: "KJ" } })
        expect(result.drawSettings).toEqual({ keep: true }) // untouched siblings
    })

    it("initializes a missing section", () => {
        const result = applyPayloadChanges(scriptures, {}, { eng: { name: "KJ" } })
        expect(result.scriptures).toEqual({ eng: { name: "KJ" } })
    })

    it("root-level stores apply directly at the root", () => {
        const overlays = storeAdapter("overlay")
        const result = applyPayloadChanges(overlays, { o1: { name: "old" }, o2: { name: "bye" } }, { o1: { name: "new" }, o2: null, o3: { name: "created" } })
        expect(result).toEqual({ o1: { name: "new" }, o3: { name: "created" } })
    })

    it("the atomic-settings adapter can NEVER write into a collection key (forged entity id)", () => {
        const atomic = storeAdapter("settings-atomic")
        const store: any = { scriptures: { kjv: { name: "KJV" } }, drawSettings: {} }
        const result = applyPayloadChanges(atomic, store, { scriptures: { evil: true }, drawSettings: { size: 12 } })
        expect(result.scriptures).toEqual({ kjv: { name: "KJV" } }) // untouched
        expect(result.drawSettings).toEqual({ size: 12 })
    })

    it("whole-store replaces the entire store, but never with a tombstone or garbage", () => {
        const media = storeAdapter("store-media")
        const local = { "/old.mp4": { rating: 1 } }
        expect(applyPayloadChanges(media, local, { [WHOLE_STORE_ID]: { "/new.mp4": { rating: 5 } } })).toEqual({ "/new.mp4": { rating: 5 } })
        expect(applyPayloadChanges(media, local, { [WHOLE_STORE_ID]: null })).toBe(local) // fail towards keeping data
        expect(applyPayloadChanges(media, local, { [WHOLE_STORE_ID]: "junk" })).toBe(local)
        expect(applyPayloadChanges(media, local, {})).toBe(local)
    })
})
