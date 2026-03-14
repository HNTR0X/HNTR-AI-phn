# HNTR-AI-phn
Pydroid PAiCd
# Sivarr AI — Web App

## Setup

1. Install dependencies:
pip3 install -r requirements.txt
2. Create a `.env` file in this folder:
GEMINI_API_KEY=your_key_here
3. Run the server:
uvicorn app:app --reload --port 8000
4. Open your browser and go to:
http://localhost:8000
## Folder Structure
sivarr/
├── app.py              ← FastAPI backend
├── requirements.txt    ← Python dependencies
├── .env                ← Your API key (never share this)
├── templates/
│   └── index.html      ← Full dashboard UI
└── data/               ← Student progress files (auto-created)
## Deploy on Railway
1. Push to GitHub
2. Go to https://railway.app
3. Connect your repo → Deploy
4. Add GEMINI_API_KEY as an environment variable
5. Share the generated link with students
