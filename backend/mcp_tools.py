"""MCP-compatible tool registry for Tablo agent tools.

Exposes the agent's tools as MCP (Model Context Protocol) tool definitions
so they are discoverable, inspectable, and swappable without touching agent.py.

Usage
-----
The registry is used in two ways:

1. **Discovery** — any MCP client can call `list_tools()` to get the full
   schema of available tools (name, description, inputSchema).

2. **Execution** — `call_tool(name, arguments, context)` dispatches to the
   correct implementation. The `context` is a `RunContext` from livekit-agents.

The tools themselves are still implemented as `@function_tool` methods on
`TabloAgent` — this module just wraps them in the MCP wire format so they
can be called from external MCP clients (e.g. Claude Desktop, Cursor, etc.)
or from the LangGraph sub-agents without importing the full agent class.

MCP Tool Schema (subset of the full spec)
-----------------------------------------
{
  "name": str,
  "description": str,
  "inputSchema": {
    "type": "object",
    "properties": { ... },
    "required": [...]
  }
}
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

logger = logging.getLogger("tablo.mcp_tools")


# ─── Tool Definition ──────────────────────────────────────────────────────────


@dataclass
class MCPTool:
    """A single MCP-compatible tool definition."""

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[..., Awaitable[str]]

    def to_mcp_dict(self) -> dict[str, Any]:
        """Serialize to the MCP wire format."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


# ─── Registry ─────────────────────────────────────────────────────────────────


class MCPToolRegistry:
    """Registry of all Tablo agent tools in MCP format.

    Tools are registered at module load time via `register()`.
    The registry is a singleton — use `get_registry()`.
    """

    def __init__(self) -> None:
        self._tools: dict[str, MCPTool] = {}

    def register(self, tool: MCPTool) -> None:
        self._tools[tool.name] = tool
        logger.debug("Registered MCP tool: %s", tool.name)

    def list_tools(self) -> list[dict[str, Any]]:
        """Return all tool definitions in MCP wire format."""
        return [t.to_mcp_dict() for t in self._tools.values()]

    async def call_tool(
        self, name: str, arguments: dict[str, Any], context: Any = None
    ) -> str:
        """Dispatch a tool call by name.

        Args:
            name: Tool name (must match a registered tool).
            arguments: Tool arguments dict (validated against inputSchema by caller).
            context: RunContext from livekit-agents, or None for standalone calls.

        Returns:
            Tool result as a string (MCP tools always return strings).

        Raises:
            KeyError: If the tool name is not registered.
            Exception: If the tool handler raises.
        """
        if name not in self._tools:
            raise KeyError(
                f"Unknown MCP tool: {name!r}. Available: {list(self._tools)}"
            )
        tool = self._tools[name]
        return await tool.handler(context=context, **arguments)

    def get_tool(self, name: str) -> MCPTool | None:
        return self._tools.get(name)


_REGISTRY: MCPToolRegistry | None = None


def get_registry() -> MCPToolRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = MCPToolRegistry()
    return _REGISTRY


# ─── Tool Definitions ─────────────────────────────────────────────────────────
# These are registered at import time. The handlers are thin wrappers that
# delegate to the actual implementations in agent.py / math_eval.py / rag/.
# When agent.py creates a TabloAgent, it calls `bind_agent_tools(agent)` to
# wire the handlers to the live agent instance.


def _make_unbound_handler(tool_name: str) -> Callable[..., Awaitable[str]]:
    """Return a handler that raises a clear error if the agent isn't bound yet."""

    async def _unbound(**kwargs: Any) -> str:
        raise RuntimeError(
            f"MCP tool '{tool_name}' called before agent was bound. "
            "Call mcp_tools.bind_agent_tools(agent) after creating TabloAgent."
        )

    return _unbound


def _register_default_tools() -> None:
    registry = get_registry()

    registry.register(
        MCPTool(
            name="execute_command",
            description=(
                "Execute any board drawing command on the tldraw whiteboard. "
                "Send a JSON command string. Always call get_board_state first to see what's there. "
                "Common ops: create_text, create_geo, create_graph, create_svg, create_arrow, "
                "update_shape, delete_shape, undo, clear_board."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "command_json": {
                        "type": "string",
                        "description": 'JSON string of the board command, e.g. \'{"op":"create_text","text":"Hello","x":100,"y":100}\'',
                    }
                },
                "required": ["command_json"],
            },
            handler=_make_unbound_handler("execute_command"),
        )
    )

    registry.register(
        MCPTool(
            name="get_board_image",
            description=(
                "Get a visual snapshot of the current whiteboard as an image description. "
                "Call this when you need to SEE what is on the board — freehand writing, "
                "student drawings, handwritten equations."
            ),
            input_schema={
                "type": "object",
                "properties": {},
                "required": [],
            },
            handler=_make_unbound_handler("get_board_image"),
        )
    )

    registry.register(
        MCPTool(
            name="search_documents",
            description=(
                "MANDATORY before answering any subject-matter question. "
                "Search the learner's uploaded documents for relevant passages. "
                "Returns compressed context with page numbers and diagram hints."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Concise keyword-rich search query, e.g. 'OSI model layers'",
                    }
                },
                "required": ["query"],
            },
            handler=_make_unbound_handler("search_documents"),
        )
    )

    registry.register(
        MCPTool(
            name="draw_diagram",
            description=(
                "Draw a diagram from the learner's uploaded document onto the board. "
                "Call this when search_documents mentions a diagram on a specific page."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "page_number": {
                        "type": "integer",
                        "description": "Page number of the diagram (from search_documents result)",
                    }
                },
                "required": ["page_number"],
            },
            handler=_make_unbound_handler("draw_diagram"),
        )
    )

    registry.register(
        MCPTool(
            name="calculate",
            description=(
                "Evaluate a mathematical expression accurately. "
                "Use for ANY arithmetic, algebra, or math computation. Never guess math."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Math expression, e.g. '347 * 28', 'sqrt(144)', 'sin(pi/6)'",
                    }
                },
                "required": ["expression"],
            },
            handler=_make_unbound_handler("calculate"),
        )
    )

    registry.register(
        MCPTool(
            name="update_learner_profile",
            description=(
                "Update the learner's persistent profile based on observations this session. "
                "Call when you observe something meaningful about how this learner learns."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "update_json": {
                        "type": "string",
                        "description": (
                            "JSON string with profile update fields: learning_styles, struggle_areas, "
                            "mastered, hints_that_worked, preferred_pace, last_session_summary, "
                            "session_history_entry, remove_struggle."
                        ),
                    }
                },
                "required": ["update_json"],
            },
            handler=_make_unbound_handler("update_learner_profile"),
        )
    )


