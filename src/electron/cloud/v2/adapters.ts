// ----- FreeShow -----
// Sync v2: resource adapters (pure — no I/O, no Electron).
//
// An adapter maps one synced FreeShow resource to a v2 entity type. Three shapes exist:
//   "store" collections  → a keyed map ({ [id]: item }) inside (or at the root of) a JSON store:
//                          PROJECTS sections, SYNCED_SETTINGS item-collections, OVERLAYS, STAGE,
//                          TEMPLATES, THEMES, EVENTS, plus the atomic SYNCED_SETTINGS keys
//                          (each key = one entity, newest HLC wins, never tombstoned).
//   "store" whole-store  → the entire store as ONE entity (MEDIA): matches v1's newest-file-wins
//                          semantics without per-item tombstone hazards for path-keyed data.
//   "files" collections  → a folder of individual JSON files ([id, value]): Shows/*.show and
//                          Bibles/*.fsb. Tracked by the item's immutable id (NOT the file name,
//                          which fixes v1's rename-loses-history bug), see fileCollections.ts.
// Existing ids are reused as entity ids, so the v1 → v2 migration is idempotent by key.
// Adding a new synced resource = adding one adapter entry; the engine never changes.

import { SYNCED_SETTINGS_COLLECTIONS } from "../syncLedger"

export type SyncV2StoreId = "PROJECTS" | "SYNCED_SETTINGS" | "OVERLAYS" | "STAGE" | "TEMPLATES" | "THEMES" | "EVENTS" | "MEDIA"

// entity id used by whole-store adapters (a single SyncEntity carries the full store)
export const WHOLE_STORE_ID = "store"

interface AdapterBase {
    type: string // v2 entity type ([a-zA-Z0-9-] so it stays readable in flat file names)
    // best local timestamp for migration seeding (0 when unknown)
    seedWallMs: (payload: unknown) => number
    // payloads to leave out of sync entirely (e.g. legacy cloud "deleted" flags)
    skip?: (payload: unknown) => boolean
    // local absence must never tombstone (atomic settings: defaults always re-fill them)
    noDelete?: boolean
}

export interface StoreAdapter extends AdapterBase {
    kind: "store"
    storeId: SyncV2StoreId
    // key of the collection object inside the store data; null = the store root IS the collection
    section: string | null
    // sync the whole store as a single entity (id = WHOLE_STORE_ID) instead of per-item
    wholeStore?: boolean
    // only keys passing this filter belong to this adapter (extract AND apply — a remote entity
    // can never write outside its adapter's key space)
    includeKey?: (key: string) => boolean
}

export interface FileAdapter extends AdapterBase {
    kind: "files"
    folder: "shows" | "scriptures" // data folder holding one JSON file per item
    extension: string // ".show" / ".fsb" (matched case-insensitively)
}

export type SyncV2Adapter = StoreAdapter | FileAdapter

function defaultSeedWallMs(payload: unknown): number {
    const data = payload as any
    if (!data || typeof data !== "object") return 0
    const candidates = [data.modified, data.timestamps?.modified, data.timestamps?.created, data.created]
    for (const value of candidates) {
        if (typeof value === "number" && value > 0) return value
    }
    return 0
}

// whole-store seeding: the most recently touched item decides which store wins the migration tie
// (approximates v1's newest-file-wins without trusting the file system clock)
function maxItemSeedWallMs(payload: unknown): number {
    if (!payload || typeof payload !== "object") return 0
    let max = 0
    for (const value of Object.values(payload as Record<string, unknown>)) max = Math.max(max, defaultSeedWallMs(value))
    return max
}

// items carrying a legacy "deleted: true" flag from the old cloud sync are treated as gone
function skipLegacyDeleted(payload: unknown): boolean {
    return !!(payload as any)?.deleted
}

// an empty store must not be announced: at migration a tie could otherwise replace a populated
// peer store with {} (deviceId tiebreak). Absence is safe — whole-store types never tombstone.
function skipEmptyStore(payload: unknown): boolean {
    return !payload || typeof payload !== "object" || Object.keys(payload as object).length === 0
}

function flatCollection(type: string, storeId: SyncV2StoreId, skip?: (payload: unknown) => boolean): StoreAdapter {
    return { kind: "store", type, storeId, section: null, seedWallMs: defaultSeedWallMs, skip }
}

