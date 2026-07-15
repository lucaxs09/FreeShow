// ----- FreeShow -----
// Sync v2: orchestrator (the "dirty" layer — I/O only, decisions live in the pure modules).
//
// Opt-in per-device journal sync over the existing ChurchApps content store (design "level B"):
// every device writes ONLY its own flat-named files (v2_dev_<id>_journal.json / ..._item_...),
// so concurrent syncs can never overwrite each other; deletions are explicit tombstones; the
// merge is a deterministic pure function (engine.ts) over the union of the journals.
//
// STRICTLY OPT-IN: this only runs when the user sets `cloudSyncData.v2 = true` in settings.json
// (see isSyncV2Enabled). The default v1 flow is untouched. While v2 is enabled it covers
// everything v1 syncs: PROJECTS, SYNCED_SETTINGS (item-collections AND atomic keys), OVERLAYS,
// STAGE, TEMPLATES, THEMES, EVENTS, MEDIA, plus the file-backed shows (*.show) and bibles (*.fsb).

import { app } from "electron"
import os from "os"
import { Main } from "../../../types/IPC/Main"
import { _store, getStore, safeStoreSet } from "../../data/store"
import { sendMain } from "../../IPC/main"
import { getDataFolderPath, loadShows } from "../../utils/files"
import { clone, getMachineId } from "../../utils/helpers"
import { getChurchAppsSyncManager } from "../ChurchAppsSyncManager"
import type { SyncProviderId } from "../syncManager"
import { applyPayloadChanges, extractPayloads, getSyncV2Adapters, type FileAdapter, type StoreAdapter, type SyncV2StoreId } from "./adapters"
import { acceptFetchedEntity, applyPull, buildEntity, buildPush, detectLocalChanges, planPull, type ApplyPullInput, type PullPlan } from "./engine"
import { parseEntity, parseJournal, parseRegistry, payloadHash, type DeviceJournal, type SyncEntity } from "./entity"
import { buildFileCollection, planFileApply } from "./fileCollections"
import { executeFileChanges, readFileCollectionEntries } from "./fileCollectionsIO"
import { hlcMax } from "./hlc"
import { itemFileName, journalFileName, registryFileName } from "./naming"
import { planRegistryUpdate } from "./registry"
import { loadState, saveState } from "./state"

const UPLOAD_BATCH_SIZE = 5

export function isSyncV2Enabled(): boolean {
    try {
        return (getStore("SETTINGS") as any)?.cloudSyncData?.v2 === true
    } catch {
        return false
    }
}

function getDeviceName(): string {
    try {
        const settingsName = (getStore("SETTINGS") as any)?.cloudSyncData?.deviceName
        if (typeof settingsName === "string" && settingsName) return settingsName
    } catch {
        // fall through
    }
    try {
        return os.hostname()
    } catch {
        return ""
    }
}

async function inBatches<T, R>(entries: T[], size: number, run: (entry: T) => Promise<R>): Promise<R[]> {
    const results: R[] = []
    for (let i = 0; i < entries.length; i += size) {
        const batch = entries.slice(i, i + size)
        results.push(...(await Promise.all(batch.map(run))))
    }
    return results
}

let running = false

