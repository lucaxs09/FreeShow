import axios from "axios"
import fs from "fs"
import { join } from "path"
import { ToMain } from "../../types/IPC/ToMain"
import type { ChurchAppsProvider } from "../contentProviders"
import { ContentProviderRegistry } from "../contentProviders"
import { sendToMain } from "../IPC/main"
import { httpsRequest } from "../utils/requests"
import { getContentProviderAccess } from "../data/contentProviders"

const CONTENT_HOSTNAME = "https://content.churchapps.org"
const HOSTNAME = "https://api.churchapps.org"
const SCOPE = "plans"
const ZIP_TYPE = "application/zip"

class ChurchAppsSyncManager {
    private static offlineAlerted = false;
    provider: ChurchAppsProvider

    constructor(provider: ChurchAppsProvider) {
        this.provider = provider
    }

    async hasValidConnection() {
        if (!getContentProviderAccess("churchApps", SCOPE)) return false
        await this.provider.connect(SCOPE)
        return this.provider.isConnected(SCOPE)
    }

    async getTeams(): Promise<{ id: string; churchId: string; name: string }[]> {
        const response = await this.provider.apiRequest({ api: "membership", authenticated: true, scope: SCOPE, endpoint: "/groups/my/team" })
        return response || []
    }

    async existingData(churchId: string, teamId: string) {
        const headers = await this.getHeaders(churchId, teamId)
        this.isCloudNewer(headers) // update changedAt
        return !!headers
    }

    async hasChanged(churchId: string, teamId: string) {
        const headers = await this.getHeaders(churchId, teamId)
        return this.isCloudNewer(headers)
    }

    private changedAt = 0
    private isCloudNewer(headers: any): boolean {
        if (!headers) return false

        const remoteLastModified = new Date(headers["last-modified"]).getTime()
        const localLastModified = this.changedAt

        this.changedAt = remoteLastModified
        return remoteLastModified > localLastModified
    }

    // Simple HTTP GET to content S3 web server.  No auth needed.
    private async getHeaders(churchId: string, teamId: string, fileName = "current.zip"): Promise<any> {
        const path = `/${churchId}/files/group/${teamId}/${fileName}`
        console.log("Checking data...")

        return new Promise((resolve) => {
            httpsRequest(CONTENT_HOSTNAME, path, "GET", {}, {}, response, "", true)

            function response(err: any, data?: any) {
                if (err) {
                    // not existing
                    if (err.statusCode === 404 || err.statusCode === 403) return resolve(null)
                    console.error("Failed to get headers:", err)
                    return resolve(null)
                }

                return resolve(data)
            }
        })
    }

    // Fetch from S3 content server. No auth needed.
    async getData(churchId: string, teamId: string, outputFolderPath: string, fileName = "current.zip"): Promise<string | null> {
        const randomNumber = Math.floor(Math.random() * 1000000)
        const path = `/${churchId}/files/group/${teamId}/${fileName}?cacheBuster=${randomNumber}`
        console.log("Downloading data...")

        return new Promise((resolve) => {
            httpsRequest(CONTENT_HOSTNAME, path, "GET", {}, {}, response, join(outputFolderPath, fileName))

            function response(err: any, filePath?: string) {
                if (err) {
                    // likely not existing yet
                    if (err.statusCode === 404 || err.statusCode === 403) return resolve(null)

                    // likely offline
                    if (err.code === "ENOTFOUND") {
                        ChurchAppsSyncManager.isOffline()
                        return resolve(null);
                    }

                    console.error("Failed to fetch content:", err)
                    if (fileName !== "current.zip") return resolve(null)

                    sendToMain(ToMain.ALERT, "Failed to get data: " + err.message)
                    return resolve(null)
                }

                // Reset offline alert state if successful
                ChurchAppsSyncManager.offlineAlerted = false;
                return resolve(filePath || null)
            }
        })
    }

    async getWriteToken(teamId: string, fileName: string): Promise<any> {
        const path = `/content/files/postUrl`
        const params: { [key: string]: string } = { fileName, contentType: "group", contentId: teamId }

        const token = await this.provider.getToken(SCOPE)
        const headers = token ? { Authorization: `Bearer ${token}` } : {}

        return new Promise((resolve) => {
            httpsRequest(HOSTNAME, path, "POST", headers, params, (err, data: Buffer) => {
                if (err) {
                    console.error("Failed to get token:", err)
                    if (fileName !== "current.zip") return resolve(null)

                    // likely offline
                    if (err.code === "ENOTFOUND") {
                        ChurchAppsSyncManager.isOffline()
                        return resolve(null);
                    }

                    if (err.statusCode === 401) sendToMain(ToMain.ALERT, "Could not upload data. Make sure you are member of a team, then log out and back in.")
                    else sendToMain(ToMain.ALERT, "Failed to upload data: " + err.message)

                    return resolve(null)
                }

                // Reset offline alert state if successful
                ChurchAppsSyncManager.offlineAlerted = false;
                return resolve(data)
            })
        })
    }

