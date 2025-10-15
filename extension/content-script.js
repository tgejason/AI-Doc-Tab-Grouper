// --- content-script.js ---

// Check if the script has already been executed for this page
// if (!window.aiGrouperContentScriptExecuted) {
//     window.aiGrouperContentScriptExecuted = true;
// Wrap the entire file contents in an IIFE to create a new, private scope 
// every time the script is executed.
(function() {
    console.log("AI-Grouper Content Script: Initializing.");
    console.log("AI-Grouper Content Script: chrome.runtime object:", chrome.runtime);

    const MAX_CHARS = 500;

    function extractDocumentSnippet() {
        // 1. Prioritize elements with well-known accessibility roles
        let contentElement = document.querySelector('[role="textbox"], [contenteditable="true"], [aria-label="Document content"], .kix-zoomservice, [role="main"]');
        
        // 2. Fallback for Office Online / SharePoint
        if (!contentElement && (window.location.hostname.includes('office.com') || window.location.hostname.includes('sharepoint.com'))) {
            contentElement = document.getElementById('WACViewPanel') || document.querySelector('.WACMainCanvas, #WebApplicationContent');
        }
        
        // 3. Ultimate Fallback: Scrape the entire body text
        if (!contentElement) {
            contentElement = document.body;
        }
        
        // Safely extract and clean text
        let text = contentElement ? contentElement.innerText : '';
        text = text.replace(/\s+/g, ' ').trim(); 
        
        // If the snippet is too short, provide metadata as context for the LLM
        if (text.length < 50) {
            text = `CONTENT_TOO_SHORT. Title: ${document.title}. URL: ${window.location.href}`;
        }
        
        return {
            title: document.title || "Untitled Document",
            snippet: text.substring(0, MAX_CHARS),
            url: window.location.href,
            status: "SUCCESS"
        };
    }

    // Main execution block with robust try/catch
    try {
        console.log("AI-Grouper Content Script: Attempting to extract snippet.");
        const data = extractDocumentSnippet();
        console.log("AI-Grouper Content Script: Snippet extracted successfully. Sending message.");
        
        // Send success data back to the service worker
        chrome.runtime.sendMessage({ 
            action: "GROUP_TAB_DATA",
            data: data 
        });
    } catch (error) {
        console.error("AI-Grouper Content Script: Error during snippet extraction or message sending.", error);
        const errorData = {
            title: document.title || "Untitled Document",
            url: window.location.href,
            snippet: "", // Keep snippet empty for privacy on error
            status: "ERROR_SNIPPET_EXTRACTION",
            message: error.message.substring(0, 150) // Limit error message length
        };
        
        // Send a structured error message back
        chrome.runtime.sendMessage({ 
            action: "GROUP_TAB_DATA_ERROR",
            data: errorData
        });
    }
})();
