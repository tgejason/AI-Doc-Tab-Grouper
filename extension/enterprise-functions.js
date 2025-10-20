// enterprise-functions.js

/**
 * Key used to store the persistent Enterprise ID in Chrome's local storage.
 * This ID is used for multi-tenancy and data segmentation on the backend.
 */
export const ENTERPRISE_ID_STORAGE_KEY = 'ai_grouper_enterprise_id';

/**
 * Retrieves the persistent Enterprise ID from local storage or generates a new one.
 * * @param {Object} Logger - The centralized logging utility imported from the main service worker.
 * @returns {Promise<string>} - The persistent, unique Enterprise ID.
 */
export async function getEnterpriseId(Logger) {
    try {
        // 1. Check storage for existing ID (chrome is globally available in service worker scope)
        const stored = await chrome.storage.local.get(ENTERPRISE_ID_STORAGE_KEY);
        let enterpriseId = stored[ENTERPRISE_ID_STORAGE_KEY];

        if (!enterpriseId) {
            // 2. If no ID, generate a cryptographically strong UUID (anonymized)
            // self.crypto.randomUUID() is standard in service workers
            enterpriseId = self.crypto.randomUUID(); 
            await chrome.storage.local.set({ [ENTERPRISE_ID_STORAGE_KEY]: enterpriseId });
            Logger.log("Generated new Enterprise ID for multi-tenancy:", enterpriseId);
        }
        return enterpriseId;
    } catch (error) {
        Logger.error("Failed to retrieve or generate Enterprise ID. Falling back to default.", error);
        return "DEFAULT_ID_ERROR_FALLBACK";
    }
}
