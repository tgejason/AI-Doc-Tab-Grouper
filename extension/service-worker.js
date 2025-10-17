// --- service-worker.js (Integrated Final Version) ---

// 🛑 NEW: Import the Enterprise functions from the separate module
import { getEnterpriseId } from './enterprise-functions.js';


// --- Configuration & Utilities ---
const CLOUD_RUN_ENDPOINT = "https://ai-tab-grouper-backend-204479413902.us-central1.run.app/group"; 
let isProcessing = false; // Race Condition Lock

const DOCUMENT_URL_PATTERNS = [
    "*://docs.google.com/*",
    "*://*.office.com/*",    
    "*://*.sharepoint.com/*",
    "*://github.com/*/*/*",  // Correct pattern used
    "*://*.atlassian.net/*", 
    "*://*.figma.com/file/*",
    "*://*.miro.com/app/*",  
    "*://mail.google.com/*", 
    "*://*.notion.so/*"      
];

// Centralized Logging Configuration
const LOG_LEVEL = "DEV"; 

const Logger = {
    log: (message, ...data) => {
        if (LOG_LEVEL === "DEV") {
            console.log(`[AI-Grouper] INFO: ${message}`, ...data);
        }
    },
    warn: (message, ...data) => {
        if (LOG_LEVEL === "DEV") {
            console.warn(`[AI-Grouper] WARN: ${message}`, ...data);
        }
    },
    error: (message, ...data) => {
        console.error(`[AI-Grouper] 🛑 CRITICAL ERROR: ${message}`, ...data);
    }
};

// Key: Tab ID, Value: { id, title, url, snippet, status, platform: {os, arch} }
const tabProcessingStatus = {}; 

// Define the maximum time to wait for content scripts to respond (6 seconds)
const STALENESS_TIMEOUT_MS = 420000; 

// Define the minimum number of successfully extracted tabs required for grouping
const MIN_TABS_FOR_AI_PROCESSING = 2; 

// Redshift Priority Map (High to Low Priority)
const PRIORITY_COLOR_MAP = {
    1: 'red',
    2: 'orange',
    3: 'yellow',
    4: 'green',
    5: 'blue',
    6: 'purple',
    7: 'pink',
    8: 'cyan',
};

function getRandomColor() {
    const colors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]; 
    return colors[Math.floor(Math.random() * colors.length)];
}

function updateBadgeStatus(text, color) {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
}

function clearTransientStatus(titlex) {
    updateBadgeStatus('', '');
    chrome.action.setTitle({ title: titlex }); // Reset to the default title from manifest
}

let loadingAnimationTimer;

// Function to start the loading animation
function startLoadingAnimation(frames, interval) {
    let frameIndex = 0;
    
    if (loadingAnimationTimer) clearInterval(loadingAnimationTimer);

    loadingAnimationTimer = setInterval(() => {
        const text = frames[frameIndex % frames.length];
        chrome.action.setBadgeText({ text: text });
        chrome.action.setBadgeBackgroundColor({ color: '#FFC107' }); // Orange: Busy but stable
        frameIndex++;
    }, interval);
}

function stopLoadingAnimation(finalText = '', finalColor = '') {
    if (loadingAnimationTimer) {
        clearInterval(loadingAnimationTimer);
        loadingAnimationTimer = null;
    }
    updateBadgeStatus(finalText, finalColor);
}

/**
 * Transforms sensitive platform data into high-level, masked context for the LLM.
 * @param {Object} platformInfo - The raw platform object ({os, arch}).
 * @returns {string} - A masked, descriptive string for the LLM prompt.
 */
function maskAndContextualizePlatformData(platformInfo) {
    const os = platformInfo.os.toLowerCase();
    const arch = platformInfo.arch.toLowerCase();

    let context = "";

    // Tier 1: High-Value Contextual Masking (Primary Workstation)
    if (os.includes('mac')) {
        context = `Workstation (MacOS, Arch: ${arch})`;
    } else if (os.includes('win')) {
        context = `Workstation (Windows, Arch: ${arch})`;
    } else if (os.includes('linux')) {
        context = `Workstation (Linux, Arch: ${arch})`;
    } 
    // Tier 2: Lower/Mobile Context
    else if (os.includes('android')) {
        context = "Mobile/Android Context";
    } else if (os.includes('cros')) {
        context = "Lightweight/ChromeOS Context";
    } 
    // Default Mask
    else {
        context = "General Desktop Environment";
    }
    
    return context;
}

