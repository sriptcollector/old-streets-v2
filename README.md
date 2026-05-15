# Paths

Invite-only social platform. Live at `https://old-streets.fly.dev/`.

## Stack
- Node 20 + Express monolith (`server.js`)
- Socket.io for realtime DMs, online presence, Oldmegle match push
- JSON-file persistence on a Fly volume mounted at `/app/data`
- Twilio Verify (signup OTP) + Twilio Messages API (outbound SMS)
- Jitsi Meet iframe for live video (Rooms + Oldmegle)
- Static frontend in `public/` (vanilla JS, no build step)

## Run locally
```
npm install
node server.js
```
Server listens on `:8080`.

## Deploy
```
fly deploy --ha=false --strategy=immediate --wait-timeout=300
```

## Required Fly secrets
See `credentials.md` (not in this repo). Minimum: `TWILIO_*`, `ADMIN_USERNAME`, `ADMIN_PASSCODE`, `PUBLIC_URL`.
