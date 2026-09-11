from __future__ import annotations

import json
from html import escape
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAIError
from pydantic import BaseModel, Field

from .ai_fill import AIFillError, cache_counts, generate_and_cache, next_fill
from .config import DocsPlusConfig
from .i18n import Language, translate
from .pre_request import PreRequestHook, build_context, run_hooks
from .schema_utils import build_operation_spec

STATIC_DIR = Path(__file__).parent / "static"


def _asset_tag(kind: str, url: str, integrity: str | None) -> str:
    attrs = f'integrity="{escape(integrity, quote=True)}" crossorigin="anonymous" ' if integrity else ""
    if kind == "css":
        return f'<link rel="stylesheet" {attrs}href="{escape(url, quote=True)}" />'
    return f'<script {attrs}src="{escape(url, quote=True)}"></script>'


class _OpTarget(BaseModel):
    path: str
    method: str
    language: Language = "en"


class _PreRequestPayload(BaseModel):
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    env: dict[str, Any] = Field(default_factory=dict)


class DocsPlus:
    """Enhanced interactive API docs with AI parameter filling and Python-side pre-request hooks.

    Usage::

        docs = DocsPlus(app, DocsPlusConfig(...))

        @docs.pre_request
        async def inject_auth(ctx: PreRequestContext) -> None:
            ctx.headers["Authorization"] = f"Bearer {token}"
    """

    def __init__(self, app: FastAPI, config: DocsPlusConfig | None = None) -> None:
        self.app = app
        self.config = config or DocsPlusConfig()
        self._hooks: list[PreRequestHook] = []
        self._register_routes()

    def pre_request(self, hook: PreRequestHook) -> PreRequestHook:
        """Register a pre-request hook.

        Multiple hooks execute in registration order and share the same
        :class:`PreRequestContext`.

        Args:
            hook: A synchronous or asynchronous callable that receives a
                :class:`PreRequestContext`.

        Returns:
            The same callable (allows use as a decorator).
        """
        self._hooks.append(hook)
        return hook

    def _register_routes(self) -> None:
        app, config = self.app, self.config
        app.mount(config.static_url, StaticFiles(directory=STATIC_DIR), name="docs_plus_static")

        @app.get(config.docs_url, include_in_schema=False)
        async def docs_page() -> HTMLResponse:
            return HTMLResponse(self._render_page())

        @app.post(f"{config.api_prefix}/api/ai/generate", include_in_schema=False)
        async def ai_generate(payload: _OpTarget) -> dict:
            try:
                op_spec = build_operation_spec(
                    app.openapi(), payload.path, payload.method, max_depth=config.max_schema_depth
                )
            except KeyError as exc:
                raise HTTPException(
                    status_code=404,
                    detail=translate(
                        "operation_not_found", payload.language,
                        method=payload.method.upper(), path=payload.path,
                    ),
                ) from exc
            try:
                count = await generate_and_cache(
                    op_spec, config, path=payload.path, method=payload.method,
                    language=payload.language,
                )
            except AIFillError as exc:
                raise HTTPException(status_code=503, detail=exc.localize(payload.language)) from exc
            except OpenAIError as exc:
                raise HTTPException(
                    status_code=503, detail=translate("service_error", payload.language)
                ) from exc
            return {"count": count}

        @app.post(f"{config.api_prefix}/api/ai/fill", include_in_schema=False)
        async def ai_fill(payload: _OpTarget) -> dict:
            result = next_fill(payload.path, payload.method, payload.language)
            if result is None:
                raise HTTPException(status_code=409, detail=translate("empty_cache", payload.language))
            return result

        @app.get(f"{config.api_prefix}/api/ai/cache", include_in_schema=False)
        async def ai_cache(language: Language = "en") -> dict:
            return {"counts": cache_counts(language)}

        @app.post(f"{config.api_prefix}/api/pre-request", include_in_schema=False)
        async def pre_request(payload: _PreRequestPayload) -> dict:
            ctx = build_context(
                app,
                method=payload.method,
                url=payload.url,
                headers=payload.headers,
                env=payload.env,
            )
            await run_hooks(self._hooks, ctx)
            return {
                "headers": {k: str(v) for k, v in ctx.headers.items() if v is not None},
                "query": {k: str(v) for k, v in ctx.query.items() if v is not None},
                "operationId": ctx.operation_id,
            }

    def _render_page(self) -> str:
        config = self.config
        front_config = {
            "openapiUrl": config.openapi_url,
            "apiPrefix": config.api_prefix,
            "identities": config.identities,
            "identityLabel": config.identity_label,
            "aiEnabled": config.ai_enabled,
            "hasPreRequestHook": bool(self._hooks),
            "swaggerUiParameters": config.swagger_ui_parameters,
        }
        template = (STATIC_DIR / "docs.html").read_text(encoding="utf-8")
        return (
            template.replace("__STATIC_URL__", escape(config.static_url, quote=True))
            .replace("__SWAGGER_CSS_TAG__", _asset_tag("css", config.resolved_css_url, config.swagger_ui_css_integrity))
            .replace("__SWAGGER_JS_TAG__", _asset_tag("js", config.resolved_js_url, config.swagger_ui_js_integrity))
            .replace("__CONFIG__", json.dumps(front_config, ensure_ascii=False).replace("</", "<\\/"))
        )


def setup_docs_plus(app: FastAPI, config: DocsPlusConfig | None = None) -> DocsPlus:
    """Create and register a :class:`DocsPlus` instance on the given FastAPI application.

    This is a convenience wrapper around ``DocsPlus(app, config)``.

    Args:
        app: The FastAPI application instance.
        config: Optional configuration. Falls back to defaults.

    Returns:
        The :class:`DocsPlus` instance (use it to register hooks via
        :meth:`DocsPlus.pre_request`).
    """
    return DocsPlus(app, config)