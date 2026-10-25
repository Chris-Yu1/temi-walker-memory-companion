# Cross-Robot Memory Companion

A photo-guided conversational reminiscence system deployed on both the **Temi** service robot and the **UBTECH Walker** humanoid robot. The project uses one shared Angular/Node.js application and isolates robot-specific behaviour behind platform adapters, allowing the same interaction protocol to run on both embodiments.

## What the system does

1. Registers a participant and calibrates head-pose/gaze measurements.
2. Accepts two personal photographs through a mobile upload gateway.
3. Runs an LLM-guided, voice-based reminiscence conversation around each photograph.
4. Handles speech recognition, text-to-speech, turn-taking and no-speech timeouts.
5. Records interaction events and questionnaire responses for cross-platform evaluation.
6. Controls Temi through its Android/WebView environment and Walker through ROSBridge.

## Repository structure

```text
src/                         Angular user interface and robot drivers
temi-webview-wrapper/        Android wrapper used on Temi
scripts/                     Experiment analysis and figure-generation tools
server.mjs                   Node.js backend, session logic and API routes
public-upload-gateway.mjs    Mobile photo-upload gateway
start-temi.ps1               Temi launch workflow
start-walker.ps1             Walker launch workflow
walker-rosbridge-*.patch     Walker speaker/light ROSBridge integration
```

## Architecture

The browser-based application contains the shared experiment flow. `RobotDriverFactory` selects the Temi or Walker implementation at runtime. Temi uses the Android WebView/native services available on the robot. Walker uses a ROSBridge connection for speech, lights and other robot outputs. The Node.js backend manages sessions, LLM requests, speech services, uploads and structured event logging.

## Prerequisites

- Node.js 20 or later
- pnpm or npm
- An OpenAI API key for the configured language and speech models
- For Temi: the robot browser or the included Android WebView wrapper
- For Walker: a reachable ROSBridge endpoint with the required speaker/light topics

## Local setup

```powershell
Copy-Item .env.example .env.local
# Add your API key to .env.local
npm install
npm run build
npm run start:server
```

In a second terminal:

```powershell
npm start
```

Open `http://localhost:4200/` for local development. The robot-specific PowerShell launchers document the deployment parameters used for each platform.

## Configuration and privacy

`.env.local` is deliberately excluded from version control. Do not commit API keys, participant identifiers, personal photographs, audio recordings, transcripts or raw experiment logs. The repository contains source code and documentation only.

## Research context

The system was developed for a University of Bristol Robotics MSc project investigating how robot embodiment affects photo-guided conversational reminiscence. This public repository contains the implementation and reproducible analysis utilities, but excludes participant data and unpublished dissertation materials.

## Author

Qinghong Yu
