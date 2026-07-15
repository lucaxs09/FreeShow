import { describe, expect, it } from "vitest"
import { hlcCompare, hlcDeviceId, hlcFromParts, hlcMax, hlcTick, hlcWallMs, parseHlc } from "./hlc"

const T = 1750000000000 // fixed wall time

describe("HLC — format & parse", () => {
    it("round-trips parts through format/parse", () => {
        const hlc = hlcFromParts(T, 5, "device-1")
        expect(parseHlc(hlc)).toEqual({ wallMs: T, counter: 5, deviceId: "device-1" })
    })

    it("keeps deviceIds containing dots intact (positional parse)", () => {
        const hlc = hlcFromParts(T, 0, "a.b.c")
        expect(hlcDeviceId(hlc)).toBe("a.b.c")
        expect(hlcWallMs(hlc)).toBe(T)
    })

    it("rejects garbage", () => {
        expect(parseHlc("")).toBeNull()
        expect(parseHlc("not-an-hlc")).toBeNull()
        expect(parseHlc("0000000000000x.0000.dev")).toBeNull()
    })
})

describe("HLC — total order", () => {
    it("orders by wall time first", () => {
        expect(hlcCompare(hlcFromParts(T, 9, "z"), hlcFromParts(T + 1, 0, "a"))).toBeLessThan(0)
    })

    it("orders by counter when wall time ties", () => {
        expect(hlcCompare(hlcFromParts(T, 1, "z"), hlcFromParts(T, 2, "a"))).toBeLessThan(0)
    })

    it("breaks full ties deterministically by deviceId", () => {
        expect(hlcCompare(hlcFromParts(T, 1, "a"), hlcFromParts(T, 1, "b"))).toBeLessThan(0)
        expect(hlcCompare(hlcFromParts(T, 1, "b"), hlcFromParts(T, 1, "b"))).toBe(0)
    })

    it("a valid clock always beats garbage", () => {
        expect(hlcCompare(hlcFromParts(T, 0, "a"), "garbage")).toBeGreaterThan(0)
        expect(hlcCompare("garbage", hlcFromParts(T, 0, "a"))).toBeLessThan(0)
    })

    it("hlcMax handles nulls", () => {
        const a = hlcFromParts(T, 0, "a")
        expect(hlcMax(null, a)).toBe(a)
        expect(hlcMax(a, null)).toBe(a)
        expect(hlcMax(null, null)).toBeNull()
    })
})

describe("HLC — tick (monotonic even with clock skew)", () => {
    it("uses the wall clock when it advanced", () => {
        const prev = hlcFromParts(T, 3, "dev")
        expect(parseHlc(hlcTick(prev, T + 10, "dev"))).toEqual({ wallMs: T + 10, counter: 0, deviceId: "dev" })
    })

    it("bumps the counter when the wall clock did not advance", () => {
        const prev = hlcFromParts(T, 3, "dev")
        expect(parseHlc(hlcTick(prev, T, "dev"))).toEqual({ wallMs: T, counter: 4, deviceId: "dev" })
    })

    it("never goes backwards when the wall clock does (skew)", () => {
        const prev = hlcFromParts(T, 0, "dev")
        const next = hlcTick(prev, T - 60000, "dev") // clock jumped back a minute
        expect(hlcCompare(next, prev)).toBeGreaterThan(0)
    })

    it("rolls the wall ms over on counter overflow", () => {
        const prev = hlcFromParts(T, 36 ** 4 - 1, "dev")
        expect(parseHlc(hlcTick(prev, T, "dev"))).toEqual({ wallMs: T + 1, counter: 0, deviceId: "dev" })
    })

    it("a sequence of ticks is strictly increasing", () => {
        let last: string | null = null
        const seen: string[] = []
        for (let i = 0; i < 50; i++) {
            last = hlcTick(last, T, "dev")
            seen.push(last)
        }
        for (let i = 1; i < seen.length; i++) expect(hlcCompare(seen[i], seen[i - 1])).toBeGreaterThan(0)
    })
})