function isDocumentTab(url) {
    // The preferred URLPattern method from the second block is used for modern service workers.
    try {
        for (const pattern of DOCUMENT_URL_PATTERNS) {
            // Note: URLPattern is available in Manifest V3 service workers
            if (new URLPattern(pattern).test(url)) {
                return true;
            }
        }
    } catch (e) {
        // Fallback for extreme compatibility issues (should not happen in MV3)
        return DOCUMENT_URL_PATTERNS.some(pattern => url.match(new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'))));
    }
    return false;
}

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content-script.js']
        });
        Logger.log(`Content script injected successfully into tab ${tabId}.`);
    } catch (error) {
        Logger.warn(`Failed to inject content script into tab ${tabId}: ${error.message}`);
        // Mark as FAILED so it doesn't hold up processing
        tabProcessingStatus[tabId].status = "INJECTION_FAILED";
        // Do not call checkAndProcessAllTabs here, it's called at the end of the timeout.
    }
}

/**
 * Proactively forces content script execution in background tabs using a highlight/unhighlight trick.
 */
async function pokingTabsForExecution(relevantTabs) {
    const activeTabId = relevantTabs.find(tab => tab.active)?.id;
    
    const backgroundTabsToPoke = activeTabId 
        ? relevantTabs.filter(tab => tab.id !== activeTabId) 
        : relevantTabs; 

    if (backgroundTabsToPoke.length === 0) {
        Logger.log("No background tabs to poke.");
        return;
    }

    Logger.log(`Proactively poking ${backgroundTabsToPoke.length} background tabs to force content script execution.`);

    for (const tab of backgroundTabsToPoke) {
        try {
            // Briefly highlight/unhighlight to force content script execution
            await chrome.tabs.update(tab.id, { highlighted: true });
            await new Promise(resolve => setTimeout(resolve, 0.1)); 
            await chrome.tabs.update(tab.id, { highlighted: false });

        } catch (error) {
            // Tab might be gone. That's fine.
            Logger.warn(`Failed to poke or un-poke tab ${tab.id}:`, error.message);
        }
    }
}

// --- Event Listeners ---

// Listener for content script messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    if (message.action === "GROUP_TAB_DATA") {
        const tab = tabProcessingStatus[tabId];

        if (tab && tab.status === "INJECTED_WAITING_FOR_DATA") {
            // Update status with collected data
            tab.snippet = message.data.snippet; 
            tab.status = "DATA_RECEIVED_READY_TO_GROUP";
            Logger.log(`Data received for tab ${tabId}: ${tab.title}. Ready to process.`);
            
            // Fast Path: Check immediately if processing can start
            checkAndProcessAllTabs();
        } else {
            Logger.warn(`Received unexpected data for tab ${tabId}. Status was: ${tab?.status}`);
        }
    } else if (message.action === "GROUP_TAB_DATA_ERROR") {
        if (tabProcessingStatus[tabId]) {
            tabProcessingStatus[tabId].status = "DATA_ERROR";
            tabProcessingStatus[tabId].message = message.data.message || "Unknown Error";
            Logger.warn(`Data error for tab ${tabId}. Status set to DATA_ERROR.`);
            stopLoadingAnimation('ERR4', '#C62828')
            const titlex = `Data error for tab ${tabId}. Status set to DATA_ERROR.`
            clearTransientStatus(titlex)
            stopLoadingAnimation(`ERR4:`, '#C62828')
            
            // Fast Path: Check immediately if processing can start despite this error
            checkAndProcessAllTabs();
        }
    }
});

// --- Core Logic Functions ---

// NOTE: This now only accepts the data array, which is pre-enriched by the caller
async function sendDataToCloudRun(tabData) { 
    if (!tabData || tabData.length === 0) {
        Logger.warn("Attempted to send empty data to Cloud Run. Aborting.");
        return null;
    }
    
    // The payload is now just the tabData array with embedded enterprise/platform info.
    const payload = tabData; 

    // NOTE: Logging the data structure that is actually sent (the array root)
    Logger.log("Sending data to Cloud Run (Array Root):", payload);

    const url = CLOUD_RUN_ENDPOINT;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload) // Send the array directly
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        Logger.log("Cloud Run response received:", result);
        return result.groups || [];

    } catch (error) {
        // This is a CRITICAL ERROR for the user. We only use 🛑 for truly unrecoverable errors.
        Logger.error("Failed to call Cloud Run endpoint.", error);
        return null;
    }
}


