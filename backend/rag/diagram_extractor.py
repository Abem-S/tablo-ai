"""Diagram extraction: render PDF pages to images and call Gemini vision."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass

from .models import DiagramRecipe

logger = logging.getLogger("tablo-rag.diagram")

_RENDER_DPI = 150
_RETRIES = 2
_RECIPE_TIMEOUT_S = 20.0   # per-page vision timeout
_MAX_CONCURRENT = 5        # max parallel Gemini vision calls

# At ingestion time we only extract a short description — no commands.
# Commands are generated on-demand at teaching time via draw_diagram tool.
_DESCRIPTION_PROMPT = """Analyse this page image. If it contains a meaningful diagram, flowchart, network topology, architecture diagram, data structure, or other visual structure (not just plain text paragraphs or decorative elements), respond with JSON only:
{
  "has_diagram": true,
  "description": "<one concise sentence describing what the diagram shows and its key components>"
}

If the page contains no meaningful diagram, respond with:
{"has_diagram": false}

Return ONLY valid JSON, no markdown fences."""


@dataclass
class PageImage:
    page_number: int   # 1-based
    png_bytes: bytes   # in-memory PNG, never written to disk


class DiagramExtractor:
    """Renders PDF pages to PNG bytes and calls Gemini vision to produce DiagramRecipes."""

    def __init__(self, genai_client) -> None:
        self._client = genai_client

    # ------------------------------------------------------------------
    # Page rendering
    # ------------------------------------------------------------------

    def render_page(self, pdf_doc, page_number: int) -> PageImage:
        """Render a single PDF page (1-based) to PNG bytes at 150 DPI.

        Raises ValueError on failure.
        """
        try:
            import fitz
            page = pdf_doc[page_number - 1]
            matrix = fitz.Matrix(_RENDER_DPI / 72, _RENDER_DPI / 72)
            pixmap = page.get_pixmap(matrix=matrix)
            png_bytes = pixmap.tobytes("png")
            return PageImage(page_number=page_number, png_bytes=png_bytes)
        except Exception as e:
            raise ValueError(f"Failed to render page {page_number}: {e}") from e

    # ------------------------------------------------------------------
    # Recipe extraction
    # ------------------------------------------------------------------

    async def extract_recipe(self, image: PageImage) -> DiagramRecipe | None:
        """Send page image to Gemini vision. Returns DiagramRecipe with description only.

        Commands are NOT generated here — they are generated on-demand via generate_commands().
        Returns None when has_diagram is false, JSON is malformed, or retries exhausted.
        """
        delay = 1.0
        last_error: Exception | None = None

        for attempt in range(_RETRIES + 1):
            try:
                from google.genai import types as genai_types

                response = self._client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=[
                        genai_types.Part.from_bytes(
                            data=image.png_bytes,
                            mime_type="image/png",
                        ),
                        _DESCRIPTION_PROMPT,
                    ],
                )
                raw = (response.text or "").strip()
                raw = re.sub(r"^```(?:json)?\s*", "", raw)
                raw = re.sub(r"\s*```$", "", raw)

                data = json.loads(raw)
                if not data.get("has_diagram"):
                    return None

                description = data.get("description", "").strip()
                if not description:
                    return None

                return DiagramRecipe(
                    page_number=image.page_number,
                    description=description,
                    image_b64=__import__("base64").b64encode(image.png_bytes).decode("utf-8"),
                )
            except json.JSONDecodeError as e:
                logger.warning("Page %d: malformed JSON from Gemini vision: %s", image.page_number, e)
                return None
            except Exception as e:
                last_error = e
                if attempt < _RETRIES:
                    logger.warning(
                        "Page %d: vision attempt %d failed: %s — retrying in %.1fs",
                        image.page_number, attempt + 1, e, delay,
                    )
                    await asyncio.sleep(delay)
                    delay *= 2

        logger.warning("Page %d: vision failed after %d attempts: %s", image.page_number, _RETRIES + 1, last_error)
        return None

    async def generate_commands(self, description: str, image_b64: str = "") -> list[dict]:
        """Generate tldraw drawing commands from a diagram.

        If image_b64 is provided, uses the actual page image for accurate visual reproduction.
        Prefers a single create_svg for complex diagrams to maximize fidelity.
        """
        command_schema = (
            "Return a JSON array of tldraw commands. For complex diagrams, prefer ONE large create_svg.\n\n"
            "Available ops:\n"
            '- {"op":"create_svg","svg":"<svg viewBox=\'0 0 W H\'>...</svg>","x":0,"y":0,"w":700,"h":500}  ← PREFERRED\n'
            '- {"op":"create_text","text":"...","x":N,"y":N}\n'
            '- {"op":"create_geo","geo":"rectangle|ellipse|diamond","x":N,"y":N,"w":N,"h":N,"label":"..."}\n'
            '- {"op":"create_arrow","x":N,"y":N,"toX":N,"toY":N,"label":"..."}\n\n'
            "SVG rules: fill='none' stroke='black' stroke-width='2'. Use <text> for labels inside SVG. "
            "viewBox must match your coordinate space.\n"
            "Board: x 0–800, y 0–600. Max 8 commands. "
            "CRITICAL: Keep SVG under 400 characters. Use simple shapes only: "
            "<rect>, <circle>, <line>, <polygon>, <text>. Never use complex <path> elements.\n"
            "For a complex diagram, use ONE create_svg that captures the whole structure.\n"
            "Return ONLY a valid JSON array, no markdown, no explanation."
        )

        delay = 1.0
        for attempt in range(_RETRIES + 1):
            try:
                from google.genai import types as genai_types

                if image_b64:
                    import base64
                    png_bytes = base64.b64decode(image_b64)
                    contents = [
                        genai_types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                        (
                            "Reproduce the diagram shown in this image as tldraw drawing commands.\n"
                            "Capture the structure, labels, and connections as faithfully as possible.\n"
                            "For complex diagrams, use a single create_svg with a detailed SVG.\n\n"
                            + command_schema
                        ),
                    ]
                else:
                    contents = (
                        f"Draw this diagram as tldraw commands:\n{description}\n\n"
                        + command_schema
                    )

                response = self._client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=contents,
                )
                raw = (response.text or "").strip()
                raw = re.sub(r"^```(?:json)?\s*", "", raw)
                raw = re.sub(r"\s*```$", "", raw)
                commands = json.loads(raw)
                if isinstance(commands, list):
                    return commands[:8]
                return []
            except json.JSONDecodeError as e:
                logger.warning("generate_commands: malformed JSON: %s", e)
                return []
            except Exception as e:
                if attempt < _RETRIES:
                    logger.warning("generate_commands attempt %d failed: %s — retrying", attempt + 1, e)
                    await asyncio.sleep(delay)
                    delay *= 2

        logger.warning("generate_commands failed after %d attempts", _RETRIES + 1)
        return []

    # ------------------------------------------------------------------
    # Batch extraction
    # ------------------------------------------------------------------

    async def extract_all(self, pdf_path: str) -> dict[int, DiagramRecipe]:
        """Render all pages and extract recipes concurrently.

        Returns mapping of page_number -> DiagramRecipe for pages that have diagrams.
        Pages that fail or have no diagram are absent from the dict.
        """
        import fitz

        try:
            pdf_doc = fitz.open(pdf_path)
        except Exception as e:
            raise ValueError(f"Failed to open PDF for diagram extraction: {e}") from e

        page_count = len(pdf_doc)
        logger.info("Extracting diagrams from %d pages in %s", page_count, os.path.basename(pdf_path))

        # Render all pages (sync, fast)
        images: list[PageImage | None] = []
        for page_num in range(1, page_count + 1):
            try:
                images.append(self.render_page(pdf_doc, page_num))
            except Exception as e:
                logger.warning("Skipping page %d render: %s", page_num, e)
                images.append(None)

        pdf_doc.close()

        # Extract recipes concurrently with semaphore to limit parallel API calls
        semaphore = asyncio.Semaphore(_MAX_CONCURRENT)

        async def safe_extract(img: PageImage | None) -> tuple[int, DiagramRecipe | None]:
            if img is None:
                return (-1, None)
            async with semaphore:
                try:
                    recipe = await asyncio.wait_for(
                        self.extract_recipe(img),
                        timeout=_RECIPE_TIMEOUT_S,
                    )
                    return (img.page_number, recipe)
                except asyncio.TimeoutError:
                    logger.warning("Page %d: vision timed out after %.0fs", img.page_number, _RECIPE_TIMEOUT_S)
                    return (img.page_number, None)
                except Exception as e:
                    logger.warning("Page %d: unexpected error during extraction: %s", img.page_number, e)
                    return (img.page_number, None)

        results = await asyncio.gather(*[safe_extract(img) for img in images])

        recipes: dict[int, DiagramRecipe] = {}
        for page_num, recipe in results:
            if recipe is not None:
                recipes[page_num] = recipe

        logger.info("Diagram extraction complete: %d/%d pages had diagrams", len(recipes), page_count)
        return recipes