let adapters: SyncV2Adapter[] | null = null
export function getSyncV2Adapters(): SyncV2Adapter[] {
    if (adapters) return adapters

    adapters = [
        { kind: "store", type: "project", storeId: "PROJECTS", section: "projects", seedWallMs: defaultSeedWallMs, skip: skipLegacyDeleted },
        { kind: "store", type: "project-folder", storeId: "PROJECTS", section: "folders", seedWallMs: defaultSeedWallMs, skip: skipLegacyDeleted },
        { kind: "store", type: "project-template", storeId: "PROJECTS", section: "projectTemplates", seedWallMs: defaultSeedWallMs, skip: skipLegacyDeleted },
        ...SYNCED_SETTINGS_COLLECTIONS.map(
            (section): StoreAdapter => ({
                kind: "store",
                type: `settings-${section}`,
                storeId: "SYNCED_SETTINGS",
                section,
                seedWallMs: defaultSeedWallMs
            })
        ),
        // atomic SYNCED_SETTINGS keys (drawSettings, scriptureSettings, deletedDefaults, …):
        // one entity per key, newest HLC wins wholesale. Never tombstoned — these keys always
        // exist via defaults, so local absence only means an older app version.
        {
            kind: "store",
            type: "settings-atomic",
            storeId: "SYNCED_SETTINGS",
            section: null,
            includeKey: (key: string) => !SYNCED_SETTINGS_COLLECTIONS.includes(key),
            noDelete: true,
            seedWallMs: defaultSeedWallMs
        },
        // simple flat stores ({ [id]: item } at the root) — same per-item model as PROJECTS
        flatCollection("overlay", "OVERLAYS"),
        flatCollection("stage-layout", "STAGE"),
        flatCollection("template", "TEMPLATES"),
        flatCollection("theme", "THEMES"),
        flatCollection("event", "EVENTS"),
        // MEDIA (per-path preferences): one entity for the whole store, replicating v1's
        // newest-file-wins. Per-item would tombstone other devices' path-keyed entries whenever
        // a device prunes paths that don't exist on its own file system.
        { kind: "store", type: "store-media", storeId: "MEDIA", section: null, wholeStore: true, noDelete: true, seedWallMs: maxItemSeedWallMs, skip: skipEmptyStore },
        // file-backed collections: one JSON file per item ([id, value]), tracked by id
        { kind: "files", type: "show", folder: "shows", extension: ".show", seedWallMs: defaultSeedWallMs, skip: skipLegacyDeleted },
        { kind: "files", type: "bible", folder: "scriptures", extension: ".fsb", seedWallMs: defaultSeedWallMs }
    ]
    return adapters
}

export function getAdapterByType(type: string): SyncV2Adapter | null {
    return getSyncV2Adapters().find((adapter) => adapter.type === type) || null
}

// extract the id → payload map for one store adapter from a store data snapshot
export function extractPayloads(adapter: StoreAdapter, storeData: unknown): { [id: string]: unknown } {
    if (adapter.wholeStore) {
        if (!storeData || typeof storeData !== "object" || Array.isArray(storeData)) return {}
        if (adapter.skip?.(storeData)) return {}
        return { [WHOLE_STORE_ID]: storeData }
    }

    const section = adapter.section === null ? storeData : (storeData as any)?.[adapter.section]
    if (!section || typeof section !== "object" || Array.isArray(section)) return {}

    const out: { [id: string]: unknown } = {}
    for (const [id, payload] of Object.entries(section)) {
        if (payload === undefined || payload === null) continue
        if (adapter.includeKey && !adapter.includeKey(id)) continue
        if (adapter.skip?.(payload)) continue
        out[id] = payload
    }
    return out
}

// apply pulled changes (payload or null = delete) for one store adapter onto a CLONED store data
// object. Mutates and returns `storeData` (the caller clones once per store, then applies all
// adapters); whole-store adapters return the replacement payload instead.
export function applyPayloadChanges(adapter: StoreAdapter, storeData: any, changes: { [id: string]: unknown | null }): any {
    if (adapter.wholeStore) {
        const payload = changes[WHOLE_STORE_ID]
        // a whole-store tombstone (null) or a non-object payload is never applied: fail towards keeping data
        if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload
        return storeData
    }

    if (!storeData || typeof storeData !== "object") storeData = {}
    let target = storeData
    if (adapter.section !== null) {
        if (!storeData[adapter.section] || typeof storeData[adapter.section] !== "object") storeData[adapter.section] = {}
        target = storeData[adapter.section]
    }

    for (const [id, payload] of Object.entries(changes)) {
        // a remote entity can never write outside its adapter's key space (e.g. a forged
        // "settings-atomic" entity with id "scriptures" overwriting a whole collection)
        if (adapter.includeKey && !adapter.includeKey(id)) continue
        if (payload === null || payload === undefined) delete target[id]
        else target[id] = payload
    }
    return storeData
}
