# fastapi-docs-plus

增强 FastAPI 自带的交互式接口文档，补上两个联调时最缺的能力：

1. **AI 填充入参** —— 每个接口一个按钮，调用 LLM 按该接口的 JSON Schema 生成一组像真实业务数据的参数，直接写进 Try-it-out 的输入框。
2. **Python 侧前置钩子** —— 类似 Postman 的 pre-request script，但脚本是仓库里的 Python 函数，可以直接复用项目的签名 / JWT / 数据库代码来注入鉴权信息，解决默认文档"请求一律鉴权不通过"的问题。

它替换 FastAPI 默认的 `/docs`，仍然基于 Swagger UI，不 fork、不改前端构建。

---

## 快速开始

```python
import os

from fastapi import FastAPI
from fastapi_docs_plus import DocsPlusConfig, PreRequestContext, setup_docs_plus

# 必须关掉内置 docs，否则 /docs 会被 FastAPI 默认路由抢先占用
app = FastAPI(title="订单服务", docs_url=None, redoc_url=None)

# ... 你的路由 ...

if os.getenv("APP_ENV", "dev") != "prod":  # 只在开发环境启用
   docs = setup_docs_plus(app, DocsPlusConfig(identities=["admin", "shop_owner", "readonly"]))


   @docs.pre_request
   async def inject_identity(ctx: PreRequestContext) -> None:
      if ctx.route_path == "/auth/login":  # 登录接口本身不注入
         return
      username = ctx.identity or "admin"
      ctx.headers["Authorization"] = f"Bearer {create_access_token(username)}"
      ctx.headers["X-Tenant-Id"] = USERS[username]["tenant_id"]
```

```bash
DOCS_PLUS_LLM_API_KEY=sk-xxx uvicorn app.main:app --reload
# 打开 http://127.0.0.1:8000/docs
```

页面顶部会多出一条工具栏：最左侧是**额外环境变量**（JSON）的展开开关，最右侧是**调用身份**下拉；每个接口标题栏右侧会多一个 **AI 填充** 按钮。

---

## 功能一：前置钩子

### 注册

```python
@docs.pre_request
def sync_hook(ctx: PreRequestContext) -> None: ...

@docs.pre_request
async def async_hook(ctx: PreRequestContext) -> None: ...
```

同步、异步都支持；多个钩子按注册顺序依次执行，共享同一个 `ctx`。

### 执行时机

Swagger UI 每次发起请求（包括加载 `openapi.json`）前，浏览器先把待发请求 POST 给 `{api_prefix}/api/pre-request`，钩子在服务端跑完后返回 header / query 补丁，浏览器再带着补丁发真实请求。所以：

- 钩子里可以用 `httpx` 请求别的服务、查数据库、复用项目内的加签函数
- 受保护的 `openapi.json` 也能正常加载（该请求没有 method，服务端按 `GET` 兜底）
- `curl` 展示区里能看到注入后的完整请求头，便于排查

### `PreRequestContext`

直接修改 `headers` / `query` 即生效，其余字段只读。

| 字段 | 说明 |
|---|---|
| `method` | 大写 HTTP 方法 |
| `url` | 完整 URL |
| `path` | URL 的 path 部分 |
| `headers` | **可改**。返回时整体替换，因此删除某个 header 也有效 |
| `query` | **可改**。已 URL 解码，返回时重新编码，中文不会二次编码 |
| `env` | 前端传来的环境变量，即 `{"identity": 顶栏选择, ...额外环境变量}` |
| `identity` | `env["identity"]` 的便捷读取，空值返回 `None` |
| `route_path` | 反查到的路由模板，如 `/shops/{shop_id}/orders`，适合用来按接口分支 |
| `operation_id` | 路由的 `operation_id`，没有则用函数名 |
| `path_params` | 从 URL 解析出的路径参数，如 `{"shop_id": "shop-0042"}` |

`route_path` / `operation_id` / `path_params` 来自按 `method + path` 反查 `app.routes`，不依赖前端传值。

### ⚠️ 由钩子注入的 header 请设为 `include_in_schema=False`

```python
tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id", include_in_schema=False)] = None
```

