// ----- FreeShow -----
// Sync v2: canonical data model (SyncEntity, journals, registry) + hashing + safe parsing.
//
// Pure module (no I/O, no Electron; node "crypto" is used only for deterministic hashing).
// Every synced resource is normalized to a SyncEntity: immutable id, HLC version, explicit
// tombstone. Deletion NEVER happens by inference (absence) — only by tombstone.

import { createHash } from "crypto"
import { hlcDeviceId, parseHlc } from "./hlc"

export const SYNC_SCHEMA_VERSION = 1

// full entity as stored in the device's item file (v2_dev_<dev>_item_<type>_<id>.json)
export interface SyncEntity<P = unknown> {
    id: string
    type: string
    schema: number
    hlc: string
    deletedAt: string | null // tombstone (HLC of the deletion); payload is null when set
    payloadHash: string | null
    payload: P | null
}

// journal entry: what a device announces about one item in its namespace (no payload)
export interface JournalEntry {
    id: string
    type: string
    schema: number
    hlc: string
    deletedAt: string | null
    payloadHash: string | null
}

// per-device manifest+meta (v2_dev_<dev>_journal.json) — written ONLY by that device, always last
export interface DeviceJournal {
    version: 1
    deviceId: string
    deviceName?: string
    appVersion?: string
    writtenAt: number
    entries: JournalEntry[]
}

export interface RegistryDevice {
    deviceId: string
    deviceName?: string
    addedAt: number
    lastSeenAt: number
}

// device index (v2_registry.json) — the only shared-write file (read-merge-write, self-healing)
export interface SyncRegistry {
    version: 1
    devices: RegistryDevice[]
}

// ----- hashing -----

// deterministic JSON: object keys sorted recursively (arrays keep order)
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return "[" + value.map((entry) => stableStringify(entry)).join(",") + "]"

    const keys = Object.keys(value as Record<string, unknown>).sort()
    const parts: string[] = []
    for (const key of keys) {
        const entry = (value as Record<string, unknown>)[key]
        if (entry === undefined) continue
        parts.push(JSON.stringify(key) + ":" + stableStringify(entry))
    }
    return "{" + parts.join(",") + "}"
}

export function payloadHash(payload: unknown): string {
    return createHash("sha256").update(stableStringify(payload)).digest("hex")
}

// ----- safe parsing (never trust cloud JSON) -----

function isValidEntry(entry: any): entry is JournalEntry {
    if (!entry || typeof entry !== "object") return false
    if (typeof entry.id !== "string" || !entry.id) return false
    if (typeof entry.type !== "string" || !entry.type) return false
    if (typeof entry.schema !== "number") return false
    if (!parseHlc(entry.hlc)) return false
    if (entry.deletedAt !== null && !parseHlc(entry.deletedAt)) return false
    if (entry.payloadHash !== null && typeof entry.payloadHash !== "string") return false
    return true
}

// validates structure and drops entries not authored by the journal's own device
// (a device only ever writes its own namespace — anything else is corrupt/forged data)
export function parseJournal(raw: unknown, expectedDeviceId?: string): DeviceJournal | null {
    const data = raw as any
    if (!data || typeof data !== "object") return null
    if (data.version !== 1) return null
    if (typeof data.deviceId !== "string" || !data.deviceId) return null
    if (expectedDeviceId && data.deviceId !== expectedDeviceId) return null
    if (!Array.isArray(data.entries)) return null

    const entries = data.entries.filter((entry: any) => isValidEntry(entry) && hlcDeviceId(entry.hlc) === data.deviceId)

    return {
        version: 1,
        deviceId: data.deviceId,
        deviceName: typeof data.deviceName === "string" ? data.deviceName : undefined,
        appVersion: typeof data.appVersion === "string" ? data.appVersion : undefined,
        writtenAt: typeof data.writtenAt === "number" ? data.writtenAt : 0,
        entries
    }
}

export function parseEntity(raw: unknown): SyncEntity | null {
    const data = raw as any
    if (!data || typeof data !== "object") return null
    if (typeof data.id !== "string" || !data.id) return null
    if (typeof data.type !== "string" || !data.type) return null
    if (typeof data.schema !== "number") return null
    if (!parseHlc(data.hlc)) return null
    if (data.deletedAt !== null && data.deletedAt !== undefined && !parseHlc(data.deletedAt)) return null

    return {
        id: data.id,
        type: data.type,
        schema: data.schema,
        hlc: data.hlc,
        deletedAt: data.deletedAt ?? null,
        payloadHash: typeof data.payloadHash === "string" ? data.payloadHash : null,
        payload: data.payload === undefined ? null : data.payload
    }
}

export function parseRegistry(raw: unknown): SyncRegistry | null {
    const data = raw as any
    if (!data || typeof data !== "object") return null
    if (data.version !== 1) return null
    if (!Array.isArray(data.devices)) return null

    const devices: RegistryDevice[] = []
    for (const device of data.devices) {
        if (!device || typeof device !== "object") continue
        if (typeof device.deviceId !== "string" || !device.deviceId) continue
        devices.push({
            deviceId: device.deviceId,
            deviceName: typeof device.deviceName === "string" ? device.deviceName : undefined,
            addedAt: typeof device.addedAt === "number" ? device.addedAt : 0,
            lastSeenAt: typeof device.lastSeenAt === "number" ? device.lastSeenAt : 0
        })
    }

    return { version: 1, devices }
}
