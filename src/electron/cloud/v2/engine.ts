// ----- FreeShow -----
// Sync v2: deterministic merge engine (pure — no I/O, no Electron).
//
// Model: the team state is the union of per-device journals; every item is versioned by an HLC
// and deleted only by explicit tombstone. Merging is a pure function over that union:
// per (type, id) the highest HLC wins (a total order — wall time, counter, deviceId).
// Because no device ever writes another device's files, there is no lost-update by construction;
// a conflict "loser" physically persists in its author's namespace until that author itself
// adopts the winner (own-namespace compaction), so losses are never silent nor unrecoverable.
//
// The dirty layer (syncV2Manager) only moves bytes; every decision lives here, unit-tested.

import type { DeviceJournal, JournalEntry, SyncEntity } from "./entity"
import { SYNC_SCHEMA_VERSION, payloadHash } from "./entity"
import { hlcCompare, hlcDeviceId, hlcFromParts, hlcMax, hlcTick, hlcWallMs } from "./hlc"

// tombstones older than this are compacted away (dropped from journal AND local state).
// safe-failure trade-off: a device offline longer than the TTL may resurrect a deleted item.
export const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 days

// wipe guard: if a type had at least this many live items and suddenly has zero, assume a
// corrupt/empty local store instead of a mass deletion and skip tombstoning that type this run.
// KNOWN LIMITATION: the count heuristic can't tell a corrupt store from a user legitimately
// deleting ALL items of a type — in that case the deletion never syncs (the device keeps
// announcing the items as live, its own store stays empty, and a device joining later
// re-materializes them from the item files). Fails towards keeping data, never losing it;
// the user can work around it by deleting all-but-two items, syncing, then deleting the rest.
// A proper fix needs an explicit store-load-failure signal instead of this heuristic.
export const WIPE_GUARD_MIN_ITEMS = 3

// the locally applied winner per item (hlc embeds the author deviceId)
export interface ItemState {
    hlc: string
    hash: string | null // null for tombstones
    deleted?: boolean
    pushedHash?: string | null // last hash successfully uploaded as an item file (self-authored only)
}

export type ItemsState = { [type: string]: { [id: string]: ItemState } }

function cloneItems(items: ItemsState): ItemsState {
    const out: ItemsState = {}
    for (const [type, byId] of Object.entries(items || {})) {
        out[type] = {}
        for (const [id, state] of Object.entries(byId || {})) out[type][id] = { ...state }
    }
    return out
}

function getItem(items: ItemsState, type: string, id: string): ItemState | null {
    return items[type]?.[id] || null
}

function setItem(items: ItemsState, type: string, id: string, state: ItemState) {
    if (!items[type]) items[type] = {}
    items[type][id] = state
}

// ----- 1) local change detection -----

export interface LocalDetectInput {
    items: ItemsState
    // current local payloads per type (only types listed here are managed/reconciled)
    current: { [type: string]: { [id: string]: unknown } }
    deviceId: string
    nowMs: number
    lastHlc: string | null // max HLC ever seen (own or remote) — keeps ticks monotonic
    // first activation (migration): version new items by their own modified time instead of "now",
    // so a migrating device can't accidentally outrank legitimate newer edits already in v2
    seedMode: boolean
    seedWallMs?: (type: string, payload: unknown) => number
    // types whose local absence must NEVER produce tombstones this run: atomic settings (always
    // re-filled from defaults, so absence is meaningless) and file-backed types where a file
    // failed to parse (the missing id might live in the unreadable file). Adds/edits still sync.
    noDeleteTypes?: string[]
}

export interface LocalDetectResult {
    items: ItemsState
    lastHlc: string | null
    // types where every item vanished at once → tombstoning skipped as a safety net
    skippedWipeTypes: string[]
}

