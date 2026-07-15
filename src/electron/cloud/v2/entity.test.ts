import { describe, expect, it } from "vitest"
import { parseEntity, parseJournal, parseRegistry, payloadHash, stableStringify } from "./entity"
import { hlcFromParts } from "./hlc"

const T = 1750000000000
const HLC_A = hlcFromParts(T, 0, "A")
const HLC_B = hlcFromParts(T, 0, "B")

describe("stableStringify / payloadHash", () => {
    it("is independent of object key order", () => {
        expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
        expect(payloadHash({ b: 1, a: 2 })).toBe(payloadHash({ a: 2, b: 1 }))
    })

    it("keeps array order significant", () => {
        expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]))
    })

    it("distinguishes different content", () => {
        expect(payloadHash({ name: "a" })).not.toBe(payloadHash({ name: "b" }))
    })

    it("skips undefined values like JSON does", () => {
        expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
    })
})

describe("parseJournal (never trust cloud JSON)", () => {
    const valid = { version: 1, deviceId: "A", writtenAt: T, entries: [{ id: "x", type: "project", schema: 1, hlc: HLC_A, deletedAt: null, payloadHash: "h" }] }

    it("accepts a valid journal", () => {
        const journal = parseJournal(valid, "A")
        expect(journal?.entries).toHaveLength(1)
    })

    it("rejects garbage, wrong versions and mismatched deviceIds", () => {
        expect(parseJournal(null)).toBeNull()
        expect(parseJournal("junk")).toBeNull()
        expect(parseJournal({ ...valid, version: 2 })).toBeNull()
        expect(parseJournal(valid, "B")).toBeNull() // fetched from B's namespace but claims to be A
    })

    it("drops entries not authored by the journal's own device (a device only writes its namespace)", () => {
        const forged = { ...valid, entries: [...valid.entries, { id: "y", type: "project", schema: 1, hlc: HLC_B, deletedAt: null, payloadHash: "h" }] }
        const journal = parseJournal(forged, "A")
        expect(journal?.entries.map((entry) => entry.id)).toEqual(["x"])
    })

    it("drops structurally invalid entries but keeps the rest", () => {
        const mixed = { ...valid, entries: [{ id: "", type: "project", schema: 1, hlc: HLC_A, deletedAt: null, payloadHash: null }, { id: "x", type: "project", schema: 1, hlc: "garbage", deletedAt: null, payloadHash: null }, ...valid.entries] }
        expect(parseJournal(mixed, "A")?.entries.map((entry) => entry.id)).toEqual(["x"])
    })
})

describe("parseEntity", () => {
    it("accepts a valid entity and normalizes optional fields", () => {
        const entity = parseEntity({ id: "x", type: "project", schema: 1, hlc: HLC_A, deletedAt: null, payloadHash: "h", payload: { name: "P" } })
        expect(entity?.payload).toEqual({ name: "P" })
        expect(parseEntity({ id: "x", type: "project", schema: 1, hlc: HLC_A })?.deletedAt).toBeNull()
    })

    it("rejects invalid entities", () => {
        expect(parseEntity(null)).toBeNull()
        expect(parseEntity({ id: "x", type: "project", schema: 1, hlc: "bad" })).toBeNull()
        expect(parseEntity({ id: "", type: "project", schema: 1, hlc: HLC_A })).toBeNull()
    })
})

describe("parseRegistry", () => {
    it("accepts valid registries and skips malformed devices", () => {
        const registry = parseRegistry({ version: 1, devices: [{ deviceId: "A", addedAt: 1, lastSeenAt: 2 }, { nope: true }, null] })
        expect(registry?.devices.map((device) => device.deviceId)).toEqual(["A"])
    })

    it("rejects unknown versions (forward compat: never overwrite a newer format)", () => {
        expect(parseRegistry({ version: 2, devices: [] })).toBeNull()
    })
})
