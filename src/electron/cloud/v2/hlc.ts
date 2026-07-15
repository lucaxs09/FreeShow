// ----- FreeShow -----
// Sync v2: Hybrid Logical Clock (HLC).
//
// Pure module (no I/O, no Electron). An HLC string gives every change a totally ordered,
// device-tagged version that never goes backwards, even with skewed wall clocks:
//   "<wallMs (14 digits)>.<counter (4 base36 chars)>.<deviceId>"
// The fixed-width numeric parts make parsing positional and comparison deterministic.

export interface HlcParts {
    wallMs: number
    counter: number
    deviceId: string
}

const WALL_DIGITS = 14
const COUNTER_CHARS = 4
const COUNTER_MAX = Math.pow(36, COUNTER_CHARS) - 1

export function hlcFromParts(wallMs: number, counter: number, deviceId: string): string {
    const wall = Math.max(0, Math.floor(wallMs))
    const count = Math.min(Math.max(0, Math.floor(counter)), COUNTER_MAX)
    return `${String(wall).padStart(WALL_DIGITS, "0")}.${count.toString(36).padStart(COUNTER_CHARS, "0")}.${deviceId}`
}

export function parseHlc(hlc: string): HlcParts | null {
    if (typeof hlc !== "string" || hlc.length < WALL_DIGITS + COUNTER_CHARS + 3) return null
    if (hlc[WALL_DIGITS] !== "." || hlc[WALL_DIGITS + 1 + COUNTER_CHARS] !== ".") return null

    const wallStr = hlc.slice(0, WALL_DIGITS)
    const counterStr = hlc.slice(WALL_DIGITS + 1, WALL_DIGITS + 1 + COUNTER_CHARS)
    const deviceId = hlc.slice(WALL_DIGITS + 1 + COUNTER_CHARS + 1)

    if (!/^\d+$/.test(wallStr) || !/^[0-9a-z]+$/.test(counterStr) || !deviceId) return null

    return { wallMs: parseInt(wallStr, 10), counter: parseInt(counterStr, 36), deviceId }
}

export function hlcWallMs(hlc: string): number {
    return parseHlc(hlc)?.wallMs ?? 0
}

export function hlcDeviceId(hlc: string): string {
    return parseHlc(hlc)?.deviceId ?? ""
}

// total order: wall time, then counter, then deviceId as the final deterministic tie-breaker
export function hlcCompare(a: string, b: string): number {
    const pa = parseHlc(a)
    const pb = parseHlc(b)
    // unparsable values sort lowest so a valid clock always wins over garbage
    if (!pa || !pb) return pa ? 1 : pb ? -1 : a < b ? -1 : a > b ? 1 : 0

    if (pa.wallMs !== pb.wallMs) return pa.wallMs < pb.wallMs ? -1 : 1
    if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1
    return pa.deviceId < pb.deviceId ? -1 : pa.deviceId > pb.deviceId ? 1 : 0
}

export function hlcMax(a: string | null, b: string | null): string | null {
    if (!a) return b
    if (!b) return a
    return hlcCompare(a, b) >= 0 ? a : b
}

// Advance the clock: strictly greater than everything seen so far (own ticks AND remote HLCs),
// regardless of the local wall clock (protects against clock skew going backwards).
export function hlcTick(lastSeen: string | null, wallMs: number, deviceId: string): string {
    const last = lastSeen ? parseHlc(lastSeen) : null
    const wall = Math.max(0, Math.floor(wallMs))

    if (!last || wall > last.wallMs) return hlcFromParts(wall, 0, deviceId)
    if (last.counter >= COUNTER_MAX) return hlcFromParts(last.wallMs + 1, 0, deviceId)
    return hlcFromParts(last.wallMs, last.counter + 1, deviceId)
}
