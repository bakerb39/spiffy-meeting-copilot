# Spiffy Meeting Copilot by B Squared

A standalone, mobile-friendly meeting copilot designed for Render:

- The **iPhone Listener** captures microphone audio with clear consent and listening indicators.
- OpenAI Realtime transcribes the meeting through a browser WebRTC connection.
- The **computer dashboard** receives the rolling transcript through a paired session.
- The presenter can paste context or add a small text file, then request a concise response to say aloud.
- The OpenAI API key remains on the Render server and is never sent to the phone or browser.

## Deploy on Render

1. Put this folder in its own GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository. Render will read `render.yaml`.
3. Set the secret `OPENAI_API_KEY` when prompted. You can use the same server-side key already configured for another Render service, but it must also be added to this service.
4. Deploy, open the Render URL on your computer, and scan the QR code with your iPhone.
5. On the phone, check the consent box and tap **Start listening**.

Render provides HTTPS, which iPhone browsers require before granting microphone access.

## Environment variables

| Variable | Required | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | — |
| `OPENAI_RESPONSE_MODEL` | No | `gpt-5-mini` |
| `OPENAI_TRANSCRIBE_MODEL` | No | `gpt-live-transcribe` |
| `PORT` | No | `3000` |

If your OpenAI project does not have access to a default model, change the corresponding Render environment variable to a model available to your project.

## Run locally

```bash
npm install
cp .env.example .env
# Load .env with your preferred local environment tool, then:
npm start
```

Open `http://localhost:3000`. For microphone testing on a physical iPhone, deploy to HTTPS rather than opening a LAN HTTP address.

## Privacy and MVP limitations

- Obtain consent from everyone before transcribing. Recording/transcription laws vary by location.
- This app does not intentionally record or save audio. Audio is transmitted to OpenAI for live transcription.
- Transcript and context are held only in server memory and disappear when the service restarts or the four-hour session expires.
- Pairing codes are suitable for controlled MVP testing, not sensitive or regulated meetings.
- Sessions live in one process. Do not scale the Render service above one instance without moving session state and Socket.IO coordination to Redis or another shared store.
- `gpt-live-transcribe` does not provide speaker labels, so the transcript will not identify individual participants.

## Test

```bash
npm test
```