如果把它声明成 schema 里的**必填** header，Swagger UI 的客户端必填校验会在请求发出前就拦住空输入框，钩子根本没机会执行。声明为 `include_in_schema=False` 后输入框不再出现，完全交给钩子提供。

### 身份切换与环境变量

- `DocsPlusConfig(identities=[...])` 决定顶栏下拉的选项，选中值以 `env["identity"]` 传给钩子
- 顶栏「额外环境变量」是一个 JSON 对象，会平铺合并进 `env`，适合传 `{"tenant": "...", "debug": true}` 这类开关
- 两者都存在浏览器 `localStorage`，刷新不丢

---

## 功能二：AI 填充入参

### 工作流程

拆成两个动作：**AI 生成**只产出并缓存结果，**填充**把缓存写进表单。

点击「AI 生成」→ `POST {api_prefix}/api/ai/generate` → 服务端：

1. 从 `app.openapi()` 取出该操作，内联所有 `$ref`，截断循环引用与超过 `max_schema_depth` 的层级
2. 保留 `description / enum / pattern / format / 最大最小值 / examples`——**这些是 LLM 生成"像真的"数据的唯一依据，字段描述写得越全，生成质量越高**
3. 把该接口缓存队列里已有的历史结果一并放进上下文，要求模型生成与历史都不同的取值；temperature 随历史条数递增
4. 调 LLM（OpenAI 兼容接口，JSON 模式），要求输出固定信封：
   ```json
   { "path": {}, "query": {}, "header": {}, "cookie": {}, "body": null }
   ```
5. 裁掉 schema 中未声明的参数；接口没有 requestBody 时强制 `body` 为 `null`
6. 用 `jsonschema` 校验 body，不通过则把具体错误回灌给模型重试一次；**两次都不通过则报错且不缓存**——只有通过校验的结果才进入队列

缓存是**按接口的队列**（进程内存），最多保留最近 `ai_cache_max_size` 轮结果，超出淘汰最旧；schema 变化时该接口的旧缓存自动作废。

点击「填充」→ `POST {api_prefix}/api/ai/fill` → 从队列中**轮换**取一条（第 1 次取第 1 条、第 2 次取第 2 条……循环），前端自动展开该接口并写入输入框、请求体文本域。队列为空时返回 409；数量为 0 时按钮仅显示置灰样式、点击被前端直接忽略（不使用 disabled 属性，避免 React 对曾置灰渲染的按钮不再分发 onClick）；按钮文案 `填充 (N)` 即当前缓存条数，页面加载时会与服务端同步。

### 给单个接口加业务提示

```python
@router.post(
    "/orders",
    openapi_extra={"x-ai-hint": "中国大陆电商下单接口，收货地址用真实存在的省市，客单价控制在 100~2000 元"},
)
```

`x-ai-hint` 会作为 `businessHint` 一并送给模型，成本极低但对生成质量提升明显。

### 模型配置

通过环境变量（推荐）或 `DocsPlusConfig` 字段：

| 环境变量 | 对应字段 | 默认值 |
|---|---|---|
| `DOCS_PLUS_LLM_API_KEY` 或 `OPENAI_API_KEY` | `llm_api_key` | 无 |
| `DOCS_PLUS_LLM_BASE_URL` 或 `OPENAI_BASE_URL` | `llm_base_url` | OpenAI 官方 |
| `DOCS_PLUS_LLM_MODEL` | `llm_model` | `gpt-4o-mini` |

**未配置 api key 时 AI 填充自动关闭**：按钮不再注入，顶栏显示提示，文档其余功能不受影响。改 `llm_base_url` 即可接 DeepSeek、通义、Ollama 等任何 OpenAI 兼容服务——schema 里含内部信息时建议指向私有部署。

### 没有 API key 也想试

仓库自带一个测试替身，返回固定的入参信封：

```bash
python tools/mock_llm_server.py
DOCS_PLUS_LLM_API_KEY=mock DOCS_PLUS_LLM_BASE_URL=http://127.0.0.1:8899/v1 \
  DOCS_PLUS_LLM_MODEL=mock uvicorn example.main:app --reload
```

---

## `DocsPlusConfig`

