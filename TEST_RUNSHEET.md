# Memory Companion Full Test Run Sheet

Use this run sheet for one complete participant test: Walker first, then Temi, then questionnaire.

## 1. Before The Participant Arrives

1. Confirm the participant code, for example `P01`.
2. Use the same participant name and ID in both robot sessions and in the questionnaire.
3. Prepare two photos for the participant.
4. Confirm backend keys are available in `.env.local`.
5. Start the backend and frontend from `C:\Users\amaZING！\Desktop\try`.

```powershell
$env:Path='C:\Users\amaZING！\Desktop\try\node-local;' + $env:Path
.\node-local\node.exe .\server.mjs
```

In another terminal:

```powershell
$env:Path='C:\Users\amaZING！\Desktop\try\node-local;' + $env:Path
.\node-local\node.exe .\static-frontend.mjs
```

## 2. Walker Session

1. Start Walker ROS services on the robot/Raspberry Pi.
2. Open the app on Walker Chromium:

```text
http://APP_COMPUTER_IP:4200/?robot=walker&ros_ip=192.168.4.1&ros_port=9090
```

3. Enter the same participant name and ID convention in the registration form.
4. Complete calibration.
5. Upload exactly two photos by QR code.
6. Complete the photo conversations.
7. Confirm the Walker folder appears under:

```text
outputs/test-sessions/
```

The folder name should include the participant name and a Walker robot label.

## 3. Temi Session

1. Confirm Temi is on the correct Wi-Fi and ADB connection is available.
2. Start/open the Temi app.
3. Use the same participant name and ID convention as Walker.
4. Complete calibration, two-photo upload, and conversation.
5. Confirm the Temi folder appears under:

```text
outputs/test-sessions/
```

The folder name should include the participant name and a Temi robot label.

## 4. Questionnaire

Open the standalone questionnaire page:

```text
http://APP_COMPUTER_IP:4200/?questionnaire=1
```

Recommended entry:

- Participant ID: `P01`
- Robot used: `Both`
- Session type: `Walker first, Temi second`
- Complete SUS, NASA-TLX, SASSI, and comparison notes.

After submission, confirm files are saved under:

```text
outputs/questionnaires/
```

The aggregate file for all participants is:

```text
outputs/questionnaires/all-questionnaire-responses.csv
```

## 5. Export Analysis Files

After the participant finishes both robot sessions and the questionnaire, run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python .\scripts\export_experiment_analysis.py
```

The analysis outputs will be saved in:

```text
outputs/analysis/
```

Key files:

- `robot-session-analysis.csv`: one row per robot session.
- `questionnaire-score-summary.csv`: one row per questionnaire.
- `walker-temi-paired-comparison.csv`: one paired Walker-vs-Temi row per participant.

## 6. Minimum Data Quality Check

For each participant, verify:

- One Walker session folder exists.
- One Temi session folder exists.
- One questionnaire response exists.
- Participant name/ID spelling is consistent.
- `walker-temi-paired-comparison.csv` contains the participant.
- Session audio exists if audio recording was enabled.
- Question and answer counts are not zero.

## 7. Suggested Metrics For Later Analysis

Primary comparison:

- Valid answer rate.
- Mean question API latency.
- Mean attention score.
- Central gaze rate.
- Turn-taking endpoint rate.
- SUS score.
- NASA-TLX mean.
- SASSI overall and category means.

Interpretation direction:

- Higher SUS is better.
- Lower NASA-TLX is better.
- Higher SASSI positive category means are generally better, but annoyance-related items should be interpreted carefully because higher annoyance items indicate worse experience.
- Lower API latency is better.
- Higher valid answer rate and central gaze rate usually indicate smoother interaction.
