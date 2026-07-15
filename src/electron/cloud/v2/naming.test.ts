import path from "path"
import { describe, expect, it } from "vitest"
import { decodeSegment, encodeSegment, itemFileName, journalFileName, registryFileName } from "./naming"

// simulates the backend's file-name hardening (FileController.getUploadUrl)
function backendSafeName(fileName: string): string {
    return path.basename(fileName).replace(/\.\.+/g, ".")
}

describe("naming — segment encoding", () => {
    it("keeps safe characters readable", () => {
        expect(encodeSegment("abc-XYZ-123")).toBe("abc-XYZ-123")
    })

    it("round-trips unsafe characters (separator, dots, slashes, unicode, tilde)", () => {
        for (const value of ["a_b", "a.b", "a/b", "a\\b", "año.canción", "~tilde~", "..", "café/../x_y"]) {
            expect(decodeSegment(encodeSegment(value))).toBe(value)
        }
    })

    it("never emits the separator, slashes or dots", () => {
        const encoded = encodeSegment("a_b/c.d\\e..f")
        expect(encoded).not.toMatch(/[_/\\.]/)
    })

    it("is injective for tricky pairs", () => {
        expect(encodeSegment("a_b")).not.toBe(encodeSegment("a~5fb"))
        expect(encodeSegment("a.b")).not.toBe(encodeSegment("a b"))
    })
})

describe("naming — flat file names survive the backend hardening untouched", () => {
    it("registry / journal / item names are their own basename with no '..'", () => {
        const names = [registryFileName(), journalFileName("dev_1.local"), itemFileName("dev_1.local", "settings-scriptures", "id.with.dots_and_underscores")]
        for (const name of names) {
            expect(backendSafeName(name)).toBe(name) // nothing stripped or collapsed
            expect(name).not.toContain("/")
            expect(name).not.toContain("..")
        }
    })

    it("two different (device, type, id) tuples never collide on the same file name", () => {
        // underscore inside segments must not be confusable with the separator
        const a = itemFileName("dev", "type_x", "id")
        const b = itemFileName("dev", "type", "x_id")
        expect(a).not.toBe(b)

        const c = itemFileName("dev_a", "b", "id")
        const d = itemFileName("dev", "a_b", "id")
        expect(c).not.toBe(d)
    })
})