export function detectLocalChanges(input: LocalDetectInput): LocalDetectResult {
    const { deviceId, nowMs, seedMode, seedWallMs } = input
    const items = cloneItems(input.items)
    const noDeleteTypes = new Set(input.noDeleteTypes || [])
    let lastHlc = input.lastHlc
    const skippedWipeTypes: string[] = []

    const tick = () => {
        lastHlc = hlcTick(lastHlc, nowMs, deviceId)
        return lastHlc
    }

    for (const [type, currentById] of Object.entries(input.current)) {
        const ids = Object.keys(currentById || {})

        // new / modified / revived
        for (const id of ids) {
            const payload = currentById[id]
            if (payload === undefined || payload === null) continue

            const hash = payloadHash(payload)
            const previous = getItem(items, type, id)

            if (!previous) {
                let hlc: string
                if (seedMode) {
                    hlc = hlcFromParts(Math.min(Math.max(0, seedWallMs?.(type, payload) || 0), nowMs), 0, deviceId)
                    // fold seed HLCs into lastHlc: a later edit must tick STRICTLY above every
                    // migrated item even if the wall clock goes backwards between runs (NTC/VM),
                    // otherwise the edit would lose to (or tie with) the seed on the peers
                    lastHlc = hlcMax(lastHlc, hlc)
                } else {
                    hlc = tick()
                }
                setItem(items, type, id, { hlc, hash })
                continue
            }
            if (!previous.deleted && previous.hash === hash) continue // unchanged

            // modified, or revived after a deletion
            setItem(items, type, id, { hlc: tick(), hash, pushedHash: previous.pushedHash ?? null })
        }

        // local deletions → explicit tombstones (never inferred remotely from absence)
        const known = items[type] || {}
        const liveKnown = Object.entries(known).filter(([, state]) => !state.deleted)
        if (noDeleteTypes.has(type)) {
            // deletions suppressed for this type this run (see LocalDetectInput.noDeleteTypes)
        } else if (ids.length === 0 && liveKnown.length >= WIPE_GUARD_MIN_ITEMS) {
            skippedWipeTypes.push(type)
        } else {
            for (const [id] of liveKnown) {
                if (currentById && currentById[id] !== undefined && currentById[id] !== null) continue
                setItem(items, type, id, { hlc: tick(), hash: null, deleted: true })
            }
        }

        // tombstone TTL compaction (own state only shrinks; remote re-announcements are re-adopted harmlessly)
        for (const [id, state] of Object.entries(items[type] || {})) {
            if (!state.deleted) continue
            if (nowMs - hlcWallMs(state.hlc) > TOMBSTONE_TTL_MS) delete items[type][id]
        }
    }

    return { items, lastHlc, skippedWipeTypes }
}

// ----- 2) pull planning -----

export interface PullPlan {
    // remote winners whose payload we need (fetched from the WINNER's namespace)
    fetches: { type: string; id: string; deviceId: string; entry: JournalEntry }[]
    // remote tombstone wins over a live local item → remove from the local store
    deletes: { type: string; id: string; entry: JournalEntry }[]
    // state-only updates: same content (hash equal) or a tombstone for an item we don't have
    adoptions: { type: string; id: string; entry: JournalEntry }[]
    // entries written by a newer app schema → left untouched (never written back degraded)
    skippedNewerSchema: { type: string; id: string }[]
    // highest remote HLC observed (feeds lastHlc so future local ticks outrank it)
    maxRemoteHlc: string | null
}

export function planPull(items: ItemsState, remoteJournals: DeviceJournal[], selfDeviceId: string, maxSchema: number = SYNC_SCHEMA_VERSION): PullPlan {
    const plan: PullPlan = { fetches: [], deletes: [], adoptions: [], skippedNewerSchema: [], maxRemoteHlc: null }

    // winner per (type, id) across all remote journals
    const winners = new Map<string, { entry: JournalEntry; deviceId: string }>()
    for (const journal of remoteJournals) {
        if (!journal || journal.deviceId === selfDeviceId) continue
        for (const entry of journal.entries) {
            plan.maxRemoteHlc = hlcMax(plan.maxRemoteHlc, entry.hlc)
            const key = entry.type + "\u0000" + entry.id
            const existing = winners.get(key)
            if (!existing || hlcCompare(entry.hlc, existing.entry.hlc) > 0) winners.set(key, { entry, deviceId: journal.deviceId })
        }
    }

    for (const { entry, deviceId } of winners.values()) {
        const local = getItem(items, entry.type, entry.id)
        if (local && hlcCompare(local.hlc, entry.hlc) >= 0) continue // local state wins or is identical

        if (entry.schema > maxSchema) {
            plan.skippedNewerSchema.push({ type: entry.type, id: entry.id })
            continue
        }

        if (entry.deletedAt) {
            if (local && !local.deleted) plan.deletes.push({ type: entry.type, id: entry.id, entry })
            else plan.adoptions.push({ type: entry.type, id: entry.id, entry })
            continue
        }

        // same content already present locally → adopt the version without downloading
        if (local && !local.deleted && local.hash !== null && local.hash === entry.payloadHash) {
            plan.adoptions.push({ type: entry.type, id: entry.id, entry })
            continue
        }

        plan.fetches.push({ type: entry.type, id: entry.id, deviceId, entry })
    }

    return plan
}

