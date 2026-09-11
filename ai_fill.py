from __future__ import annotations

import hashlib
import json
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any
from openai import AsyncOpenAI
from jsonschema import Draft202012Validator
from .config import DocsPlusConfig
from .i18n import Language, language_instruction, translate

_LOCATIONS = ("path", "query", "header", "cookie")
_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")

SYSTEM_PROMPT = """You generate realistic API request data from an OpenAPI operation specification.

Output rules:
1. Return one JSON object with only these keys: path, query, header, cookie, body.
2. path/query/header/cookie map declared parameter names to scalar values; use {} for empty locations. Never invent parameters.
3. body must strictly match requestBody.schema; use null when there is no requestBody.
4. Obey enum, const, pattern, format, minimum/maximum, minLength/maxLength, minItems, required and all other schema constraints.
5. Use description / examples / businessHint for business meaning, but write free-form natural-language values such as remark, comments, name, address and keyword in the selected output language, even when descriptions, examples or businessHint are Chinese or use another language.
6. Never translate JSON keys, enum/const values, protocol identifiers, or fixed business codes/values. Language selection must not violate schema constraints, including country-specific phone formats.
7. Use ISO 8601 timestamps, reasonable monetary amounts and realistic, correctly formatted IDs.
8. Do not use placeholders such as "string", "foo", "test", 0 or empty strings unless the schema requires them. Include optional fields when useful.
9. Do not output explanations, comments or Markdown fences.
10. When generation history is provided, make new values clearly different from each previous result while obeying the schema and the selected output language. These language rules also apply to correction retries."""


class AIFillError(RuntimeError):
    def __init__(self, message_key: str, **params: Any) -> None:
        self.message_key = message_key
        self.params = params
        super().__init__(self.localize())

    def localize(self, language: Language = "en") -> str:
        params = {
            key: value.localize(language) if isinstance(value, AIFillError) else value
            for key, value in self.params.items()
        }
        return translate(self.message_key, language, **params)


# ------------------------------------------------------------------ 缓存

@dataclass
class _OpCache:
    """单个接口的生成结果队列。cursor 单调递增后取模轮换，淘汰最旧不影响轮换顺序。"""

    schema_fingerprint: str
    items: deque[dict] = field(default_factory=deque)
    cursor: int = 0


_CACHES: dict[tuple[Language, str], _OpCache] = {}


def _op_key(path: str, method: str) -> str:
    return f"{method.upper()} {path}"


def _fingerprint(op_spec: dict) -> str:
    return hashlib.sha256(json.dumps(op_spec, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def next_fill(path: str, method: str, language: Language = "en") -> dict | None:
    entry = _CACHES.get((language, _op_key(path, method)))
    if entry is None or not entry.items:
        return None
    index = entry.cursor % len(entry.items)
    entry.cursor += 1
    return {**entry.items[index], "cacheIndex": index, "cacheCount": len(entry.items)}


def cache_counts(language: Language = "en") -> dict[str, int]:
    return {
        key: len(entry.items)
        for (entry_language, key), entry in _CACHES.items()
        if entry_language == language and entry.items
    }


# ------------------------------------------------------------------ 生成

def _build_client(config: DocsPlusConfig):
    if not config.llm_api_key:
        raise AIFillError("missing_key")
    return AsyncOpenAI(api_key=config.llm_api_key, base_url=config.llm_base_url)


def _normalize(data: Any) -> dict:
    if not isinstance(data, dict):
        raise AIFillError("non_object")
    result: dict[str, Any] = {}
    for key in _LOCATIONS:
        value = data.get(key)
        result[key] = value if isinstance(value, dict) else {}
    result["body"] = data.get("body")
    return result


def _prune(data: dict, op_spec: dict) -> dict:
    """丢掉模型编造的、schema 里并未声明的参数，避免回填出无效字段。"""
    declared: dict[str, set[str]] = {location: set() for location in _LOCATIONS}
    for param in op_spec.get("parameters", []):
        location = param.get("in")
        if location in declared and param.get("name"):
            declared[location].add(param["name"])
    for location in _LOCATIONS:
        data[location] = {k: v for k, v in data[location].items() if k in declared[location]}
    if not op_spec.get("requestBody"):
        data["body"] = None
    return data


def _validate(data: dict, op_spec: dict) -> str | AIFillError | None:
    body_schema = (op_spec.get("requestBody") or {}).get("schema")
    if not body_schema:
        return None
    if data.get("body") is None:
        return AIFillError("body_required") if op_spec["requestBody"].get("required") else None
    errors = sorted(Draft202012Validator(body_schema).iter_errors(data["body"]), key=lambda e: list(e.path))
    if not errors:
        return None
    return "; ".join(f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in errors[:5])


async def _complete(client, config: DocsPlusConfig, messages: list[dict], temperature: float) -> dict:
    response = await client.chat.completions.create(
        model=config.llm_model,
        messages=messages,
        temperature=temperature,
        response_format={"type": "json_object"},
        timeout=config.llm_timeout,
    )
    if not response.choices:
        raise AIFillError("empty_response")
    raw = (response.choices[0].message.content or "").strip()
    if not raw:
        raise AIFillError("empty_response")
    try:
        return _normalize(json.loads(_FENCE.sub("", raw)))
    except json.JSONDecodeError as exc:
        raise AIFillError("invalid_json") from exc


async def generate_and_cache(
    op_spec: dict, config: DocsPlusConfig, *, path: str, method: str, language: Language = "en"
) -> int:
    """生成一组入参，只有通过 jsonschema 校验才入队。返回当前缓存条数。"""
    key = (language, _op_key(path, method))
    fingerprint = _fingerprint(op_spec)
    entry = _CACHES.get(key)
    if entry is None or entry.schema_fingerprint != fingerprint:
        # schema 变了，旧缓存（以及作为上下文的历史）全部作废
        entry = _OpCache(schema_fingerprint=fingerprint)
        _CACHES[key] = entry

    payload = json.dumps(op_spec, ensure_ascii=False, sort_keys=True)
    history = list(entry.items)
    if history:
        compact = json.dumps(history, ensure_ascii=False, separators=(",", ":"))
        payload += f"\n\nGeneration history (make new values clearly different):\n{compact}"
    if len(payload) > config.max_schema_chars:
        raise AIFillError("schema_too_large", size=len(payload), limit=config.max_schema_chars)

    # 历史越多越需要多样性
    temperature = min(1.0, config.llm_temperature + 0.1 * min(len(history), 5))
    instruction = language_instruction(language)
    messages: list[dict] = [
        {"role": "system", "content": f"{SYSTEM_PROMPT}\n\n{instruction}"},
        {"role": "user", "content": payload},
    ]

    client = _build_client(config)
    data = _prune(await _complete(client, config, messages, temperature), op_spec)

    problem = _validate(data, op_spec)
    if problem:
        messages = [
            *messages,
            {"role": "assistant", "content": json.dumps(data, ensure_ascii=False)},
            {
                "role": "user",
                "content": f"The previous output failed schema validation: {problem}\n"
                f"Correct it and return the complete JSON object. {instruction}",
            },
        ]
        retried = _prune(await _complete(client, config, messages, temperature), op_spec)
        second_problem = _validate(retried, op_spec)
        if second_problem:
            raise AIFillError("validation_failed", problem=second_problem)
        data = retried

    entry.items.append(data)
    while len(entry.items) > max(1, config.ai_cache_max_size):
        entry.items.popleft()
    return len(entry.items)