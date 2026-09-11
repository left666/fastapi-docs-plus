from __future__ import annotations

from typing import Any, Literal

Language = Literal["en", "zh"]

_MESSAGES: dict[Language, dict[str, str]] = {
    "en": {
        "missing_key": "LLM credentials are not configured. Set DOCS_PLUS_LLM_API_KEY or OPENAI_API_KEY.",
        "empty_response": "The model returned empty content.",
        "invalid_json": "The model returned invalid JSON.",
        "non_object": "The model did not return a JSON object.",
        "schema_too_large": "The operation schema and history are too large ({size} characters); the limit is {limit}.",
        "validation_failed": "Both attempts failed schema validation; nothing was cached: {problem}",
        "body_required": "requestBody is required, but body is null.",
        "empty_cache": "No AI-generated data is cached for this operation. Click AI Generate first.",
        "operation_not_found": "Operation not found in OpenAPI: {method} {path}",
        "service_error": "The AI service is unavailable. Please check the service configuration or try again later.",
    },
    "zh": {
        "missing_key": "未配置 LLM 凭据，请设置环境变量 DOCS_PLUS_LLM_API_KEY 或 OPENAI_API_KEY。",
        "empty_response": "模型返回了空内容。",
        "invalid_json": "模型返回的内容不是合法 JSON。",
        "non_object": "模型返回的不是 JSON 对象。",
        "schema_too_large": "该接口的 schema 和历史过大（{size} 字符），已超出上限 {limit}。",
        "validation_failed": "两次生成均未通过 schema 校验，未缓存：{problem}",
        "body_required": "requestBody 是必填的，但 body 为 null。",
        "empty_cache": "该接口暂无 AI 生成缓存，请先点击「AI 生成」。",
        "operation_not_found": "OpenAPI 中不存在操作：{method} {path}",
        "service_error": "AI 服务暂不可用，请检查服务配置或稍后重试。",
    },
}


def translate(message_key: str, language: Language = "en", **params: Any) -> str:
    """Look up a localized message and format it with the given parameters.

    Args:
        message_key: Key into the message dictionary.
        language: Target language (``"en"`` or ``"zh"``).
        **params: Format-string parameters injected via ``str.format``.

    Returns:
        The formatted localized string.
    """
    return _MESSAGES[language][message_key].format(**params)


def language_instruction(language: Language = "en") -> str:
    """Return a system-level language instruction for the LLM prompt.

    Args:
        language: Target language (``"en"`` or ``"zh"``).

    Returns:
        A short instruction string such as ``"Output language: English."``.
    """
    return {
        "en": "Output language: English.",
        "zh": "Output language: Simplified Chinese.",
    }[language]