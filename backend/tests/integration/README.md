Integration tests for LiveKit + Gemini voice flows.

- Prereqs: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, GOOGLE_API_KEY
- Run: python tests/integration/voice_harness.py
- The script dispatches the agent and prints a room token for a test client.
- For full automation, install livekit-rtc and extend the harness to publish audio.
