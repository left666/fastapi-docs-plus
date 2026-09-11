(function () {
  "use strict";

  var CONFIG = JSON.parse(document.getElementById("docs-plus-config").textContent);
  var ENV_STORAGE_KEY = "docsPlus.env";
  var LANGUAGE_STORAGE_KEY = "docsPlus.language";
  var Adapter = window.DocsPlusAdapter;
  var toastTimer = null;
  var language = readLanguage();
  var languageVersion = 0;
  var countsVersion = 0;
  var aiCounts = {};
  var MESSAGES = {
    en: {
      language: "Language",
      extraEnv: "Extra environment variables (JSON, sent to the pre_request hook with each request)",
      envSaved: "Environment variables saved",
      invalidEnv: "Invalid environment variables: enter a valid JSON object",
      noHook: "No pre_request hook registered",
      aiDisabled: "AI fill is disabled (missing DOCS_PLUS_LLM_API_KEY)",
      identity: "Identity",
      identityChanged: "Identity switched to {identity}",
      hookFailed: "Pre-request hook failed: {detail}",
      hookRequestFailed: "Pre-request hook request failed: {detail}",
      generate: "AI Generate",
      generating: "Generating…",
      generateTitle: "Generate parameters from this operation's schema and cache them without changing the form; use history to avoid duplicates",
      fill: "Fill ({count})",
      fillTitle: "Cycle through cached results and fill the form; the number in parentheses is the cache count",
      generated: "Generated and cached; {count} result(s) available for this operation",
      generateFailed: "AI generation failed: {detail}",
      filled: "Filled cached result {index}/{count} ({fields} fields)",
      parameterNotFound: "Parameter {parameter} not found in OpenAPI; skipped",
      paramActionMissing: "This Swagger UI version has no changeParamByIdentity action; update adapter.js to fill parameters",
      bodyActionMissing: "This Swagger UI version has no setRequestBodyValue action; update adapter.js to fill the request body",
    },
    zh: {
      language: "语言",
      extraEnv: "额外环境变量（JSON，会随每次请求传给 pre_request 钩子）",
      envSaved: "环境变量已保存",
      invalidEnv: "环境变量格式错误：请输入有效的 JSON 对象",
      noHook: "未注册 pre_request 钩子",
      aiDisabled: "AI 填充未启用（缺少 DOCS_PLUS_LLM_API_KEY）",
      identity: "调用身份",
      identityChanged: "调用身份已切换为 {identity}",
      hookFailed: "前置钩子执行失败：{detail}",
      hookRequestFailed: "前置钩子请求异常：{detail}",
      generate: "AI 生成",
      generating: "生成中…",
      generateTitle: "调用 LLM 按该接口 schema 生成一组入参并存入缓存队列（不改动表单）；历史结果会参与去重",
      fill: "填充 ({count})",
      fillTitle: "把缓存的生成结果轮换填入表单；括号内为当前缓存条数",
      generated: "已生成并缓存，该接口当前 {count} 条",
      generateFailed: "AI 生成失败：{detail}",
      filled: "已填充第 {index}/{count} 条缓存（{fields} 个字段）",
      parameterNotFound: "OpenAPI 中找不到参数 {parameter}，跳过回填",
      paramActionMissing: "当前 swagger-ui 版本没有 changeParamByIdentity action，参数回填需要适配 adapter.js",
      bodyActionMissing: "当前 swagger-ui 版本没有 setRequestBodyValue action，请求体回填需要适配 adapter.js",
    },
  };

  function readLanguage() {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "zh" ? "zh" : "en";
    } catch (err) {
      return "en";
    }
  }

  function t(key, values) {
    return MESSAGES[language][key].replace(/\{(\w+)\}/g, function (match, name) {
      return values && values[name] !== undefined ? String(values[name]) : match;
    });
  }

  function errorMessage(err) {
    return err.code && Object.prototype.hasOwnProperty.call(MESSAGES[language], err.code)
      ? t(err.code, err.values)
      : err.message;
  }

  function localizedElement(tag, key) {
    var element = document.createElement(tag);
    element.dataset.i18n = key;
    element.textContent = t(key);
    return element;
  }

  function refreshLanguage() {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = t(element.dataset.i18n);
    });
    var identityLabel = document.getElementById("docs-plus-identity-label");
    if (identityLabel) {
      var custom = CONFIG.identityLabel;
      identityLabel.textContent = (custom && typeof custom === "object" ? custom[language] : custom) || t("identity");
    }
    var textarea = document.querySelector("#docs-plus-bar textarea");
    if (textarea) textarea.setAttribute("aria-label", t("extraEnv"));
    document.querySelectorAll(".docs-plus-generate-btn").forEach(function (button) {
      button.textContent = t(button.disabled ? "generating" : "generate");
      button.title = t("generateTitle");
    });
    refreshFillButtons();
  }

  function changeLanguage(next) {
    if (next === language) return;
    language = next;
    languageVersion += 1;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch (err) {
      // Storage may be unavailable in private or embedded browsing contexts.
    }
    aiCounts = {};
    clearTimeout(toastTimer);
    document.getElementById("docs-plus-toast").hidden = true;
    refreshLanguage();
    loadCounts();
  }

  function readEnv() {
    try {
      var raw = JSON.parse(localStorage.getItem(ENV_STORAGE_KEY));
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function writeEnv(env) {
    localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(env));
  }

  function envPayload() {
    var env = readEnv();
    var payload = {};
    if (env.extra && typeof env.extra === "object") {
      Object.keys(env.extra).forEach(function (key) {
        payload[key] = env.extra[key];
      });
    }
    payload.identity = env.identity || null;
    return payload;
  }

  function toast(message, isError) {
    var el = document.getElementById("docs-plus-toast");
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, isError ? 8000 : 3000);
  }

  function buildBar() {
    var bar = document.getElementById("docs-plus-bar");
    var env = readEnv();

    var details = document.createElement("details");
    var summary = localizedElement("summary", "extraEnv");
    var textarea = document.createElement("textarea");
    textarea.spellcheck = false;
    textarea.value = JSON.stringify(env.extra || {}, null, 2);
    textarea.addEventListener("change", function () {
      var next = readEnv();
      try {
        var parsed = JSON.parse(textarea.value || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalidEnv");
        }
        next.extra = parsed;
        writeEnv(next);
        toast(t("envSaved"));
      } catch (err) {
        toast(t("invalidEnv"), true);
      }
    });
    details.appendChild(summary);
    details.appendChild(textarea);
    bar.appendChild(details);

    if (!CONFIG.hasPreRequestHook) {
      var hookNote = localizedElement("span", "noHook");
      hookNote.className = "docs-plus-note";
      bar.appendChild(hookNote);
    }

    if (!CONFIG.aiEnabled) {
      var aiNote = localizedElement("span", "aiDisabled");
      aiNote.className = "docs-plus-note";
      bar.appendChild(aiNote);
    }

    if (CONFIG.identities && CONFIG.identities.length) {
      var label = document.createElement("label");
      var caption = document.createElement("span");
      caption.id = "docs-plus-identity-label";
      label.appendChild(caption);
      var select = document.createElement("select");
      CONFIG.identities.forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
      select.value = env.identity || CONFIG.identities[0];
      select.addEventListener("change", function () {
        var next = readEnv();
        next.identity = select.value;
        writeEnv(next);
        toast(t("identityChanged", { identity: select.value }));
      });
      if (!env.identity) {
        env.identity = select.value;
        writeEnv(env);
      }
      label.appendChild(select);
      bar.appendChild(label);
    }

    var languageLabel = document.createElement("label");
    languageLabel.appendChild(localizedElement("span", "language"));
    var languageSelect = document.createElement("select");
    languageSelect.id = "docs-plus-language";
    [["en", "English"], ["zh", "简体中文"]].forEach(function (item) {
      var option = document.createElement("option");
      option.value = item[0];
      option.textContent = item[1];
      option.lang = item[0] === "zh" ? "zh-CN" : "en";
      languageSelect.appendChild(option);
    });
    languageSelect.value = language;
    languageSelect.addEventListener("change", function () {
      changeLanguage(languageSelect.value);
    });
    languageLabel.appendChild(languageSelect);
    bar.appendChild(languageLabel);
    refreshLanguage();
  }

  function stringifyHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      var value = headers[key];
      if (value !== null && value !== undefined) out[key] = String(value);
    });
    return out;
  }

  async function applyPreRequest(request) {
    if (!CONFIG.hasPreRequestHook) return request;
    if ((request.url || "").indexOf(CONFIG.apiPrefix + "/api/") !== -1) return request;
    try {
      var response = await fetch(CONFIG.apiPrefix + "/api/pre-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: request.method || "GET",
          url: request.url,
          headers: stringifyHeaders(request.headers),
          env: envPayload(),
        }),
      });
      if (!response.ok) {
        toast(t("hookFailed", { detail: (await response.text()).slice(0, 400) }), true);
        return request;
      }
      var patch = await response.json();
      if (patch.headers) request.headers = patch.headers;
      if (patch.query) {
        var url = new URL(request.url, window.location.origin);
        url.search = new URLSearchParams(patch.query).toString();
        request.url = url.toString();
      }
    } catch (err) {
      toast(t("hookRequestFailed", { detail: err.message }), true);
    }
    return request;
  }

  function opKey(target) {
    return target.method.toUpperCase() + " " + target.path;
  }

  function getCount(target) {
    return aiCounts[opKey(target)] || 0;
  }

  function refreshFillButtons() {
    document.querySelectorAll(".docs-plus-fill-btn").forEach(function (btn) {
      var count = aiCounts[btn.getAttribute("data-op-key")] || 0;
      btn.textContent = t("fill", { count: count });
      btn.title = t("fillTitle");
      btn.classList.toggle("is-empty", count === 0);
      btn.setAttribute("aria-disabled", count === 0 ? "true" : "false");
    });
  }

  function setCount(target, count) {
    countsVersion += 1;
    aiCounts[opKey(target)] = count;
    refreshFillButtons();
  }

  async function loadCounts() {
    if (!CONFIG.aiEnabled) return;
    var version = ++countsVersion;
    var requestVersion = languageVersion;
    try {
      var response = await fetch(CONFIG.apiPrefix + "/api/ai/cache?language=" + language);
      if (!response.ok) return;
      var data = await response.json();
      if (requestVersion !== languageVersion || version !== countsVersion) return;
      aiCounts = data.counts || {};
      refreshFillButtons();
    } catch (err) {
      // The next successful AI operation will resynchronize the cache count.
    }
  }

  async function postAi(pathSeg, target, requestLanguage) {
    var response = await fetch(CONFIG.apiPrefix + pathSeg, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target.path, method: target.method, language: requestLanguage }),
    });
    var text = await response.text();
    if (!response.ok) {
      var detail = text;
      try {
        detail = JSON.parse(text).detail || text;
      } catch (err) {
        // Non-JSON responses retain their original error text.
      }
      var error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  }

  async function handleGenerate(target, button) {
    if (button.disabled) return;
    var requestVersion = languageVersion;
    button.disabled = true;
    button.textContent = t("generating");
    try {
      var data = await postAi("/api/ai/generate", target, language);
      if (requestVersion !== languageVersion) return;
      setCount(target, data.count);
      toast(t("generated", { count: data.count }));
    } catch (err) {
      if (requestVersion !== languageVersion) return;
      toast(t("generateFailed", { detail: errorMessage(err) }), true);
    } finally {
      button.disabled = false;
      button.textContent = t("generate");
      if (requestVersion !== languageVersion) loadCounts();
    }
  }

  function applyEnvelope(system, target, data) {
    var filled = 0;
    ["path", "query", "header", "cookie"].forEach(function (location) {
      var values = data[location] || {};
      Object.keys(values).forEach(function (name) {
        try {
          Adapter.setParamValue(system, target.path, target.method, name, location, values[name]);
          filled += 1;
        } catch (err) {
          toast(errorMessage(err), true);
        }
      });
    });
    if (data.body !== null && data.body !== undefined) {
      Adapter.setRequestBody(system, target.path, target.method, data.body);
      filled += 1;
    }
    Adapter.validateParams(system, target.path, target.method);
    return filled;
  }

  async function handleFill(system, target, button) {
    if (getCount(target) === 0 || button.dataset.busy) return;
    var requestVersion = languageVersion;
    button.dataset.busy = "1";
    try {
      var data = await postAi("/api/ai/fill", target, language);
      if (requestVersion !== languageVersion) return;
      setCount(target, data.cacheCount);
      await Adapter.ensureOperationExpanded(button);
      if (requestVersion !== languageVersion) return;
      var filled = applyEnvelope(system, target, data);
      toast(t("filled", { index: data.cacheIndex + 1, count: data.cacheCount, fields: filled }));
    } catch (err) {
      if (requestVersion !== languageVersion) return;
      if (err.status === 409) setCount(target, 0);
      toast(errorMessage(err), true);
    } finally {
      delete button.dataset.busy;
      refreshFillButtons();
    }
  }

  function AiFillPlugin(system) {
    return {
      wrapComponents: {
        OperationSummary: function (Original, deps) {
          var React = deps.React;
          return function (props) {
            var target = Adapter.readPathMethod(props);
            var children = [React.createElement(Original, Object.assign({ key: "summary" }, props))];
            if (target) {
              children.push(
                React.createElement(
                  "button",
                  {
                    key: "ai-generate",
                    type: "button",
                    className: "docs-plus-ai-btn docs-plus-generate-btn",
                    title: t("generateTitle"),
                    onClick: function (event) {
                      event.preventDefault();
                      event.stopPropagation();
                      handleGenerate(target, event.currentTarget);
                    },
                  },
                  t("generate")
                ),
                React.createElement(
                  "button",
                  {
                    key: "ai-fill",
                    type: "button",
                    className:
                      "docs-plus-ai-btn docs-plus-fill-btn" + (getCount(target) === 0 ? " is-empty" : ""),
                    "data-op-key": opKey(target),
                    "aria-disabled": getCount(target) === 0 ? "true" : "false",
                    title: t("fillTitle"),
                    onClick: function (event) {
                      event.preventDefault();
                      event.stopPropagation();
                      handleFill(system, target, event.currentTarget);
                    },
                  },
                  t("fill", { count: getCount(target) })
                )
              );
            }
            return React.createElement("div", { className: "docs-plus-op-summary" }, children);
          };
        },
      },
    };
  }

  window.addEventListener("load", function () {
    buildBar();
    var params = Object.assign({}, CONFIG.swaggerUiParameters, {
      url: CONFIG.openapiUrl,
      dom_id: "#swagger-ui",
      deepLinking: true,
      layout: "BaseLayout",
      presets: [window.SwaggerUIBundle.presets.apis],
      plugins: CONFIG.aiEnabled ? [AiFillPlugin] : [],
      requestInterceptor: applyPreRequest,
    });
    window.ui = window.SwaggerUIBundle(params);
    loadCounts();
  });
})();
