/**
 * fastapi-docs-plus frontend bootstrap.
 *
 * Renders the top bar (extra environment variables / identity / language),
 * patches outgoing requests through the server-side pre-request hooks, and
 * injects AI generate / fill buttons into every operation summary.
 */
(function () {
  "use strict";

  /** Configuration injected by docs_plus.py at render time. */
  var CONFIG = JSON.parse(document.getElementById("docs-plus-config").textContent);
  var ENV_STORAGE_KEY = "docsPlus.env";
  var LANGUAGE_STORAGE_KEY = "docsPlus.language";
  var Adapter = window.DocsPlusAdapter;
  var toastTimer = null;
  var language = readLanguage();
  var languageVersion = 0;
  var countsVersion = 0;
  var aiCounts = {};

  /** Localized UI strings; also covers error codes thrown by adapter.js. */
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
      language: "\u8BED\u8A00",
      extraEnv: "\u989D\u5916\u73AF\u5883\u53D8\u91CF\uFF08JSON\uFF0C\u4F1A\u968F\u6BCF\u6B21\u8BF7\u6C42\u4F20\u7ED9 pre_request \u94A9\u5B50\uFF09",
      envSaved: "\u73AF\u5883\u53D8\u91CF\u5DF2\u4FDD\u5B58",
      invalidEnv: "\u73AF\u5883\u53D8\u91CF\u683C\u5F0F\u9519\u8BEF\uFF1A\u8BF7\u8F93\u5165\u6709\u6548\u7684 JSON \u5BF9\u8C61",
      noHook: "\u672A\u6CE8\u518C pre_request \u94A9\u5B50",
      aiDisabled: "AI \u586B\u5145\u672A\u542F\u7528\uFF08\u7F3A\u5C11 DOCS_PLUS_LLM_API_KEY\uFF09",
      identity: "\u8C03\u7528\u8EAB\u4EFD",
      identityChanged: "\u8C03\u7528\u8EAB\u4EFD\u5DF2\u5207\u6362\u4E3A {identity}",
      hookFailed: "\u524D\u7F6E\u94A9\u5B50\u6267\u884C\u5931\u8D25\uFF1A{detail}",
      hookRequestFailed: "\u524D\u7F6E\u94A9\u5B50\u8BF7\u6C42\u5F02\u5E38\uFF1A{detail}",
      generate: "AI \u751F\u6210",
      generating: "\u751F\u6210\u4E2D…",
      generateTitle: "\u8C03\u7528 LLM \u6309\u8BE5\u63A5\u53E3 schema \u751F\u6210\u4E00\u7EC4\u5165\u53C2\u5E76\u5B58\u5165\u7F13\u5B58\u961F\u5217\uFF08\u4E0D\u6539\u52A8\u8868\u5355\uFF09\uFF1B\u5386\u53F2\u7ED3\u679C\u4F1A\u53C2\u4E0E\u53BB\u91CD",
      fill: "\u586B\u5145 ({count})",
      fillTitle: "\u628A\u7F13\u5B58\u7684\u751F\u6210\u7ED3\u679C\u8F6E\u6362\u586B\u5165\u8868\u5355\uFF1B\u62EC\u53F7\u5185\u4E3A\u5F53\u524D\u7F13\u5B58\u6761\u6570",
      generated: "\u5DF2\u751F\u6210\u5E76\u7F13\u5B58\uFF0C\u8BE5\u63A5\u53E3\u5F53\u524D {count} \u6761",
      generateFailed: "AI \u751F\u6210\u5931\u8D25\uFF1A{detail}",
      filled: "\u5DF2\u586B\u5145\u7B2C {index}/{count} \u6761\u7F13\u5B58\uFF08{fields} \u4E2A\u5B57\u6BB5\uFF09",
      parameterNotFound: "OpenAPI \u4E2D\u627E\u4E0D\u5230\u53C2\u6570 {parameter}\uFF0C\u8DF3\u8FC7\u56DE\u586B",
      paramActionMissing: "\u5F53\u524D swagger-ui \u7248\u672C\u6CA1\u6709 changeParamByIdentity action\uFF0C\u53C2\u6570\u56DE\u586B\u9700\u8981\u9002\u914D adapter.js",
      bodyActionMissing: "\u5F53\u524D swagger-ui \u7248\u672C\u6CA1\u6709 setRequestBodyValue action\uFF0C\u8BF7\u6C42\u4F53\u56DE\u586B\u9700\u8981\u9002\u914D adapter.js",
    },
  };

  /**
   * Read the persisted UI language.
   *
   * @returns {"en"|"zh"} Stored language, defaulting to "en".
   */
  function readLanguage() {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "zh" ? "zh" : "en";
    } catch (err) {
      return "en";
    }
  }

  /**
   * Interpolate {placeholder} tokens in a localized message.
   *
   * @param {string} key - Key in MESSAGES[language].
   * @param {Object} [values] - Replacement values keyed by placeholder name.
   * @returns {string} Localized message with placeholders resolved.
   */
  function t(key, values) {
    return MESSAGES[language][key].replace(/\{(\w+)\}/g, function (match, name) {
      return values && values[name] !== undefined ? String(values[name]) : match;
    });
  }

  /**
   * Resolve an error to a localized message.
   *
   * Errors carrying a `code` recognised by the current language table are
   * localised; everything else falls back to `err.message`.
   *
   * @param {Error} err - Error thrown by adapter.js or a fetch call.
   * @returns {string} Human-readable message.
   */
  function errorMessage(err) {
    return err.code && Object.prototype.hasOwnProperty.call(MESSAGES[language], err.code)
      ? t(err.code, err.values)
      : err.message;
  }

  /**
   * Create an element whose text content is bound to an i18n key.
   *
   * The returned element has a `data-i18n` attribute so that
   * {@link refreshLanguage} can update it later.
   *
   * @param {string} tag - HTML tag name.
   * @param {string} key - Key in MESSAGES[language].
   * @returns {HTMLElement} Element with `data-i18n` set and translated text.
   */
  function localizedElement(tag, key) {
    var element = document.createElement(tag);
    element.dataset.i18n = key;
    element.textContent = t(key);
    return element;
  }

  /**
   * Re-apply translations to every element tagged with `data-i18n`.
   */
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

  /**
   * Switch the UI language and resynchronise AI cache counts.
   *
   * @param {"en"|"zh"} next - Target language.
   */
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

  /**
   * Read persisted environment variables.
   *
   * @returns {Object} Stored environment object, or {} when unset / invalid.
   */
  function readEnv() {
    try {
      var raw = JSON.parse(localStorage.getItem(ENV_STORAGE_KEY));
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      return {};
    }
  }

  /**
   * Persist environment variables.
   *
   * @param {Object} env - Environment object to store.
   */
  function writeEnv(env) {
    localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(env));
  }

  /**
   * Build the environment payload sent to the pre-request endpoint.
   *
   * Merges the extra environment JSON into the top level and adds the
   * selected identity.
   *
   * @returns {Object} Payload for the `env` field of the pre-request body.
   */
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

  /**
   * Show a transient toast message.
   *
   * @param {string} message - Message text.
   * @param {boolean} [isError] - When true, render as an error (longer
   *   timeout, red background).
   */
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

  /**
   * Build the top bar: extra environment editor, identity and language selectors.
   */
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
    [["en", "English"], ["zh", "\u7B80\u4F53\u4E2D\u6587"]].forEach(function (item) {
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

  /**
   * Convert header values to strings, dropping null/undefined entries.
   *
   * @param {Object} [headers] - Raw headers from Swagger UI.
   * @returns {Object} Stringified headers.
   */
  function stringifyHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      var value = headers[key];
      if (value !== null && value !== undefined) out[key] = String(value);
    });
    return out;
  }

  /**
   * Swagger UI request interceptor: run the server-side pre-request hook.
   *
   * Sends the pending request to ``{apiPrefix}/api/pre-request``, then
   * applies the returned header / query patches in place.  Internal API
   * calls originating from this plugin are skipped.
   *
   * @param {Object} request - Request object provided by Swagger UI's
   *   requestInterceptor.
   * @returns {Promise<Object>} The (possibly patched) request.
   */
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

  /**
   * Cache key for an operation.
   *
   * @param {{path: string, method: string}} target - Operation target.
   * @returns {string} Cache key of the form ``"METHOD path"``.
   */
  function opKey(target) {
    return target.method.toUpperCase() + " " + target.path;
  }

  /**
   * Cached result count for an operation.
   *
   * @param {{path: string, method: string}} target - Operation target.
   * @returns {number} Number of cached AI-generated results, or 0.
   */
  function getCount(target) {
    return aiCounts[opKey(target)] || 0;
  }

  /**
   * Refresh labels and ``aria-disabled`` state of every fill button.
   */
  function refreshFillButtons() {
    document.querySelectorAll(".docs-plus-fill-btn").forEach(function (btn) {
      var count = aiCounts[btn.getAttribute("data-op-key")] || 0;
      btn.textContent = t("fill", { count: count });
      btn.title = t("fillTitle");
      btn.classList.toggle("is-empty", count === 0);
      btn.setAttribute("aria-disabled", count === 0 ? "true" : "false");
    });
  }

  /**
   * Update the cached result count of one operation and refresh fill buttons.
   *
   * @param {{path: string, method: string}} target - Operation target.
   * @param {number} count - New cached result count.
   */
  function setCount(target, count) {
    countsVersion += 1;
    aiCounts[opKey(target)] = count;
    refreshFillButtons();
  }

  /**
   * Fetch cache counts for all operations of the current language.
   */
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
      // The next successful AI operation will resynchronise the cache count.
    }
  }

  /**
   * POST to an AI endpoint and parse the JSON response.
   *
   * @param {string} pathSeg - Endpoint path relative to ``CONFIG.apiPrefix``.
   * @param {{path: string, method: string}} target - Operation target.
   * @param {"en"|"zh"} requestLanguage - Output language for the request.
   * @returns {Promise<Object>} Parsed response body.
   */
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

  /**
   * Handle an "AI Generate" click: call the generation endpoint, cache, and
   * update the count badge.
   *
   * @param {{path: string, method: string}} target - Operation target.
   * @param {HTMLButtonElement} button - The clicked "AI Generate" button.
   */
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

  /**
   * Write a cached result envelope into the operation's form fields.
   *
   * @param {Object} system - Swagger UI system object.
   * @param {{path: string, method: string}} target - Operation target.
   * @param {Object} data - Envelope with ``path``, ``query``, ``header``,
   *   ``cookie`` and ``body`` keys.
   * @returns {number} Number of fields successfully filled.
   */
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

  /**
   * Handle a "Fill" click: fetch the next cached result and apply it to the
   * form.
   *
   * @param {Object} system - Swagger UI system object.
   * @param {{path: string, method: string}} target - Operation target.
   * @param {HTMLButtonElement} button - The clicked "Fill" button.
   */
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

  /**
   * Swagger UI plugin providing the per-operation AI buttons.
   *
   * @param {Object} system - Swagger UI system object injected by the
   *   plugin system.
   * @returns {Object} Plugin descriptor wrapping the ``OperationSummary``
   *   component.
   */
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

  // Bootstrap: build the top bar and start Swagger UI.
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