# MOVA / flow deployment

## Local production run

```bash
npm install
npm start
```

Open `http://localhost:8787`. The production server serves the built frontend and API from one process.

## Container deployment

On a Linux cloud VM with Docker installed:

```bash
cp .env.example .env
# Edit .env with the event configuration and secure camera gateway values.
docker compose up -d --build
docker compose ps
```

The app will be available on port `8787` and camera/alert state survives container restarts in the `mova-data` volume. Put an HTTPS reverse proxy such as Caddy or Nginx in front of the app before exposing it publicly.

## Health check

```bash
curl http://localhost:8787/health
```

A healthy response looks like:

```json
{"status":"ok","service":"mova-flow"}
```

## Environment

Copy `.env.example` to `.env` and set `PORT` and `HOST` for the deployment platform. Do not commit camera credentials or alert provider secrets.

## Google login

Create a Google OAuth web client in Google Cloud Console, add the deployed domain to its authorized JavaScript origins, then set the same client ID in both `VITE_GOOGLE_CLIENT_ID` at frontend build time and `GOOGLE_CLIENT_ID` at runtime. The backend verifies the Google ID token before showing the organizer profile.

## Camera integration

The camera form stores stream metadata through `POST /api/cameras`. RTSP video still needs a secure RTSP-to-WebRTC or HLS gateway before browser playback and computer vision can consume frames. Keep the gateway and camera credentials on the backend.

For real people detection, install the Python vision dependencies in the same deployment image:

```bash
python3 -m pip install -r requirements.txt
```

Retrain the crowd-risk model after collecting venue-specific, labelled examples:

```bash
python3 train_model.py
```

This writes `model.json`, which the Node API loads on startup. The included model is a small demonstration classifier trained on representative scenarios; a live venue should retrain it with calibrated camera zones and reviewed safety labels.

The Node server supervises `vision_worker.py` for every non-simulated camera. The worker opens the RTSP URL with OpenCV and runs Ultralytics YOLO class `0` (person), returning people count and an estimated density. Configure `PYTHON_BIN` if the deployment uses a virtual environment. Use a calibrated zone area before relying on density thresholds in a live event.

## Deployment checklist

- Use HTTPS in front of the Node server.
- Run `docker compose ps` and wait for the container health status to become healthy.
- Put the API behind authentication before exposing it publicly.
- Replace `control-room-demo` with a real SMS, WhatsApp, or push provider.
- Use a managed database instead of the local `data/state.json` file for multiple organizers.
- Validate alerts with venue safety, medical, fire, and police teams before a live event.
- Keep a human operator in the approval loop; MOVA must recommend actions, not autonomously control gates or emergency equipment.
