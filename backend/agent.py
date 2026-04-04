import logging
import os
from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, AutoSubscribe, JobContext, WorkerOptions, cli
from livekit.plugins import google

load_dotenv()

# The livekit-plugins-google reads GOOGLE_API_KEY from env.
# We alias GEMINI_API_KEY -> GOOGLE_API_KEY so both names work.
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]

logger = logging.getLogger("tablo-agent")


async def entrypoint(ctx: JobContext):
    logger.info("Connecting to room: %s", ctx.room.name)

    # Subscribe to audio tracks only — we don't need video from learners.
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    logger.info("Connected. Starting Gemini Live session...")

    # Use the stable Gemini Live native-audio model.
    # RealtimeModel handles the full speech-to-speech pipeline internally —
    # no separate STT or TTS plugins needed.
    model = google.realtime.RealtimeModel(
        model="gemini-2.5-flash-native-audio-preview-12-2025",
        voice="Aoede",
        instructions=(
            "You are Tablo, a Socratic voice assistant for a collaborative learning "
            "whiteboard. You help learners think through problems by asking guiding "
            "questions rather than giving direct answers. Keep your responses concise "
            "and natural for voice — avoid markdown, bullet points, or long lists. "
            "The learner is working on a board right now."
        ),
        temperature=0.8,
    )

    # AgentSession wires the model to the LiveKit room transport.
    session = AgentSession(llm=model)

    # start() in v1.5+ requires an Agent instance + room keyword arg.
    await session.start(
        agent=Agent(instructions=(
            "You are Tablo, a Socratic voice assistant for a collaborative learning "
            "whiteboard. Help the learner think through problems with guiding questions."
        )),
        room=ctx.room,
    )

    logger.info("Agent session started in room: %s", ctx.room.name)

    # Kick off an opening greeting so the learner knows the agent is live.
    await session.generate_reply(
        instructions="Greet the learner warmly and briefly in one sentence, "
                     "then ask what they are working on today."
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="tablo-assistant",
        )
    )
