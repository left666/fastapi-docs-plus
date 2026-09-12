from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(*names: str, default: str | None = None) -> str | None:
    """Read the first non-empty environment variable from *names."""
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


_DEFAULT_SWAGGER_UI_PARAMETERS: dict = {
    "persistAuthorization": True,
    "displayRequestDuration": True,
    "docExpansion": "list",
    "showExtensions": True,
    "showCommonExtensions": True,
}


@dataclass
class DocsPlusConfig:
    """Configuration for fastapi-docs-plus.

    Controls Swagger UI rendering, AI parameter generation, and
    pre-request hook behaviour.

    Attributes:
        docs_url: Path for the documentation page (default ``"/docs"``).
        api_prefix: Prefix for internal API endpoints and static assets
            (default ``"/_docs"``).
        openapi_url: URL where Swagger UI fetches the OpenAPI spec
            (default ``"/openapi.json"``).
        swagger_ui_version: Swagger UI version used to build CDN URLs
            (default ``"5.17.14"``).
        swagger_ui_js_url: Override for the Swagger UI JS bundle URL.
            When ``None`` the CDN URL is used.
        swagger_ui_css_url: Override for the Swagger UI CSS URL.
            When ``None`` the CDN URL is used.
        swagger_ui_js_integrity: Subresource Integrity hash for the JS
            bundle. When set, an ``integrity`` attribute is emitted.
        swagger_ui_css_integrity: Subresource Integrity hash for the
            CSS. When set, an ``integrity`` attribute is emitted.
        swagger_ui_parameters: Extra parameters passed to the
            ``SwaggerUIBundle`` constructor. Merged key-wise over the
            defaults, so only the keys you provide are overridden and
            the rest keep their default values. Defaults enable
            ``persistAuthorization``, ``displayRequestDuration``,
            ``docExpansion="list"``, ``showExtensions`` and
            ``showCommonExtensions``.
        identities: List of identity labels shown in the top-bar
            dropdown. An empty list hides the dropdown entirely.
        llm_model: LLM model identifier (default ``"gpt-4o-mini"``).
        llm_base_url: Base URL for the OpenAI-compatible API. Reads
            ``DOCS_PLUS_LLM_BASE_URL`` or ``OPENAI_BASE_URL``.
        llm_api_key: API key for the LLM service. Reads
            ``DOCS_PLUS_LLM_API_KEY`` or ``OPENAI_API_KEY``.
        llm_temperature: Temperature for LLM calls. Automatically
            increased by ``0.1`` per cached history entry, capped at
            ``1.0`` (default ``0.3``).
        llm_timeout: Timeout in seconds for each LLM call
            (default ``60.0``).
        max_schema_depth: Maximum depth for inlining ``$ref`` schemas
            (default ``4``).
        max_schema_chars: Maximum total characters for the schema plus
            cached history. Beyond this the request is rejected without
            calling the LLM (default ``60_000``).
        ai_cache_max_size: Maximum number of validated AI-generated
            results kept per operation in the in-memory cache. Oldest
            entries are evicted first (default ``5``).
    """

    docs_url: str = "/docs"
    api_prefix: str = "/_docs"
    openapi_url: str = "/openapi.json"

    swagger_ui_version: str = "5.17.14"
    swagger_ui_js_url: str | None = None
    swagger_ui_css_url: str | None = None
    swagger_ui_js_integrity: str | None = None
    swagger_ui_css_integrity: str | None = None
    swagger_ui_parameters: dict = field(default_factory=dict)

    identities: list[str] = field(default_factory=list)

    llm_model: str = field(default_factory=lambda: _env("DOCS_PLUS_LLM_MODEL", default="gpt-4o-mini"))
    llm_base_url: str | None = field(default_factory=lambda: _env("DOCS_PLUS_LLM_BASE_URL", "OPENAI_BASE_URL"))
    llm_api_key: str | None = field(default_factory=lambda: _env("DOCS_PLUS_LLM_API_KEY", "OPENAI_API_KEY"))
    llm_temperature: float = 0.3
    llm_timeout: float = 60.0

    max_schema_depth: int = 4
    max_schema_chars: int = 60_000

    ai_cache_max_size: int = 5

    def __post_init__(self) -> None:
        self.swagger_ui_parameters = {
            **_DEFAULT_SWAGGER_UI_PARAMETERS,
            **(self.swagger_ui_parameters or {}),
        }

    @property
    def ai_enabled(self) -> bool:
        return bool(self.llm_api_key)

    @property
    def static_url(self) -> str:
        return f"{self.api_prefix}/static"

    @property
    def resolved_js_url(self) -> str:
        base = f"https://cdn.jsdelivr.net/npm/swagger-ui-dist@{self.swagger_ui_version}"
        return self.swagger_ui_js_url or f"{base}/swagger-ui-bundle.js"

    @property
    def resolved_css_url(self) -> str:
        base = f"https://cdn.jsdelivr.net/npm/swagger-ui-dist@{self.swagger_ui_version}"
        return self.swagger_ui_css_url or f"{base}/swagger-ui.css"