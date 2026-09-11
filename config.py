from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


@dataclass
class DocsPlusConfig:
    docs_url: str = "/docs"
    api_prefix: str = "/_docs"
    openapi_url: str = "/openapi.json"

    swagger_ui_version: str = "5.17.14"
    swagger_ui_js_url: str | None = None
    swagger_ui_css_url: str | None = None
    swagger_ui_js_integrity: str | None = None
    swagger_ui_css_integrity: str | None = None
    swagger_ui_parameters: dict = field(
        default_factory=lambda: {
            "tryItOutEnabled": True,
            "persistAuthorization": True,
            "displayRequestDuration": True,
            "docExpansion": "list",
            "filter": True,
        }
    )

    identities: list[str] = field(default_factory=list)
    identity_label: str | dict[str, str] | None = None

    llm_model: str = field(default_factory=lambda: _env("DOCS_PLUS_LLM_MODEL", default="gpt-4o-mini"))
    llm_base_url: str | None = field(default_factory=lambda: _env("DOCS_PLUS_LLM_BASE_URL", "OPENAI_BASE_URL"))
    llm_api_key: str | None = field(default_factory=lambda: _env("DOCS_PLUS_LLM_API_KEY", "OPENAI_API_KEY"))
    llm_temperature: float = 0.3
    llm_timeout: float = 60.0

    max_schema_depth: int = 4
    max_schema_chars: int = 60_000

    # 每个接口最多缓存最近多少轮通过校验的 AI 生成结果，超出淘汰最旧
    ai_cache_max_size: int = 5

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