// A fetched item file is accepted only if it matches its journal entry and is not an older
// leftover (S3 read races: the journal may momentarily be newer than the item object).
// A NEWER item than announced is fine — its HLC still resolves the merge deterministically.
export function acceptFetchedEntity(entry: JournalEntry, entity: SyncEntity | null): boolean {
    if (!entity) return false
    if (entity.id !== entry.id || entity.type !== entry.type) return false
    if (entity.schema > SYNC_SCHEMA_VERSION) return false
    if (entity.deletedAt) return false // tombstones travel via journals, not item files
    if (entity.payload === null || entity.payload === undefined) return false
    return hlcCompare(entity.hlc, entry.hlc) >= 0
}

// ----- 3) apply pulled data -----

export interface ApplyPullInput {
    items: ItemsState
    fetched: { entry: JournalEntry; entity: SyncEntity }[] // already accepted (acceptFetchedEntity)
    deletes: PullPlan["deletes"]
    adoptions: PullPlan["adoptions"]
}

export interface ApplyPullResult {
    items: ItemsState
    // payload per (type, id) to write into the local stores; null = remove
    storeChanges: { [type: string]: { [id: string]: unknown | null } }
}

export function applyPull(input: ApplyPullInput): ApplyPullResult {
    const items = cloneItems(input.items)
    const storeChanges: ApplyPullResult["storeChanges"] = {}

    const change = (type: string, id: string, payload: unknown | null) => {
        if (!storeChanges[type]) storeChanges[type] = {}
        storeChanges[type][id] = payload
    }

    for (const { entry, entity } of input.fetched) {
        // recompute the hash over what we actually apply (don't trust the announced one)
        setItem(items, entry.type, entry.id, { hlc: entity.hlc, hash: payloadHash(entity.payload) })
        change(entry.type, entry.id, entity.payload)
    }

    for (const { type, id, entry } of input.deletes) {
        setItem(items, type, id, { hlc: entry.hlc, hash: null, deleted: true })
        change(type, id, null)
    }

    for (const { type, id, entry } of input.adoptions) {
        const local = getItem(items, type, id)
        if (entry.deletedAt) setItem(items, type, id, { hlc: entry.hlc, hash: null, deleted: true })
        else setItem(items, type, id, { hlc: entry.hlc, hash: local?.hash ?? entry.payloadHash })
    }

    return { items, storeChanges }
}

// ----- 4) push planning -----

export interface PushPlan {
    journal: DeviceJournal
    // self-authored live items whose current hash was never uploaded → item files to upload
    uploads: { type: string; id: string; hash: string }[]
}

// The device's journal is derived from state: every item whose winning HLC was authored by this
// device. Items superseded by another device drop out automatically (own-namespace compaction).
// Item files are uploaded BEFORE the journal (dirty layer) so the manifest never references a
// missing item; if an upload fails, the stale-object guard (acceptFetchedEntity) keeps it safe.
export function buildPush(items: ItemsState, deviceId: string, meta: { deviceName?: string; appVersion?: string; nowMs: number }): PushPlan {
    const entries: JournalEntry[] = []
    const uploads: PushPlan["uploads"] = []

    for (const [type, byId] of Object.entries(items || {})) {
        for (const [id, state] of Object.entries(byId || {})) {
            if (hlcDeviceId(state.hlc) !== deviceId) continue

            entries.push({
                id,
                type,
                schema: SYNC_SCHEMA_VERSION,
                hlc: state.hlc,
                deletedAt: state.deleted ? state.hlc : null,
                payloadHash: state.deleted ? null : state.hash
            })

            if (!state.deleted && state.hash !== null && state.pushedHash !== state.hash) uploads.push({ type, id, hash: state.hash })
        }
    }

    entries.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.id < b.id ? -1 : 1))

    const journal: DeviceJournal = {
        version: 1,
        deviceId,
        deviceName: meta.deviceName,
        appVersion: meta.appVersion,
        writtenAt: meta.nowMs,
        entries
    }

    return { journal, uploads }
}

export function buildEntity(type: string, id: string, state: ItemState, payload: unknown): SyncEntity {
    return {
        id,
        type,
        schema: SYNC_SCHEMA_VERSION,
        hlc: state.hlc,
        deletedAt: null,
        payloadHash: state.hash,
        payload
    }
}
