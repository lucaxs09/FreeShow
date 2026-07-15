import { describe, expect, it } from "vitest"
import type { SyncRegistry } from "./entity"
import { mergeRegistries, planRegistryUpdate, REGISTRY_REFRESH_MS } from "./registry"

const NOW = 1750000000000

function registryOf(...ids: string[]): SyncRegistry {
    return { version: 1, devices: ids.map((deviceId) => ({ deviceId, addedAt: 1, lastSeenAt: NOW })) }
}

describe("registry — merge (self-healing union)", () => {
    it("unions devices from all sources", () => {
        const merged = mergeRegistries(registryOf("A"), registryOf("B"), null)
        expect(merged.devices.map((device) => device.deviceId)).toEqual(["A", "B"])
    })

    it("keeps the freshest lastSeenAt and the earliest addedAt for duplicates", () => {
        const older = { version: 1 as const, devices: [{ deviceId: "A", addedAt: 5, lastSeenAt: 10 }] }
        const newer = { version: 1 as const, devices: [{ deviceId: "A", addedAt: 8, lastSeenAt: 20, deviceName: "Booth" }] }
        const merged = mergeRegistries(older, newer)
        expect(merged.devices).toEqual([{ deviceId: "A", addedAt: 5, lastSeenAt: 20, deviceName: "Booth" }])
    })
})

describe("registry — update plan", () => {
    it("bootstraps and uploads when the cloud registry does not exist", () => {
        const plan = planRegistryUpdate({ cloud: null, cached: null, deviceId: "A", nowMs: NOW })
        expect(plan.shouldUpload).toBe(true)
        expect(plan.merged.devices.map((device) => device.deviceId)).toEqual(["A"])
    })

    it("uploads when self is missing from the cloud copy", () => {
        const plan = planRegistryUpdate({ cloud: registryOf("B"), cached: null, deviceId: "A", nowMs: NOW })
        expect(plan.shouldUpload).toBe(true)
        expect(plan.merged.devices.map((device) => device.deviceId)).toEqual(["A", "B"])
    })

    it("heals a cloud copy that lost a cached device (a racy overwrite only delays, never destroys)", () => {
        const plan = planRegistryUpdate({ cloud: registryOf("A", "B"), cached: registryOf("C"), deviceId: "A", nowMs: NOW })
        expect(plan.shouldUpload).toBe(true)
        expect(plan.merged.devices.map((device) => device.deviceId)).toEqual(["A", "B", "C"])
    })

    it("does NOT upload when everything is present and fresh (no shared write per sync)", () => {
        const plan = planRegistryUpdate({ cloud: registryOf("A", "B"), cached: registryOf("A", "B"), deviceId: "A", nowMs: NOW + 1000 })
        expect(plan.shouldUpload).toBe(false)
    })

    it("refreshes its own lastSeenAt when stale", () => {
        const stale: SyncRegistry = { version: 1, devices: [{ deviceId: "A", addedAt: 1, lastSeenAt: NOW - REGISTRY_REFRESH_MS - 1 }] }
        const plan = planRegistryUpdate({ cloud: stale, cached: null, deviceId: "A", nowMs: NOW })
        expect(plan.shouldUpload).toBe(true)
        expect(plan.merged.devices[0].lastSeenAt).toBe(NOW)
    })
})
