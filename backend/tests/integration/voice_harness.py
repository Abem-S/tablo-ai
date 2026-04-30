"""Integration harness for LiveKit + Gemini voice flows.

This script dispatches the agent to a new room and prints a token for a test client.
Optional: if livekit-rtc is installed, you can extend this to publish audio.
"""
from __future__ import annotations

import asyncio
import os
from uuid import uuid4

from config import get_env


def _require(name: str) -> str | None:
    val = get_env(name)
    if not val:
        print(f"Missing {name}; set it in backend/.env or secrets manager.")
    return val


async def main() -> int:
    livekit_url = _require("LIVEKIT_URL")
    api_key = _require("LIVEKIT_API_KEY")
    api_secret = _require("LIVEKIT_API_SECRET")
    if not (livekit_url and api_key and api_secret):
        return 2

    try:
        from livekit import api
    except Exception as e:
        print(f"livekit-api not installed: {e}")
        return 2

    room_name = f"tablo-int-{uuid4().hex[:6]}"
    participant_identity = f"tester-{uuid4().hex[:6]}"

    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(participant_identity)
        .with_name("Tablo Integration Tester")
        .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish=True, can_subscribe=True, can_publish_data=True))
        .to_jwt()
    )

    async with api.LiveKitAPI(livekit_url, api_key, api_secret) as livekit_api:
        await livekit_api.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name="tablo-assistant",
                room=room_name,
            )
        )

    print("Room:", room_name)
    print("Token:", token)
    print("Join the room with the frontend and speak to validate the voice loop.")
    print("Optional: install livekit-rtc to automate audio publishing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
