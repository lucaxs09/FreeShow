// ----- FreeShow -----
// Sync v2: local per-team sync state (device-local, never synced).
//
// Persists what this device has already applied/pushed: the applied winner (HLC + hash) per
// item, the highest HLC seen, the cached registry (self-healing backup for the only shared
// file), and the migration flag. Losing this file is safe: the next sync re-seeds from the
// local stores and re-converges via the journals (idempotent by id).

import path from "path"
import { appDataPath } from "../../data/store"
import { readFileAsync, writeFileAsync } from "../../utils/files"
import type { SyncRegistry } from "./entity"
import { parseRegistry } from "./entity"
import type { ItemsState } from "./engine"
import { parseHlc } from "./hlc"
import { encodeSegment } from "./naming"

export interface SyncV2TeamState {
    version: 1
    deviceId: string
    lastHlc: string | null
    migratedAt: number | null
    // entity types whose initial migration (seed) already ran on this device. Seeding is
    // PER TYPE, not per device: when a later app version adds a new synced type (e.g. shows),
    // its existing local items must seed by their own modified time — versioning them "now"
    // would let stale local copies outrank legitimate newer edits already in v2.
    seededTypes: string[]
    registry: SyncRegistry | null
    items: ItemsState
    lastJournalHash: string | null
}

export function createEmptyState(deviceId: string): SyncV2TeamState {
    return { version: 1, deviceId, lastHlc: null, migratedAt: null, seededTypes: [], registry: null, items: {}, lastJournalHash: null }
}

function stateFilePath(providerId: string, churchId: string, teamId: string): string {
    return path.join(appDataPath, `sync_v2_${encodeSegment(providerId)}_${encodeSegment(churchId)}_${encodeSegment(teamId)}.json`)
}

export async function loadState(providerId: string, churchId: string, teamId: string, deviceId: string): Promise<SyncV2TeamState> {
    try {
        const content = await readFileAsync(stateFilePath(providerId, churchId, teamId))
        if (!content) return createEmptyState(deviceId)

        const data = JSON.parse(content)
        if (!data || data.version !== 1 || typeof data.items !== "object") return createEmptyState(deviceId)
        // a different machine id (restored backup / new machine) must start over with its own namespace
        if (data.deviceId !== deviceId) return createEmptyState(deviceId)

        const migratedAt = typeof data.migratedAt === "number" ? data.migratedAt : null
        const items = data.items || {}
        // back-compat (state written before seededTypes existed): every type that already has
        // items in the state was seeded by that run; types added later still seed on first sight
        let seededTypes: string[] = Array.isArray(data.seededTypes) ? data.seededTypes.filter((type: unknown) => typeof type === "string") : []
        if (!Array.isArray(data.seededTypes) && migratedAt !== null) seededTypes = Object.keys(items)

        return {
            version: 1,
            deviceId,
            lastHlc: typeof data.lastHlc === "string" && parseHlc(data.lastHlc) ? data.lastHlc : null,
            migratedAt,
            seededTypes,
            registry: parseRegistry(data.registry),
            items,
            lastJournalHash: typeof data.lastJournalHash === "string" ? data.lastJournalHash : null
        }
    } catch (err) {
        console.error("Sync v2: could not load local state, starting fresh:", err)
        return createEmptyState(deviceId)
    }
}

export async function saveState(providerId: string, churchId: string, teamId: string, state: SyncV2TeamState): Promise<void> {
    try {
        await writeFileAsync(stateFilePath(providerId, churchId, teamId), JSON.stringify(state))
    } catch (err) {
        console.error("Sync v2: could not save local state:", err)
    }
}
