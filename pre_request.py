from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import unquote_plus, urlsplit

from starlette.routing import Match


@dataclass
class PreRequestContext:
    """Context for a single Try-it-out request that is about to be sent.

    Modify ``headers`` or ``query`` directly to affect the outgoing
    request. All other fields are read-only.

    Attributes:
        method: Uppercase HTTP method (e.g. ``"GET"``, ``"POST"``).
        url: The full request URL.
        path: The path component of the URL.
        headers: Mutable mapping of request headers. Modifications are
            reflected in the actual request.
        query: Mutable mapping of query-string parameters (URL-decoded).
            Modifications are re-encoded for the actual request.
        env: Environment variables passed from the frontend, including
            ``identity`` and any extra environment JSON.
        route_path: The matched route template (e.g.
            ``"/shops/{shop_id}"``), or ``None`` if no route matched.
        operation_id: The ``operation_id`` of the matched route, or the
            route name, or ``None``.
        path_params: Path parameters extracted from the URL (e.g.
            ``{"shop_id": "shop-0042"}``).
    """

    method: str
    url: str
    path: str
    headers: dict[str, str]
    query: dict[str, str]
    env: dict[str, Any] = field(default_factory=dict)
    route_path: str | None = None
    operation_id: str | None = None
    path_params: dict[str, Any] = field(default_factory=dict)

    @property
    def identity(self) -> str | None:
        """The user-selected identity from the top-bar dropdown, if any."""
        value = self.env.get("identity")
        return value if isinstance(value, str) and value else None


PreRequestHook = Callable[[PreRequestContext], None | Awaitable[None]]
"""Signature for a pre-request hook function.

A hook receives a :class:`PreRequestContext` and may modify
``ctx.headers`` and ``ctx.query``. It can be synchronous or
asynchronous.
"""


def match_route(app, method: str, path: str):
    """Resolve the route matching a given HTTP method and path.

    Returns a ``(route, path_params)`` tuple by scanning
    ``app.routes``. Prefers a ``FULL`` match over ``PARTIAL``.

    Args:
        app: The FastAPI application instance.
        method: HTTP method (e.g. ``"GET"``).
        path: The URL path to match.

    Returns:
        ``(route, path_params)`` where *route* is the matched
        ``APIRoute`` (or ``None``) and *path_params* is a dict of
        extracted path parameters.
    """
    scope = {
        "type": "http",
        "method": method.upper(),
        "path": path,
        "root_path": "",
        "headers": [],
        "query_string": b"",
    }
    partial = None
    for route in app.routes:
        match, child_scope = route.matches(scope)
        if match == Match.FULL:
            return route, child_scope.get("path_params") or {}
        if match == Match.PARTIAL and partial is None:
            partial = (route, child_scope.get("path_params") or {})
    return partial if partial else (None, {})


def build_context(app, *, method: str, url: str, headers: dict[str, str], env: dict[str, Any]) -> PreRequestContext:
    """Build a :class:`PreRequestContext` from the frontend's pre-request payload.

    Parses the URL, extracts query parameters (URL-decoded), and
    resolves the matched route and path params.

    Args:
        app: The FastAPI application instance.
        method: HTTP method.
        url: Full request URL.
        headers: Request headers from the frontend.
        env: Environment variables from the frontend (identity, extra
            env JSON, etc.).
    """
    parts = urlsplit(url)
    query: dict[str, str] = {}
    for pair in parts.query.split("&"):
        if not pair:
            continue
        key, _, value = pair.partition("=")
        query[unquote_plus(key)] = unquote_plus(value)

    route, path_params = match_route(app, method, parts.path)
    return PreRequestContext(
        method=method.upper(),
        url=url,
        path=parts.path,
        headers=dict(headers),
        query=query,
        env=env,
        route_path=getattr(route, "path", None),
        operation_id=getattr(route, "operation_id", None) or getattr(route, "name", None),
        path_params=path_params,
    )


async def run_hooks(hooks: list[PreRequestHook], ctx: PreRequestContext) -> None:
    """Execute a list of pre-request hooks in registration order.

    Hooks share the same :class:`PreRequestContext` instance.
    Supports both synchronous and asynchronous callables.

    Args:
        hooks: List of pre-request hook callables.
        ctx: The request context to pass to each hook.
    """
    for hook in hooks:
        result = hook(ctx)
        if inspect.isawaitable(result):
            await result