# Register tools at import time
_register_default_tools()


# ─── Agent Binding ────────────────────────────────────────────────────────────


def bind_agent_tools(agent: Any) -> None:
    """Wire the MCP tool handlers to a live TabloAgent instance.

    Call this once after creating the TabloAgent. After binding, MCP clients
    can call tools via `get_registry().call_tool(name, args, context)` and
    the calls will be dispatched to the real agent methods.

    Args:
        agent: A TabloAgent instance with the tool methods defined.
    """
    registry = get_registry()

    async def _execute_command(context: Any = None, command_json: str = "") -> str:
        return await agent.execute_command.__wrapped__(agent, context, command_json)

    async def _get_board_image(context: Any = None) -> str:
        return await agent.get_board_image.__wrapped__(agent, context)

    async def _search_documents(context: Any = None, query: str = "") -> str:
        return await agent.search_documents.__wrapped__(agent, context, query)

    async def _draw_diagram(context: Any = None, page_number: int = 1) -> str:
        return await agent.draw_diagram.__wrapped__(agent, context, page_number)

    async def _calculate(context: Any = None, expression: str = "") -> str:
        return await agent.calculate.__wrapped__(agent, context, expression)

    async def _update_learner_profile(
        context: Any = None, update_json: str = ""
    ) -> str:
        return await agent.update_learner_profile.__wrapped__(
            agent, context, update_json
        )

    # Re-register with bound handlers
    registry.register(
        MCPTool(
            name="execute_command",
            description=registry.get_tool("execute_command").description,
            input_schema=registry.get_tool("execute_command").input_schema,
            handler=_execute_command,
        )
    )
    registry.register(
        MCPTool(
            name="get_board_image",
            description=registry.get_tool("get_board_image").description,
            input_schema=registry.get_tool("get_board_image").input_schema,
            handler=_get_board_image,
        )
    )
    registry.register(
        MCPTool(
            name="search_documents",
            description=registry.get_tool("search_documents").description,
            input_schema=registry.get_tool("search_documents").input_schema,
            handler=_search_documents,
        )
    )
    registry.register(
        MCPTool(
            name="draw_diagram",
            description=registry.get_tool("draw_diagram").description,
            input_schema=registry.get_tool("draw_diagram").input_schema,
            handler=_draw_diagram,
        )
    )
    registry.register(
        MCPTool(
            name="calculate",
            description=registry.get_tool("calculate").description,
            input_schema=registry.get_tool("calculate").input_schema,
            handler=_calculate,
        )
    )
    registry.register(
        MCPTool(
            name="update_learner_profile",
            description=registry.get_tool("update_learner_profile").description,
            input_schema=registry.get_tool("update_learner_profile").input_schema,
            handler=_update_learner_profile,
        )
    )

    logger.info(
        "MCP tool registry bound to TabloAgent — %d tools available",
        len(registry._tools),
    )


# ─── MCP HTTP Endpoint helpers ────────────────────────────────────────────────
# These are used by main.py to expose the MCP tool layer over HTTP so external
# MCP clients (Claude Desktop, Cursor, etc.) can discover and call tools.


def mcp_list_tools_response() -> dict[str, Any]:
    """Return the MCP list_tools response payload."""
    return {"tools": get_registry().list_tools()}


async def mcp_call_tool_response(
    name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    """Execute a tool and return the MCP call_tool response payload."""
    try:
        result = await get_registry().call_tool(name, arguments, context=None)
        return {
            "content": [{"type": "text", "text": result}],
            "isError": False,
        }
    except KeyError as e:
        return {
            "content": [{"type": "text", "text": str(e)}],
            "isError": True,
        }
    except Exception as e:
        logger.error("MCP tool call failed: %s(%s): %s", name, arguments, e)
        return {
            "content": [{"type": "text", "text": f"Tool error: {e}"}],
            "isError": True,
        }
