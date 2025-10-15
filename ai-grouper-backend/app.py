# app.py

import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig

# --- Initialization ---
# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Initialize Vertex AI
PROJECT_ID = os.getenv("GCP_PROJECT_ID", "coin-service-326121")
REGION = "us-central1"
vertexai.init(project=PROJECT_ID, location=REGION)

# Model configuration
MODEL_NAME = "gemini-2.5-flash" # Corrected model name

# --- LLM Prompt ---

SYSTEM_PROMPT = """
You are an expert AI Tab Grouping Agent. Your task is to analyze the provided list of document tabs (which includes title, URL, and a text snippet) and logically group them based on common projects, shared themes, or follow-up relationships. 

For each group you create, you MUST provide a concise 'rationale' explaining the core reason for the grouping. This rationale will be used for AI transparency and user trust.

Constraints:
1. Only group tabs that appear related. Tabs that do not belong to a group must be omitted from the output.
2. The response MUST be a single JSON object matching the requested schema.
"""

def generate_grouping_json(tabs_data):
    """
    Calls the Gemini model with structured output configuration.
    """
    response_schema = {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "description": "A list of identified tab groups.",
                "items": {
                    "type": "object",
                    "properties": {
                        "group_name": {"type": "string", "description": "A concise name for the tab group."},
                        "tab_titles": {"type": "array", "items": {"type": "string"}, "description": "The exact titles of the tabs belonging to this group."},
                        "rationale": {"type": "string", "description": "The reasoning behind this specific grouping (e.g., 'Similar project name and shared keywords like 'GCP' and 'Q4 budget')."},
                    },
                    "required": ["group_name", "tab_titles", "rationale"]
                }
            }
        },
        "required": ["groups"]
    }

    user_prompt = f"""
    Analyze the following document tabs and group them. Return the result in the structured JSON format provided.

    TABS TO ANALYZE:
    {tabs_data}
    """
    
    try:
        model = GenerativeModel(
            MODEL_NAME,
            system_instruction=SYSTEM_PROMPT
        )
        
        generation_config = GenerationConfig(
            response_mime_type="application/json",
            response_schema=response_schema,
            temperature=0.0
        )

        response = model.generate_content(
            user_prompt,
            generation_config=generation_config,
        )
        
        return response.text
        
    except Exception as e:
        app.logger.error(f"Vertex AI Gemini API Error: {e}")
        return None

# --- Flask Endpoint ---

@app.route('/group', methods=['POST'])
def group_tabs():
    """Handles the request from the Chrome extension service worker."""
    
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400

    tabs_data = request.get_json()
    app.logger.info(f"Received {len(tabs_data)} tabs for grouping.")
    
    clean_tabs = [tab for tab in tabs_data if tab.get('status') == 'DATA_RECEIVED_READY_TO_GROUP']
    
    if len(clean_tabs) < 2:
        return jsonify({
            "groups": [], 
            "message": "Insufficient valid tabs to process."
        }), 200

    json_result = generate_grouping_json(clean_tabs)
    
    if json_result:
        return json_result, 200, {'Content-Type': 'application/json'}
    else:
        return jsonify({"error": "AI processing failed"}), 500

@app.route('/')
def health_check():
    """Simple health check endpoint."""
    return 'AI Grouper Backend is running.', 200


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
