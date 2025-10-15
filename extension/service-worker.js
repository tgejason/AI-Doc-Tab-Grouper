// --- service-worker.js ---

// --- Configuration & Utilities ---
const CLOUD_RUN_ENDPOINT = "https://ai-tab-grouper-backend-204479413902.us-central1.run.app/group"; 
let isProcessing = false; // Race Condition Lock

const DOCUMENT_URL_PATTERNS = [
    "*://docs.google.com/*",
    "*://*.office.com/*",    
    "*://*.sharepoint.com/*",
    "*://github.com/*/*/*",  
    "*://*.atlassian.net/*", 
    "*://*.figma.com/file/*",
    "*://*.miro.com/app/*",  
    "*://mail.google.com/*", 
    "*://*.notion.so/*"      
];

// Centralized Logging Configuration (Your "Decorator" replacement)
const LOG_LEVEL = "DEV"; // Change to "PROD" to silence all non-CRITICAL logs

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
        // Future (Stage 3): Call a Cloud Function to log this error to BigQuery/Cloud Logging
    }
};

// Key: Tab ID, Value: { id, title, url, snippet, status }
const tabProcessingStatus = {};



// --- 1. Tab Filtering and Injection ---

function isDocumentTab(url) {
    return DOCUMENT_URL_PATTERNS.some(pattern => url.match(new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'))));
}

async function injectContentScript(tabId) {
    Logger.log(`Attempting to inject script into tab ${tabId}.`);
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content-script.js']
        });
        Logger.log(`Script injected successfully into tab ${tabId}.`);
    } catch (error) {
        Logger.warn(`Script injection failed for tab ${tabId}:`, error.message);
        tabProcessingStatus[tabId] = {
            id: tabId, 
            url: (await chrome.tabs.get(tabId)).url,
            title: (await chrome.tabs.get(tabId)).title,
            status: "ERROR_INJECTION",
            message: error.message.substring(0, 150)
        };
    }
}


// --- 2. Event Listeners ---

// Updates tab tracking on navigation completion
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && isDocumentTab(tab.url)) {
        await injectContentScript(tabId);
        tabProcessingStatus[tabId] = {
            id: tabId, 
            url: tab.url, 
            title: tab.title, 
            status: "INJECTED_WAITING_FOR_DATA"
        };
    }
});

// Listener for content script messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab.id;
    if (!tabId) return;

    if (message.action === "GROUP_TAB_DATA") {
        tabProcessingStatus[tabId] = { 
            ...tabProcessingStatus[tabId], 
            ...message.data, 
            status: "DATA_RECEIVED_READY_TO_GROUP" 
        };
        Logger.log(`Data received from tab ${tabId}: ${message.data.title}`);
    } else if (message.action === "GROUP_TAB_DATA_ERROR") {
        tabProcessingStatus[tabId] = { 
            ...tabProcessingStatus[tabId], 
            ...message.data, 
            status: "ERROR_CONTENT_SCRIPT"
        };
        Logger.warn(`Tab ${tabId} failed snippet extraction: ${message.data.message}`);
    }

    checkAndProcessAllTabs(); 
    
    return true; 
});


// --- 3. Grouping Orchestration (Concurrency Controlled) ---

async function checkAndProcessAllTabs() {
    // 🛑 CRITICAL RACE CONDITION CHECK
    if (isProcessing) {
        Logger.log("Processing is already underway. Aborting check.");
        return; 
    }
    
    const tabsInWindow = await chrome.tabs.query({ currentWindow: true, windowType: 'normal' });
    
    const relevantTabIds = tabsInWindow
        .filter(tab => isDocumentTab(tab.url) && tabProcessingStatus[tab.id])
        .map(tab => tab.id);

    Logger.log(`Found ${relevantTabIds.length} relevant tabs.`);

    const statuses = relevantTabIds.map(id => tabProcessingStatus[id].status);
    Logger.log("Statuses of relevant tabs:", statuses);

    // Check if ALL relevant tabs have a final, non-pending status
    const allProcessed = relevantTabIds.every(id => 
        tabProcessingStatus[id] && 
        (tabProcessingStatus[id].status.startsWith("DATA_RECEIVED") || tabProcessingStatus[id].status.startsWith("ERROR"))
    );

    Logger.log(`All processed check: ${allProcessed}`);
    
    if (allProcessed && relevantTabIds.length > 1) { 
        isProcessing = true; // Set lock before starting API call
        Logger.log(`Sending data to Cloud Run for processing: ${relevantTabIds.length} tabs.`);
        
        
        const tabDataArray = Object.values(tabProcessingStatus).filter(tab => relevantTabIds.includes(tab.id));
        const dataToSend = tabDataArray.filter(tab => tab.status === "DATA_RECEIVED_READY_TO_GROUP");
        
        try {
            if (dataToSend.length > 1) {
                await sendDataToCloudRun(dataToSend);
            } else {
                Logger.log("Not enough successfully extracted documents to form a group.");
            }
        } catch (e) {
             Logger.error("An unhandled error occurred during grouping:", e.message);
        }
        finally {
            isProcessing = false; // Release lock
        }
    }
}


// --- 4. Cloud Communication and Grouping ---

