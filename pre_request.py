from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import unquote_plus, urlsplit

from starlette.routing import Match


@dataclass
class PreRequestContext:
    """一次待发出的 Try-it-out 请求。修改 headers / query 即可影响真实请求。"""

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
        value = self.env.get("identity")
        return value if isinstance(value, str) and value else None


PreRequestHook = Callable[[PreRequestContext], None | Awaitable[None]]


def match_route(app, method: str, path: str):
    """按 method + 实际路径反查 APIRoute，从而拿到 operation_id 与路径参数。"""
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
    for hook in hooks:
        result = hook(ctx)
        if inspect.isawaitable(result):
            await result
