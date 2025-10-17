# AI-Doc-Tab-Grouper

A cutting-edge Chrome Extension powered by Google Vertex AI that intelligently groups your document tabs into actionable, explainable project workspaces. Built for productivity, transparency, and seamless integration with modern web platforms, this project showcases advanced browser automation, cloud AI orchestration, and scalable backend engineering.

---

## ✨ Features

- **AI-Powered Tab Grouping:** Uses Vertex AI to analyze and cluster your open document tabs by content and context.
- **Explainable Grouping Logic:** Transparent, interpretable grouping criteria—see not just _what_ grouped, but _why_.
- **Multi-Platform Support:** Works with Google Docs, Office 365, SharePoint, GitHub, Atlassian, Figma, Miro, Gmail, Notion, and more.
- **Modern Chrome Extension:** Manifest V3, service worker background, content script extraction, and badge/status feedback.
- **Cloud-Native Backend:** Python Flask API running on Google Cloud Run for scalable, low-latency AI orchestration.
- **Dockerized Backend:** Easy local development and cloud deployment.
- **Security & Privacy:** Minimal permissions, robust error handling, and privacy-conscious content extraction.

---

## 🚀 Demo

!

> _See the extension in action as it instantly organizes your chaotic browser into focused project clusters._

---

## 🏗️ Project Structure

```
chromeapirot/
├── ai-grouper-backend/
│   ├── app.py
│   ├── Dockerfile
│   └── requirements.txt
└── extension/
    ├── content-script.js
    ├── icon48.png
    ├── manifest.json
    └── service-worker.js
```

---

## 🛠️ Tech Stack

- **Frontend:** JavaScript (Manifest V3 Chrome Extension)
- **Backend:** Python (Flask), Google Vertex AI, Google Cloud Run
- **Containerization:** Docker
- **CI/CD:** GitHub Actions (recommended setup)
- **AI/ML:** Vertex AI for semantic grouping

---

## 🧑‍💻 How to Run Locally

### 1. Clone the Repo

```bash
git clone https://github.com/tgejason/AI-Doc-Tab-Grouper.git
cd AI-Doc-Tab-Grouper
```

### 2. Backend (Python API)

```bash
cd ai-grouper-backend
docker build -t ai-grouper-backend .
docker run -p 8080:8080 ai-grouper-backend
```

### 3. Extension (Chrome)

- Go to `chrome://extensions/` in your browser.
- Enable "Developer mode".
- Click "Load unpacked" and select the `extension/` folder.

---

## 🌐 Supported Platforms

- Google Docs, Office Online, SharePoint, GitHub, Atlassian, Figma, Miro, Gmail, Notion, and more.

---

## 📈 Why This Project?

- **Showcases advanced AI and browser engineering.**
- **Emphasizes explainability and user trust.**
- **Demonstrates cloud-native, scalable architecture.**
- **Industry-standard code organization and security.**
- **Open to all users, designed to empower diverse teams.**

---

## 👤 About the Author

_Built by tgejason, a passionate developer dedicated to building inclusive, high-impact productivity tools leveraging the best of AI and cloud technologies._


- [Portfolio](https://verimindai.com

---

## 🤝 Contributing

Contributions and feedback are welcome! Please open an issue or pull request.

---

## 📄 License

[MIT License](LICENSE)

---

_**This project is designed with transparency and accessibility in mind, so that talent, not bias, leads the way.**_
