// ----- FreeShow -----
// Sync v2: flat file-name convention for the ChurchApps content store.
//
// Pure module (no I/O, no Electron). The backend hardens uploaded file names with
// `path.basename(fileName).replace(/\.\.+/g, ".")`, so nested paths are NOT possible: any "/"
// is stripped and ".." sequences are collapsed. The per-device namespace is therefore encoded
// into FLAT names, with "_" as the separator:
//   v2_registry.json
//   v2_dev_<deviceId>_journal.json
//   v2_dev_<deviceId>_item_<type>_<id>.json
// Segments are escaped so they can never contain "_", "/", "." or any other unsafe character —
// which keeps the naming injective (no two different (device, type, id) map to the same name)
// and immune to the backend's basename/".." normalization.

const SAFE_CHAR = /^[a-zA-Z0-9-]$/

// escape every char outside [a-zA-Z0-9-] as "~" + 2-digit hex per UTF-8 byte ("~" itself included)
export function encodeSegment(value: string): string {
    let out = ""
    for (const char of value) {
        if (SAFE_CHAR.test(char)) {
            out += char
            continue
        }
        const bytes = Buffer.from(char, "utf8")
        for (const byte of bytes) out += "~" + byte.toString(16).padStart(2, "0")
    }
    return out
}

// exact inverse of encodeSegment. Not used by the sync flow itself (names are only ever built,
// never parsed back) — kept so tests can verify the encoding round-trips and stays injective
export function decodeSegment(encoded: string): string {
    const bytes: number[] = []
    for (let i = 0; i < encoded.length; i++) {
        const char = encoded[i]
        if (char !== "~") {
            bytes.push(char.charCodeAt(0))
            continue
        }
        bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16))
        i += 2
    }
    return Buffer.from(bytes).toString("utf8")
}

export function registryFileName(): string {
    return "v2_registry.json"
}

export function journalFileName(deviceId: string): string {
    return `v2_dev_${encodeSegment(deviceId)}_journal.json`
}

export function itemFileName(deviceId: string, type: string, id: string): string {
    return `v2_dev_${encodeSegment(deviceId)}_item_${encodeSegment(type)}_${encodeSegment(id)}.json`
}
