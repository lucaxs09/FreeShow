// ----- FreeShow -----
// Sync v2: device registry logic (pure).
//
// v2_registry.json is the ONLY shared-write file in the v2 layout, so it is treated as
// self-healing state: every sync merges (cloud ∪ locally cached ∪ self) and re-uploads when
// something is missing. Temporarily losing a device entry only DELAYS seeing its changes
// (its journal and items physically remain in its own namespace) — it can never destroy data.

import type { RegistryDevice, SyncRegistry } from "./entity"

export const EMPTY_REGISTRY: SyncRegistry = { version: 1, devices: [] }

// how often a device refreshes its own lastSeenAt (avoids a shared write on every sync)
export const REGISTRY_REFRESH_MS = 1000 * 60 * 60 * 24 // 24h

export function mergeRegistries(...registries: (SyncRegistry | null)[]): SyncRegistry {
    const byId = new Map<string, RegistryDevice>()

    for (const registry of registries) {
        for (const device of registry?.devices || []) {
            const existing = byId.get(device.deviceId)
            if (!existing) {
                byId.set(device.deviceId, { ...device })
                continue
            }
            existing.addedAt = Math.min(existing.addedAt || device.addedAt, device.addedAt || existing.addedAt)
            if (device.lastSeenAt > existing.lastSeenAt) {
                existing.lastSeenAt = device.lastSeenAt
                if (device.deviceName) existing.deviceName = device.deviceName
            }
        }
    }

    const devices = Array.from(byId.values()).sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1))
    return { version: 1, devices }
}

export interface RegistryPlan {
    merged: SyncRegistry
    shouldUpload: boolean
}

// Decide the registry this sync should work with, and whether to (re-)upload it.
// Upload when: self is missing in the cloud copy, a cached device is missing in the cloud copy
// (healing a previous overwrite), or our own lastSeenAt is stale.
export function planRegistryUpdate(input: { cloud: SyncRegistry | null; cached: SyncRegistry | null; deviceId: string; deviceName?: string; nowMs: number }): RegistryPlan {
    const { cloud, cached, deviceId, deviceName, nowMs } = input

    const cloudIds = new Set((cloud?.devices || []).map((device) => device.deviceId))
    const selfInCloud = cloud?.devices.find((device) => device.deviceId === deviceId)

    const missingFromCloud = (cached?.devices || []).some((device) => !cloudIds.has(device.deviceId))
    const selfStale = !selfInCloud || nowMs - selfInCloud.lastSeenAt > REGISTRY_REFRESH_MS

    const shouldUpload = missingFromCloud || selfStale

    const self: SyncRegistry = {
        version: 1,
        devices: [
            {
                deviceId,
                deviceName,
                addedAt: selfInCloud?.addedAt || nowMs,
                // only bump lastSeenAt when actually uploading, so merged stays equal to cloud otherwise
                lastSeenAt: shouldUpload ? nowMs : selfInCloud?.lastSeenAt || nowMs
            }
        ]
    }

    return { merged: mergeRegistries(cloud, cached, self), shouldUpload }
}