    private static isOffline(){
        if (ChurchAppsSyncManager.offlineAlerted) return
        ChurchAppsSyncManager.offlineAlerted = true;
        sendToMain(ToMain.ALERT, "Offline: Data will not be synced to the cloud.");
    }

    async uploadData(teamId: string, filePath: string, fileName = "current.zip"): Promise<boolean> {
        // get the token BEFORE reading the file (matches the pre-refactor behavior: no token → false, without touching the file)
        const presigned = await this.getWriteToken(teamId, fileName)
        if (!presigned?.url) return false

        const fileBuffer = await fs.promises.readFile(filePath)
        return await this.postToPresignedUrl(presigned, fileName, fileBuffer, ZIP_TYPE)
    }

    private async uploadFileBuffer(teamId: string, fileName: string, fileBuffer: Buffer, mimeType: string): Promise<boolean> {
        const presigned = await this.getWriteToken(teamId, fileName)
        if (!presigned?.url) return false

        return await this.postToPresignedUrl(presigned, fileName, fileBuffer, mimeType)
    }

    private async postToPresignedUrl(presigned: any, fileName: string, fileBuffer: Buffer, mimeType: string): Promise<boolean> {
        const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType })

        const formData = new FormData()
        formData.append("acl", "public-read")
        formData.append("Content-Type", mimeType)

        // Loop through all the presigned parameters returned and append them to this request
        for (const property in presigned.fields) formData.append(property, presigned.fields[property])

        console.log("Uploading data...")
        formData.append("file", blob, fileName)
        await axios.post(presigned.url, formData, { headers: { "Content-Type": "multipart/form-data" } })

        return true
    }

    // ----- sync v2 (per-device journal) transport: small JSON files with flat names -----

    // GET a JSON file from the public content store, distinguishing "not found" (a valid state:
    // the device/team simply hasn't published it yet) from transient errors (which must NEVER be
    // treated as "no data" — see the v1 lesson where a failed GET triggered a full re-upload).
    // 403 is mapped to "not_found" like v1's getData does: this S3 setup answers 403 (AccessDenied,
    // no ListBucket) for missing keys, which we confirmed empirically. A transient 403 on an
    // EXISTING file is therefore misread as missing — harmless for journals/items (their owner is
    // the only writer, nothing is overwritten) and self-healing for the registry (it is merged
    // with the locally cached copy, and every device re-adds itself on its next sync).
    async getJsonFile(churchId: string, teamId: string, fileName: string): Promise<{ status: "ok"; data: unknown } | { status: "not_found" } | { status: "error" }> {
        const cacheBuster = Date.now() + "" + Math.floor(Math.random() * 1000000)
        const path = `/${churchId}/files/group/${teamId}/${fileName}?cacheBuster=${cacheBuster}`

        return new Promise((resolve) => {
            httpsRequest(CONTENT_HOSTNAME, path, "GET", {}, {}, (err: any, data?: unknown) => {
                if (err) {
                    if (err.statusCode === 404 || err.statusCode === 403) return resolve({ status: "not_found" })

                    // likely offline: alert once (like v1), and report a transient error so the
                    // caller never mistakes it for "no data"
                    if (err.code === "ENOTFOUND") {
                        ChurchAppsSyncManager.isOffline()
                        return resolve({ status: "error" })
                    }

                    console.error("Sync v2: failed to fetch", fileName, err?.message || err)
                    return resolve({ status: "error" })
                }

                // Reset offline alert state if successful
                ChurchAppsSyncManager.offlineAlerted = false
                return resolve({ status: "ok", data })
            })
        })
    }

    async uploadJsonFile(teamId: string, fileName: string, content: string): Promise<boolean> {
        try {
            return await this.uploadFileBuffer(teamId, fileName, Buffer.from(content, "utf8"), "application/json")
        } catch (err) {
            console.error("Sync v2: failed to upload", fileName, err)
            return false
        }
    }

    // BACKUP

    async getBackup(churchId: string, teamId: string, outputFolderPath: string): Promise<string | null> {
        return await this.getData(churchId, teamId, outputFolderPath, "previous.zip")
    }

    async uploadBackup(teamId: string, filePath: string): Promise<boolean> {
        return await this.uploadData(teamId, filePath, "previous.zip")
    }
}

let syncManager: ChurchAppsSyncManager | null = null
export function getChurchAppsSyncManager() {
    if (syncManager) return syncManager

    const provider = ContentProviderRegistry.getProvider<ChurchAppsProvider>("churchApps")
    if (!provider) return null

    syncManager = new ChurchAppsSyncManager(provider)
    return syncManager
}
