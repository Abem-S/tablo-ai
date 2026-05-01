# Contributing to Tablo

Thank you for your interest in making Tablo better! This guide will help you get started with contributing to the project.

## What is Tablo?

Tablo is a **voice-first, board-first** AI learning product where:
- The board is the main surface
- Voice is the main input/output mode
- Text is secondary support, not the primary interaction model
- The AI thinks with the learner on the board, not like a normal chatbot

Before contributing, please read the [README](README.md) to understand the architecture and product direction.

## Development Workflow

> **Note for solo founder:** I'm building Tablo as a one-person project. PRs are welcome, but response times may vary. Please be patient — I'll get back to you as soon as I can. If you'd like to contribute regularly, consider opening an issue first to discuss the approach.

### 1. Create a feature branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

### 2. Make your changes

- Follow the code style (Ruff for Python, ESLint for TypeScript)
- Keep the board-first, voice-first UX principles in mind
- Don't introduce chat-app layouts
- If adding temporary dev UI, mark it clearly as temporary

### 3. Run tests

```bash
# Fast test suite (no external deps, ~35 seconds)
cd backend
python tests/test_skills.py          # Skills + learner memory
python tests/test_formats.py         # Document parsers
python tests/test_calculate.py       # Safe math eval
python tests/test_compression.py     # RAG compression

# Or run all tests at once
python tests/run_all.py

# Skip heavy visual drawing tests (faster, no Gemini API needed)
python tests/run_all.py --no-drawing

# Full test suite including agent behavior + drawing quality (requires Gemini API)
python tests/run_all.py
```

### 4. Commit and push

```bash
git add your-changed-files
git commit -m "feat: add feature description"
git push -u origin your-branch-name
```

### 5. Open a Pull Request

- Fill out the PR template
- Link any related issues
- Ensure all CI checks pass

## Code Standards

### Python (Backend)

- Use **Ruff** for linting and formatting
- Run `ruff check backend/` and `ruff format backend/` before committing
- All config via `config.get_env()` — never `os.getenv()` for secrets
- New agent tools must be wrapped in `_observe_tool()`
- **Security:** Never use `eval()` or `exec()` for tool execution. The `calculate` tool uses `math_eval.evaluate_expression()` for safe arithmetic. If you need to add code execution capabilities, use sandboxed execution (e.g., isolated subprocess, WebAssembly sandbox).

### TypeScript/React (Frontend)

- Follow existing component patterns
- Use ESLint + TypeScript strict mode
- Keep the canvas dominant — avoid chat-app layouts
- Temporary UI must be clearly labeled

### AI Drawing Commands

All board drawing goes through the `execute_command` tool in `backend/agent.py`. The frontend handles command validation and rendering. Do not add separate per-shape tools.

### Skills System

Agent behavior lives in `backend/skills/*.md` files, not hardcoded. Edit a skill file and restart the agent worker.

## Running the Application

```bash
# Clone the repo
git clone https://github.com/Abem-S/tablo-ai.git
cd tablo-ai

# Start infrastructure (Qdrant for vector storage)
docker compose up qdrant -d

# Set up backend
cd backend
cp .env.example .env
# Edit .env with your API keys (LiveKit, Google Gemini)
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Set up frontend
cd ../frontend
npm install

# Run backend (separate terminals)
python main.py          # FastAPI server
python agent.py dev     # LiveKit agent worker

# Run frontend
npm run dev
```

## What to Contribute?

### High Value Contributions

- **Board interactions**: New drawing commands, better shape rendering
- **Voice/AI**: Improved Socratic prompts, better tool calling
- **RAG**: Faster ingestion, better retrieval quality
- **UX refinements**: Voice-first improvements, accessibility

### Things to Avoid

- Adding authentication complexity (the OSS version is single-player)
- Replacing voice/board with text chat
- Restoring continuous video track (use board snapshots instead)
- Downgrading architecture (keep LiveKit + Gemini Live)

## Production Readiness

The test suite validates production-readiness:

| Test Category | What It Covers |
|---------------|----------------|
| **Skills** | Agent behavior, prompt assembly, learner memory |
| **Formats** | Document parsing for PDF, DOCX, PPTX, etc. |
| **Calculate** | Safe math evaluation, edge cases, RCE prevention |
| **Compression** | RAG context handling, truncation, diagram hints |
| **Drawing** (full) | AI-generated tldraw commands, visual quality |
| **Agent** (full) | Tool calling rate, board vision, Socratic quality |

Run `python tests/run_all.py --no-drawing` for fast CI validation. Run the full suite before releases.

## Getting Help

- Open an issue at https://github.com/Abem-S/tablo-ai/issues
- Check existing issues before creating new ones

## License

By contributing to Tablo, you agree that your contributions will be licensed under the [GNU Affero General Public License v3 (AGPLv3)](LICENSE).