| 字段 | 默认值 | 说明 |
|---|---|---|
| `docs_url` | `/docs` | 文档页路径 |
| `api_prefix` | `/_docs` | 增强接口与静态资源前缀 |
| `openapi_url` | `/openapi.json` | 前端拉取 spec 的地址 |
| `swagger_ui_version` | `5.17.14` | 拼 CDN 地址用；**升级需回归测试**，见下方限制 |
| `swagger_ui_js_url` / `swagger_ui_css_url` | `None` | 自托管资源地址 |
| `swagger_ui_js_integrity` / `swagger_ui_css_integrity` | `None` | 填了会输出 `integrity` + `crossorigin` |
| `swagger_ui_parameters` | 见源码 | 传给 `SwaggerUIBundle` 的配置，会被内部必需项覆盖 |
| `identities` | `[]` | 顶栏身份下拉选项，空则不显示下拉 |
| `identity_label` | `调用身份` | 下拉的标签文字 |
| `llm_temperature` | `0.3` | 队列历史越多自动小幅上调（+0.1/条，封顶 1.0） |
| `llm_timeout` | `60.0` | 单次调用超时（秒） |
| `max_schema_depth` | `4` | schema 展开深度上限 |
| `max_schema_chars` | `60000` | 单接口 schema + 历史结果的体积上限，超出直接报错不调模型 |
| `ai_cache_max_size` | `5` | 每个接口最多缓存最近多少轮通过校验的生成结果 |

> `swagger_ui_parameters` 默认已开启 `tryItOutEnabled`（免去每次点 Try it out）、`persistAuthorization`、`filter`。`docExpansion` 必须是 `list` 或 `full`——设为 `none` 会把 tag 分组整体折叠，AI 按钮不可见。

---

## HTTP 接口

均不出现在 OpenAPI 文档中。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `{docs_url}` | 文档页 |
| GET | `{api_prefix}/static/*` | 前端静态资源 |
| POST | `{api_prefix}/api/ai/generate` | `{path, method}` → `{count}`，生成并缓存（仅校验通过才入队） |
| POST | `{api_prefix}/api/ai/fill` | `{path, method}` → 入参信封 + `cacheIndex/cacheCount`；无缓存返回 409 |
| GET | `{api_prefix}/api/ai/cache` | → `{counts: {"METHOD path": n}}`，供页面加载时同步数量徽标 |
| POST | `{api_prefix}/api/pre-request` | `{method, url, headers, env}` → `{headers, query, operationId}` |

---

## 限制与注意事项

**只在开发环境注册。** 前置钩子会以服务端身份签发凭据、AI 接口会消耗额度，生产镜像里不应存在这些路由。示例用 `APP_ENV` 做开关，请按自己的配置体系接。

**`static/adapter.js` 是唯一接触 Swagger UI 内部 API 的文件。** 那些 action / selector 不是稳定公开 API，跨版本会变。升级 `swagger_ui_version` 后必须回归测试参数与请求体回填，出问题只需改这一个文件。已知的两个坑（都已在 adapter 里处理，改动时别踩回去）：

- 参数值存在 meta 键 `${in}.${name}.hash-${param.hashCode()}` 下，必须用 `specJsonWithResolvedSubtrees()` 取**未合并 meta** 的原始参数对象；用 `operationWithMeta()` 取到的对象带 `value`/`errors`，hashCode 不同，写入会落到没人读的键上，表现为**静默失效**（带默认值的参数尤其明显）。
- 接口折叠时 RequestBody 组件尚未挂载，它挂载时会用自动生成的样例覆盖写入值，所以回填前必须先展开接口。

**Swagger UI 资源默认走 CDN 且未启用 SRI**，与 FastAPI 内置文档的行为一致。若要收敛这个风险，配置 `swagger_ui_js_url` / `swagger_ui_css_url` 自托管，或补上对应的 `*_integrity`。

**AI 缓存是进程内内存队列**，按接口独立、上限见 `ai_cache_max_size`，重启即失效。多 worker 下各进程缓存独立，数量徽标与轮换顺序可能不一致。

**复杂参数类型的回填能力有限**：标量、枚举、数组走的是原生输入组件；深层嵌套的对象型 query 参数会被序列化成 JSON 字符串填入，未必符合目标接口的序列化约定。请求体（JSON）不受此限制。