async function sendDataToCloudRun(tabData) {
    Logger.log("Sending data to Cloud Run for processing:", tabData.length, "tabs.");
    
    try {
        const response = await fetch(CLOUD_RUN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tabData)
        });

        if (!response.ok) {
            throw new Error(`Cloud Run HTTP error! Status: ${response.status}`);
        }

        const groupingResult = await response.json();
        Logger.log("Grouping result received:", groupingResult);
        
        applyTabGroups(groupingResult.groups);

    } catch (error) {
        Logger.error("Failed to communicate with Cloud Run or process AI response:", error.message);
        throw error; // Re-throw to be caught by the orchestrator's try/finally block
    }
}

async function applyTabGroups(groups) { // Make it async
    let successfulGroups = 0;
    for (const group of groups) { // Use for...of to allow await inside
        const tabIdsToGroup = group.tab_titles
            .map(title => Object.values(tabProcessingStatus).find(tab => tab.title === title)?.id)
            .filter(id => id !== undefined); 
        
        if (tabIdsToGroup.length > 1) {
            try {
                // Get details for all tabs to be grouped
                const tabs = await Promise.all(tabIdsToGroup.map(id => chrome.tabs.get(id)));

                // Robustness Check 1: All tabs must be in the same window.
                const firstTabWindowId = tabs[0].windowId;
                if (!tabs.every(tab => tab.windowId === firstTabWindowId)) {
                    Logger.warn(`Cannot create group '${group.group_name}' because tabs are in different windows.`);
                    continue; // Skip to the next group
                }

                // Robustness Check 2: The window must be a normal window.
                const window = await chrome.windows.get(firstTabWindowId);
                if (window.type !== 'normal') {
                    Logger.warn(`Cannot create group '${group.group_name}' because tabs are not in a normal window.`);
                    continue; // Skip to the next group
                }

                const groupId = await chrome.tabs.group({ tabIds: tabIdsToGroup, createProperties: { windowId: firstTabWindowId } });
                await chrome.tabGroups.update(groupId, {
                    title: group.group_name,
                    //color: 'blue'
                    color: getRandomColor()
                });
                Logger.log(`Group created: ${group.group_name}`);
                successfulGroups++;    
            } 
                
            catch (error) {
                Logger.error(`Error during tab grouping for '${group.group_name}':`, error.message);
            }
        }
    }
    if (successfulGroups > 0) {
        chrome.action.setBadgeText({ text: successfulGroups.toString() });
        chrome.action.setBadgeBackgroundColor({ color: '#5C6BC0' }); 
    }
}

// --- 5. Manual Trigger & Initialization ---

// Function to start the grouping process on demand
async function startGroupingProcess() {
    Logger.log("Manual grouping process initiated.");
    isProcessing = false; // Reset processing lock
    // Clear ALL previous tab status data (essential for re-injecting)
    Object.keys(tabProcessingStatus).forEach(key => delete tabProcessingStatus[key]);
    
    
    // Remove any empty groups left over from a previous manual degrouping.
    await removeEmptyGroups();  

    const tabs = await chrome.tabs.query({ currentWindow: true, windowType: 'normal' });
    const relevantTabs = tabs.filter(t => isDocumentTab(t.url));

    if (relevantTabs.length < 2) {
        Logger.log("Not enough document tabs to group.");
        return;
    }

    Logger.log(`Found ${relevantTabs.length} relevant tabs. Re-initializing status and injecting scripts...`);

    const injectionPromises = [];

    // Clear status for relevant tabs and initiate injection in parallel
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

    // Wait for all injections to complete (or fail) using Promise.allSettled
    await Promise.allSettled(injectionPromises);

    // Now that all injections are initiated, wait for content scripts to send data
    // and then trigger the check.
    /*
    setTimeout(() => {
        Logger.log("Fallback: Forcing a check after manual injection.");
        checkAndProcessAllTabs();
    }, 2000); // 2 second timeout */
}

function getRandomColor() {
    const colors = ["blue", "red", "yellow", "green", "pink", "purple", "cyan"];
    return colors[Math.floor(Math.random() * colors.length)];
}

async function removeEmptyGroups() {
    try {
        const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        
        for (const group of groups) {
            // Find tabs belonging to this group ID
            const tabs = await chrome.tabs.query({ groupId: group.id });
            
            // If the group exists but has no tabs, remove the group
            if (tabs.length === 0) {
                /* chrome.tabGroups.remove is deprecated in Manifest V3. 
                // The correct way to delete a group is to move its last tab out, or 
                // use chrome.tabs.ungroup, which we will avoid here for cleanliness.
                // Instead, we will collapse groups, which is a cleaner UX for empty state.
                
                // CRITICAL NOTE: Group colors persist. A group is removed when all 
                // tabs in it are ungrouped. Since we want to remove the *group element itself*,
                // we'll rely on a clean ungrouping process if the group is found empty.
                
                // However, the cleanest solution is often to just collapse/update it.
                
                // Since there is no direct chrome.tabGroups.delete in MV3, 
                // we'll use a pragmatic approach: if a group is empty, collapse it for UX.
                // Or, simply rely on the 'ungrouping' nature of the main logic.
                
                // For a truly clean experience, we will focus on preventing the re-use of old group colors/titles.
                // The current implementation is simpler: we only delete empty groups if we find them.
                
                // A direct fix: Ungroup any remaining tabs from the old run that haven't been grouped yet
                // (This is implicitly handled by the next step, but let's keep this simpler for now.)
                */

                Logger.log(`Skipping explicit deletion of empty group ${group.id}. Relying on tab re-assignment.`);

            }
        }
    } catch (error) {
        Logger.error("Error during empty group cleanup:", error);
    }
}

// Listen for clicks on the extension icon
chrome.action.onClicked.addListener(startGroupingProcess);


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
