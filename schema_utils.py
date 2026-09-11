from __future__ import annotations

from typing import Any

# title 对 LLM 几乎无信息量（多为字段名重复），去掉可省大量 token
_DROP_KEYS = {"title"}
_INLINED_CONTAINERS = ("$defs", "definitions")
_MAP_KEYS = ("properties", "patternProperties")
_SINGLE_KEYS = ("items", "additionalProperties", "not", "contains")
_LIST_KEYS = ("anyOf", "oneOf", "allOf", "prefixItems")
_PARAM_KEYS = ("name", "in", "required", "description", "schema", "example", "examples")


def _resolve_pointer(ref: str, root: dict) -> dict | None:
    if not ref.startswith("#/"):
        return None
    node: Any = root
    for raw in ref[2:].split("/"):
        part = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            try:
                node = node[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node if isinstance(node, dict) else None


def flatten_schema(
    schema: Any,
    root: dict,
    *,
    max_depth: int = 4,
    _depth: int = 0,
    _stack: tuple[str, ...] = (),
) -> Any:
    """内联 $ref 并截断递归/超深结构，产出可直接喂给 LLM 的自包含 schema。"""
    if not isinstance(schema, dict):
        return schema

    ref = schema.get("$ref")
    if isinstance(ref, str):
        name = ref.rsplit("/", 1)[-1]
        if ref in _stack:
            return {"type": "object", "description": f"递归引用 {name}，只生成一层即可"}
        target = _resolve_pointer(ref, root)
        if target is None:
            return {"type": "object", "description": f"未能解析的引用 {ref}"}
        sibling = {k: v for k, v in schema.items() if k != "$ref"}
        return flatten_schema(
            {**target, **sibling},
            root,
            max_depth=max_depth,
            _depth=_depth,
            _stack=_stack + (ref,),
        )

    if _depth >= max_depth:
        return {"type": schema.get("type", "object"), "description": "已达展开深度上限，可自由取值"}

    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key in _DROP_KEYS or key in _INLINED_CONTAINERS:
            continue
        kwargs = {"max_depth": max_depth, "_stack": _stack}
        if key in _MAP_KEYS and isinstance(value, dict):
            out[key] = {
                k: flatten_schema(v, root, _depth=_depth + 1, **kwargs) for k, v in value.items()
            }
        elif key in _SINGLE_KEYS and isinstance(value, dict):
            out[key] = flatten_schema(value, root, _depth=_depth + 1, **kwargs)
        elif key in _LIST_KEYS and isinstance(value, list):
            out[key] = [flatten_schema(v, root, _depth=_depth, **kwargs) for v in value]
        else:
            out[key] = value
    return out


def _pick_body_content(request_body: dict) -> tuple[str | None, dict | None]:
    content = request_body.get("content") or {}
    if not content:
        return None, None
    for media_type in content:
        if "json" in media_type:
            return media_type, content[media_type]
    media_type = next(iter(content))
    return media_type, content[media_type]


def build_operation_spec(openapi: dict, path: str, method: str, *, max_depth: int = 4) -> dict:
    """抽取单个操作的自包含描述，供 LLM 生成入参。"""
    path_item = (openapi.get("paths") or {}).get(path)
    if not isinstance(path_item, dict):
        raise KeyError(f"OpenAPI 中不存在路径 {path}")
    operation = path_item.get(method.lower())
    if not isinstance(operation, dict):
        raise KeyError(f"OpenAPI 中不存在操作 {method.upper()} {path}")

    parameters = []
    shared = path_item.get("parameters") or []
    own = operation.get("parameters") or []
    for raw in [*shared, *own]:
        if not isinstance(raw, dict):
            continue
        if isinstance(raw.get("$ref"), str):
            resolved = _resolve_pointer(raw["$ref"], openapi)
            if resolved is None:
                continue
            raw = resolved
        param = {k: raw[k] for k in _PARAM_KEYS if raw.get(k) is not None}
        if isinstance(param.get("schema"), dict):
            param["schema"] = flatten_schema(param["schema"], openapi, max_depth=max_depth)
        parameters.append(param)

    spec: dict[str, Any] = {
        "method": method.upper(),
        "path": path,
        "summary": operation.get("summary"),
        "description": operation.get("description"),
        "parameters": parameters,
    }
    if operation.get("x-ai-hint"):
        spec["businessHint"] = operation["x-ai-hint"]

    request_body = operation.get("requestBody")
    if isinstance(request_body, dict):
        if isinstance(request_body.get("$ref"), str):
            request_body = _resolve_pointer(request_body["$ref"], openapi) or {}
        media_type, media = _pick_body_content(request_body)
        if media is not None:
            spec["requestBody"] = {
                "contentType": media_type,
                "required": bool(request_body.get("required")),
                "schema": flatten_schema(media.get("schema") or {}, openapi, max_depth=max_depth),
                "examples": media.get("examples") or media.get("example"),
            }

    return {k: v for k, v in spec.items() if v not in (None, [], {})}