export async function syncDataV2(data: { id: SyncProviderId; churchId: string; teamId: string; method: "merge" | "read_only" | "upload" | "replace" }): Promise<{ success?: boolean; error?: string; changedFiles: string[] }> {
    const changedFiles: string[] = []

    const provider = getChurchAppsSyncManager()
    if (!provider) return { success: false, error: "Sync provider not available", changedFiles }

    if (running) return { success: false, error: "A sync is already running", changedFiles }
    running = true

    try {
        console.log("Sync v2: syncing (per-device journal)")
        // SEMANTIC CHANGE vs v1: "replace" (v1: discard local, take cloud) is intentionally
        // downgraded to a plain merge in v2 — local-only items are KEPT and re-uploaded instead
        // of discarded, and only explicit remote tombstones delete anything. This trades exact
        // v1 behavior for the no-data-loss guarantee; both converge to the same team state.
        const readOnly = data.method === "read_only"
        const pushOnly = data.method === "upload"
        const nowMs = Date.now()

        const deviceId = getMachineId()
        if (!deviceId) return { success: false, error: "Could not determine a device id", changedFiles }

        const state = await loadState(data.id, data.churchId, data.teamId, deviceId)
        const adapters = getSyncV2Adapters()
        let hadErrors = false

        // ----- local snapshot + change detection (pure) -----

        const current: { [type: string]: { [id: string]: unknown } } = {}
        const noDeleteTypes: string[] = []
        // per file-backed type: where its folder is and which disk file represents each id
        const fileTypeIO: { [type: string]: { folderPath: string; fileNameById: { [id: string]: string }; allFileNamesById: { [id: string]: string[] }; healthy: boolean } } = {}

        for (const adapter of adapters) {
            if (adapter.kind === "files") {
                const folderPath = getDataFolderPath(adapter.folder)
                const read = await readFileCollectionEntries(folderPath, adapter.extension)
                const collection = buildFileCollection(read.entries, adapter.extension, adapter.skip)
                fileTypeIO[adapter.type] = { folderPath, fileNameById: collection.fileNameById, allFileNamesById: collection.allFileNamesById, healthy: read.healthy }

                if (!read.healthy) {
                    // folder unreadable: nothing may be inferred (or written) for this type this run
                    hadErrors = true
                    continue
                }
                if (collection.invalidCount > 0) {
                    // an unreadable file could hold a synced id → absence must not tombstone
                    console.warn(`Sync v2: ${collection.invalidCount} unreadable ${adapter.extension} file(s), deletions for "${adapter.type}" skipped this run`)
                    noDeleteTypes.push(adapter.type)
                }
                current[adapter.type] = collection.items
            } else {
                const storeData = _store[adapter.storeId]?.store
                current[adapter.type] = storeData ? extractPayloads(adapter, storeData) : {}
            }
            if (adapter.noDelete) noDeleteTypes.push(adapter.type)
        }

        // seeding is per TYPE (a later app version can add new synced types): first-seen types
        // version their items by their own modified time, already-seeded types tick "now"
        const seeded = new Set(state.seededTypes)
        const seedCurrent: typeof current = {}
        const trackCurrent: typeof current = {}
        for (const [type, byId] of Object.entries(current)) (seeded.has(type) ? trackCurrent : seedCurrent)[type] = byId

        const seedWallMs = (type: string, payload: unknown) => adapters.find((adapter) => adapter.type === type)?.seedWallMs(payload) || 0
        const seedDetected = detectLocalChanges({ items: state.items, current: seedCurrent, deviceId, nowMs, lastHlc: state.lastHlc, seedMode: true, seedWallMs, noDeleteTypes })
        const detected = detectLocalChanges({ items: seedDetected.items, current: trackCurrent, deviceId, nowMs, lastHlc: seedDetected.lastHlc, seedMode: false, noDeleteTypes })
        state.items = detected.items
        state.lastHlc = detected.lastHlc
        const skippedWipeTypes = [...seedDetected.skippedWipeTypes, ...detected.skippedWipeTypes]
        if (skippedWipeTypes.length) console.warn("Sync v2: local store looked wiped, skipped tombstoning:", skippedWipeTypes.join(", "))

        // ----- registry (the only shared file: read-merge-write, self-healing) -----

        const registryResult = await provider.getJsonFile(data.churchId, data.teamId, registryFileName())
        let registryReadFailed = registryResult.status === "error"
        let cloudRegistry = registryResult.status === "ok" ? parseRegistry(registryResult.data) : null
        if (registryResult.status === "ok" && !cloudRegistry) {
            // response exists but doesn't validate: only overwrite plain corruption, never a newer format
            const version = (registryResult.data as any)?.version
            if (typeof version === "number" && version > 1) registryReadFailed = true
        }

        const registryPlan = planRegistryUpdate({ cloud: cloudRegistry, cached: state.registry, deviceId, deviceName: getDeviceName(), nowMs })
        state.registry = registryPlan.merged

        if (!readOnly && registryPlan.shouldUpload && !registryReadFailed) {
            const uploaded = await provider.uploadJsonFile(data.teamId, registryFileName(), JSON.stringify(registryPlan.merged))
            if (!uploaded) hadErrors = true
        }

        // ----- pull: fetch other devices' journals, merge (pure), apply to the stores -----

        if (!pushOnly) {
            const otherDevices = registryPlan.merged.devices.filter((device) => device.deviceId !== deviceId)

            const journals: DeviceJournal[] = []
            await inBatches(otherDevices, UPLOAD_BATCH_SIZE, async (device) => {
                const result = await provider.getJsonFile(data.churchId, data.teamId, journalFileName(device.deviceId))
                if (result.status === "error") {
                    // transient: this only DELAYS that device's changes (its journal stays in its namespace)
                    hadErrors = true
                    return
                }
                if (result.status === "not_found") return // device hasn't pushed yet
                const journal = parseJournal(result.data, device.deviceId)
                if (journal) journals.push(journal)
            })

            const plan = planPull(state.items, journals, deviceId)
            state.lastHlc = hlcMax(state.lastHlc, plan.maxRemoteHlc)
            if (plan.skippedNewerSchema.length) console.warn("Sync v2: some items were written by a newer app version and were skipped:", plan.skippedNewerSchema.length)

            // entities of a type this build has no adapter for (a NEWER build introduced it — e.g.
            // a mixed fleet during a rollout) must be ignored entirely: "applying" them would only
            // mark state without writing anything anywhere, and that phantom "applied" state would
            // read as a local deletion (→ team-wide tombstone) once this device gets the adapter.
            const adapterByType = new Map(adapters.map((adapter) => [adapter.type, adapter]))
            const unknownTypes = new Set([...plan.fetches, ...plan.deletes, ...plan.adoptions].map((entry) => entry.type).filter((type) => !adapterByType.has(type)))
            if (unknownTypes.size) {
                console.warn("Sync v2: skipped items of unknown types (newer app version?):", [...unknownTypes].join(", "))
                plan.fetches = plan.fetches.filter((entry) => adapterByType.has(entry.type))
                plan.deletes = plan.deletes.filter((entry) => adapterByType.has(entry.type))
                plan.adoptions = plan.adoptions.filter((entry) => adapterByType.has(entry.type))
            }

            const fetched: { entry: (typeof plan.fetches)[0]["entry"]; entity: SyncEntity }[] = []
            await inBatches(plan.fetches, UPLOAD_BATCH_SIZE, async (fetch) => {
                const result = await provider.getJsonFile(data.churchId, data.teamId, itemFileName(fetch.deviceId, fetch.type, fetch.id))
                if (result.status !== "ok") {
                    if (result.status === "error") hadErrors = true
                    return // missing/stale item: retried on the next sync, nothing is lost
                }
                const entity = parseEntity(result.data)
                if (entity && acceptFetchedEntity(fetch.entry, entity)) fetched.push({ entry: fetch.entry, entity })
                else console.warn("Sync v2: skipped a stale/invalid item file:", fetch.type, fetch.id)
            })

            // file-backed types (shows/bibles) are applied to DISK first, and only the changes
            // the disk accepted reach applyPull — a failed write/delete is retried next sync and
            // can never be mistaken for a local deletion (no phantom tombstones)
            const isFileType = (type: string) => adapterByType.get(type)?.kind === "files"

            const applyFetched: ApplyPullInput["fetched"] = fetched.filter(({ entry }) => !isFileType(entry.type))
            const applyDeletes: PullPlan["deletes"] = plan.deletes.filter(({ type }) => !isFileType(type))

            const fileChangesByType = new Map<string, { id: string; payload: unknown | null }[]>()
            const pushFileChange = (type: string, id: string, payload: unknown | null) => {
                if (!fileChangesByType.has(type)) fileChangesByType.set(type, [])
                fileChangesByType.get(type)!.push({ id, payload })
            }
            for (const { entry, entity } of fetched) if (isFileType(entry.type)) pushFileChange(entry.type, entry.id, entity.payload)
            for (const { type, id } of plan.deletes) if (isFileType(type)) pushFileChange(type, id, null)

            const appliedFileTypes = new Set<string>()
            const replacedShowNames: string[] = []
            for (const [type, changes] of fileChangesByType) {
                const adapter = adapterByType.get(type) as FileAdapter
                const io = fileTypeIO[type]
                if (!io?.healthy) {
                    hadErrors = true // folder unreadable: this pull is retried next sync, nothing lost
                    continue
                }

                const planned = planFileApply({ changes, fileNameById: io.fileNameById, allFileNamesById: io.allFileNamesById, extension: adapter.extension })
                const results = await executeFileChanges(io.folderPath, planned)

                const succeeded = new Set(results.filter((result) => result.success).map((result) => result.id))
                if (succeeded.size < changes.length) hadErrors = true
                if (succeeded.size) appliedFileTypes.add(type)

                for (const { entry, entity } of fetched) {
                    if (entry.type !== type || !succeeded.has(entry.id)) continue
                    applyFetched.push({ entry, entity })
                    if (type === "show") {
                        // pass the base name of the file ACTUALLY written (post-sanitize) so the
                        // shows cache re-parses exactly the entries that changed on disk
                        const written = planned.find((change) => change.id === entry.id)?.write?.fileName
                        if (written) replacedShowNames.push(written.slice(0, written.length - adapter.extension.length))
                    }
                }
                for (const remoteDelete of plan.deletes) {
                    if (remoteDelete.type === type && succeeded.has(remoteDelete.id)) applyDeletes.push(remoteDelete)
                }
            }

            const itemsBeforeApply = state.items
            const applied = applyPull({ items: state.items, fetched: applyFetched, deletes: applyDeletes, adoptions: plan.adoptions })
            state.items = applied.items

            // group the pulled changes per store, apply via the adapters (pure) and save once
            const perStore = new Map<SyncV2StoreId, { adapter: StoreAdapter; changes: { [id: string]: unknown | null } }[]>()
            for (const [type, changes] of Object.entries(applied.storeChanges)) {
                const adapter = adapterByType.get(type)
                if (!adapter || adapter.kind !== "store" || !Object.keys(changes).length) continue
                if (!perStore.has(adapter.storeId)) perStore.set(adapter.storeId, [])
                perStore.get(adapter.storeId)!.push({ adapter, changes })
            }

            for (const [storeId, entries] of perStore) {
                const localStore = _store[storeId]
                if (!localStore) continue

                let storeData = clone(localStore.store)
                for (const { adapter, changes } of entries) storeData = applyPayloadChanges(adapter, storeData, changes)

                const saved = await safeStoreSet(localStore, storeData, storeId)
                if (!saved) {
                    // CRITICAL: if the store write failed, the pulled items must NOT be marked as
                    // applied — otherwise the next run would see them missing from the store while
                    // the state says "live", read that as a local deletion and tombstone them for
                    // the whole team. Roll the state back for this store's types so store and
                    // state stay consistent and the next sync simply re-applies the pull.
                    hadErrors = true
                    for (const { adapter } of entries) {
                        if (itemsBeforeApply[adapter.type]) state.items[adapter.type] = itemsBeforeApply[adapter.type]
                        else delete state.items[adapter.type]
                    }
                    continue
                }
                sendMain(Main[storeId], storeData)
                changedFiles.push(storeId)
            }

            // pulled show files changed on disk → refresh the trimmed shows cache (like v1)
            if (appliedFileTypes.has("show")) {
                try {
                    loadShows(false, replacedShowNames)
                    if (_store.SHOWS) sendMain(Main.SHOWS, _store.SHOWS.store)
                } catch (err) {
                    console.error("Sync v2: could not refresh the shows cache:", err)
                }
                changedFiles.push("SHOWS")
            }
            if (appliedFileTypes.has("bible")) changedFiles.push("BIBLES")
        }

        // ----- push: item files first, own journal LAST (never references a missing item) -----

        if (!readOnly) {
            const push = buildPush(state.items, deviceId, { deviceName: getDeviceName(), appVersion: app.getVersion?.() || "", nowMs })

            let uploadedAny = false
            await inBatches(push.uploads, UPLOAD_BATCH_SIZE, async (upload) => {
                const payload = current[upload.type]?.[upload.id]
                const itemState = state.items[upload.type]?.[upload.id]
                if (payload === undefined || payload === null || !itemState) return

                const entity = buildEntity(upload.type, upload.id, itemState, payload)
                const ok = await provider.uploadJsonFile(data.teamId, itemFileName(deviceId, upload.type, upload.id), JSON.stringify(entity))
                if (!ok) {
                    hadErrors = true // retried next run (pushedHash still differs); journals stay safe
                    return
                }
                itemState.pushedHash = upload.hash
                uploadedAny = true
            })

            const journalHash = payloadHash(push.journal.entries)
            if (uploadedAny || journalHash !== state.lastJournalHash) {
                const ok = await provider.uploadJsonFile(data.teamId, journalFileName(deviceId), JSON.stringify(push.journal))
                if (ok) state.lastJournalHash = journalHash
                else hadErrors = true
            }
        }

        if (state.migratedAt === null) state.migratedAt = nowMs
        // only types actually snapshotted this run count as seeded (an unreadable folder's type
        // must seed for real on a later run instead of ticking "now" over stale items)
        state.seededTypes = Array.from(new Set([...state.seededTypes, ...Object.keys(current)]))
        await saveState(data.id, data.churchId, data.teamId, state)

        console.log("Sync v2: completed" + (hadErrors ? " with errors (nothing lost — pending changes retry next sync)" : "!"))
        return { success: !hadErrors, changedFiles }
    } catch (err) {
        console.error("Sync v2: sync failed:", err)
        return { success: false, error: "Sync failed: " + String((err as Error)?.message || err), changedFiles }
    } finally {
        running = false
    }
}