async function applyTabGroups(groups) { 
    let successfulGroups = 0;
    for (const group of groups) { 
        const tabIdsToGroup = group.tab_titles
            .map(title => Object.values(tabProcessingStatus).find(tab => tab.title === title)?.id)
            .filter(id => id !== undefined); 
        
        // Determine color based on priority from the LLM result.
        const groupColor = PRIORITY_COLOR_MAP[group.priority] || getRandomColor();
        
        // Use the combined title/rationale for the group's title/tooltip (as requested by the user's second code block).
        const groupTitle = `${group.group_name}: ${group.rationale}`;

        if (tabIdsToGroup.length > 1) {
            try {
                const tabs = await Promise.all(tabIdsToGroup.map(id => chrome.tabs.get(id)));
                const firstTabWindowId = tabs[0].windowId;
                if (!tabs.every(tab => tab.windowId === firstTabWindowId)) { continue; }
                const window = await chrome.windows.get(firstTabWindowId);
                if (window.type !== 'normal') { continue; }

                const groupId = await chrome.tabs.group({ tabIds: tabIdsToGroup, createProperties: { windowId: firstTabWindowId } });
                await chrome.tabGroups.update(groupId, {
                    title: groupTitle, 
                    color: groupColor 
                });
                Logger.log(`Group created: ${group.group_name} (Priority ${group.priority})`); 
                successfulGroups++;    
            } 
            catch (error) {
                Logger.warn(`Error during tab grouping for '${group.group_name}':`, error.message);
            }
        }
    }
    
    // UX Polish: Clear the badge and show success/failure
    if (successfulGroups > 0) {
        updateBadgeStatus(String(successfulGroups), '#4CAF50'); // Green for success
        stopLoadingAnimation(successfulGroups.toString(), '#5C6BC0'); // Final Success
        chrome.action.setTitle({ title: "AI Group Tabs" });
        updateBadgeStatus(String(successfulGroups), '#4CAF50'); // Green for success
        await removeEmptyGroups(); // Clean up old, now-empty groups
    } else {
        updateBadgeStatus('None', '#F44336'); // Red for no groups created
        stopLoadingAnimation('', ''); // Clear if zero groups
        chrome.action.setTitle({ title: "None AI Group Tabs" });
    }

    setTimeout(() => updateBadgeStatus('', ''), 69000);
    // Release lock only after grouping is complete
    isProcessing = false; 
}


async function removeEmptyGroups() {
    try {
        const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        for (const group of groups) {
            const tabs = await chrome.tabs.query({ groupId: group.id });
            if (tabs.length === 0) {
                // Remove the empty group
                await chrome.tabGroups.remove(group.id);
                Logger.log(`Successfully removed empty group: ${group.id}`);
            }
        }
    } catch (error) {
        Logger.error("Error during empty group cleanup:", error);
    }
}


// Check and process only if all relevant tabs have finished injecting/gathering data
async function checkAndProcessAllTabs() {
    // If not processing, or if this function was triggered by a message but processing isn't locked, return.
    if (!isProcessing) return; 

    const relevantTabs = Object.values(tabProcessingStatus).filter(tab => isDocumentTab(tab.url));
    
    // Only proceed if ALL relevant tabs have a final state (Data Received OR Error/Failure)
    const pendingTabs = relevantTabs.filter(tab => 
        tab.status === "INJECTED_WAITING_FOR_DATA" || tab.status === "INITIAL_PENDING_INJECTION"
    );

    if (pendingTabs.length === 0) {
        Logger.log("All relevant tabs have returned data or failed. Proceeding to Cloud Run call.");
        
        const tabData = relevantTabs.filter(tab => tab.status === "DATA_RECEIVED_READY_TO_GROUP");
        
        if (tabData.length < MIN_TABS_FOR_AI_PROCESSING) {
            Logger.warn(`Aborting AI call. Only ${tabData.length} tabs succeeded. Minimum required: ${MIN_TABS_FOR_AI_PROCESSING}.`);
            // updateBadgeStatus('Min', '#F44336');
            const titlex = `AI-Grouper ERR2: Aborting AI call. Only ${tabData.length} tabs succeeded. Need ${MIN_TABS_FOR_AI_PROCESSING} documents to group.` 
            
            clearTransientStatus(titlex)
            stopLoadingAnimation(`ERR2:`, '#C62828')
            //setTimeout(() => updateBadgeStatus('', ''), 4000);
            isProcessing = false;
            return;
        }

        // 💡 START DYNAMIC ANIMATION
        startLoadingAnimation(['AI', 'AI.', 'AI..', 'AI...'], 400);
        
        // 🛑 FIX: Fetch platform info here in the Service Worker context
        chrome.runtime.getPlatformInfo(async (platformInfo) => {

            // 1. Get Enterprise ID and masked context once
            const enterpriseId = await getEnterpriseId(Logger);
            const maskedPlatformContext = maskAndContextualizePlatformData(platformInfo);

            // 2. Inject context into the tabData array before sending
            const enrichedTabData = tabData.map(tab => ({
                ...tab,
                // Embed the context into the tab object itself
                platform_context: maskedPlatformContext, 
                enterprise_id: enterpriseId              
            }));

            // 3. Call server with the array, not the top-level object
            // NOTE: Removed platformInfo argument from the call
            const groups = await sendDataToCloudRun(enrichedTabData);


            
            if (groups) {
                Logger.log(`Applying ${groups.length} groups.`);
                await applyTabGroups(groups);
            } else {
                Logger.error("Cloud Run returned null groups.");
                updateBadgeStatus('Fail', '#F44336');
                stopLoadingAnimation('Fail', '#F44336');
                //setTimeout(() => updateBadgeStatus('', ''), 4000);
                isProcessing = false;
            }
        });
    } else {
        Logger.log(`Waiting for ${pendingTabs.length} tabs to return data.`);
    }
}


async function prepareTabsForInjection(relevantTabs) {
    const injectionPromises = [];

    // Clear statuses of tabs not currently in the window or no longer relevant
    Object.keys(tabProcessingStatus).forEach(id => {
        const tabId = parseInt(id, 10);
        if (!relevantTabs.some(tab => tab.id === tabId)) {
            delete tabProcessingStatus[tabId];
        }
    });

    // Iterate over relevant tabs and initiate injection in parallel
    for (const tab of relevantTabs) {
        // Reset status for this tab
        tabProcessingStatus[tab.id] = { 
            id: tab.id, 
            url: tab.url, 
            title: tab.title, 
            status: "INJECTED_WAITING_FOR_DATA" // Set to a pending state
        };
        Logger.log(`Setting status for tab ${tab.id} to INJECTED_WAITING_FOR_DATA`);
        injectionPromises.push(injectContentScript(tab.id));
    }

    // 🛑 Integrated Fix: Proactively ping background tabs to force content script execution
    await pokingTabsForExecution(relevantTabs);

    // Wait for all injections to complete (or fail) using Promise.allSettled
    await Promise.allSettled(injectionPromises);

    // Now that all injections are initiated, schedule the final, guaranteed check using the timeout.
    setTimeout(() => {
        Logger.log(`Staleness monitor triggered. Forcing final check after ${STALENESS_TIMEOUT_MS}ms.`);
        // Mark any remaining INJECTED_WAITING_FOR_DATA as ERROR_TIMEOUT
        Object.values(tabProcessingStatus).forEach(tab => {
            if (tab.status === "INJECTED_WAITING_FOR_DATA") {
                 tab.status = "ERROR_TIMEOUT";
                 tab.message = `Content script did not respond within ${STALENESS_TIMEOUT_MS}ms.`;
            }
        });
        checkAndProcessAllTabs();
    }, STALENESS_TIMEOUT_MS); 
}

// Function to orchestrate the entire grouping process
async function startGroupingProcess() {
    if (isProcessing) {
        Logger.warn("Processing is already underway. Skipping click.");
        return;
    }
    isProcessing = true;
    updateBadgeStatus('...', '#FFC107'); // Amber/Yellow for start
    
    Logger.log("Starting grouping process...");
    
    await removeEmptyGroups();  // Clean up before starting

    // 1. Get all relevant tabs and reset state
    const tabs = await chrome.tabs.query({ currentWindow: true, windowType: 'normal' });
    const relevantTabs = tabs.filter(tab => isDocumentTab(tab.url));
    
    if (relevantTabs.length < MIN_TABS_FOR_AI_PROCESSING) {
        updateBadgeStatus('Min', '#F44336');
        updateBadgeStatus('ERR2', '#C62828');
        
        //setTimeout(() => updateBadgeStatus('', ''), 4000);
        isProcessing = false;
        Logger.log(`Not enough relevant tabs (found ${relevantTabs.length}). Aborting.`);      
        const titlex = `AI-Grouper ERR2: Need ${MIN_TABS_FOR_AI_PROCESSING} documents to group.` 
        
        clearTransientStatus(titlex)
        stopLoadingAnimation(`ERR2:`, '#C62828')
        return;
    }

    // 2. Inject content scripts to gather data and set up timeout checks
    await prepareTabsForInjection(relevantTabs);

    // The rest of the execution is handled by the timeout or by the message listener 
    // calling checkAndProcessAllTabs().
}

// Listen for clicks on the extension icon
chrome.action.onClicked.addListener(async () => {
    // 💡 IMMEDIATE FEEDBACK: Show the user something is happening right now!
    updateBadgeStatus('...', '#FFC107'); // Yellow/Amber for start
    
    // Now, kick off the long-running process
    await startGroupingProcess(); 
});


// Initial check on extension load to populate the status object
chrome.tabs.query({ currentWindow: true, windowType: 'normal' }).then(tabs => {
    tabs.forEach(tab => {
        if (isDocumentTab(tab.url)) {
            if (!tabProcessingStatus[tab.id]) {
                tabProcessingStatus[tab.id] = { id: tab.id, url: tab.url, title: tab.title, status: "INITIAL_PENDING_INJECTION" };
            }
        }
    });
    Logger.log("Extension loaded. Initial tab status populated.");
});
