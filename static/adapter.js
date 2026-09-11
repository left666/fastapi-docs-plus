/**
 * Compatibility layer for Swagger UI internals.
 *
 * Swagger UI's internal actions and selectors are not a stable public API and
 * may change between releases. Every call into them is confined to this file,
 * so upgrading Swagger UI only requires adapting this module.
 * Verified against: swagger-ui-dist 5.x
 */
(function () {
  "use strict";

  /**
   * Find the raw (meta-free) parameter object for the given name and location.
   *
   * Swagger UI stores parameter values under keys of the form
   * `${in}.${name}.hash-${param.hashCode()}`, where the hash is computed from
   * the raw parameter object that ParameterRow reads. Objects returned by
   * `operationWithMeta()` carry `value` / `errors` fields, produce a different
   * hash, and writing through them lands on a key nobody reads, failing
   * silently.
   *
   * @param {Object} system - Swagger UI system object.
   * @param {string} path - Operation path, e.g. "/shops/{shop_id}".
   * @param {string} method - Lowercase HTTP method, e.g. "get".
   * @param {string} name - Parameter name.
   * @param {string} location - One of "path", "query", "header", "cookie".
   * @returns {Object|null} Raw parameter object, or null when not found.
   */
  function findRawParam(system, path, method, name, location) {
    var selectors = system.specSelectors;
    var specs = [];
    try {
      if (selectors.specJsonWithResolvedSubtrees) specs.push(selectors.specJsonWithResolvedSubtrees());
      if (selectors.specJson) specs.push(selectors.specJson());
    } catch (err) {
      return null;
    }
    var containers = [
      ["paths", path, method, "parameters"],
      ["paths", path, "parameters"],
    ];
    for (var i = 0; i < specs.length; i++) {
      for (var j = 0; j < containers.length; j++) {
        var params = specs[i] && specs[i].getIn ? specs[i].getIn(containers[j]) : null;
        if (!params || !params.find) continue;
        var found = params.find(function (p) {
          return p.get("name") === name && p.get("in") === location;
        });
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Convert a JSON value into the shape expected by Swagger UI field components.
   *
   * Array parameters are returned as arrays because the array input component
   * expects the array itself; serializing them would render a single string item.
   *
   * @param {*} value - Raw JSON value.
   * @returns {string|Array} Value ready to be written into the form field.
   */
  function toFieldValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(toFieldValue);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  /**
   * Build an Error carrying a message code and its interpolation values.
   *
   * @param {string} code - Message code recognized by docs-plus.js.
   * @param {string} message - Fallback English message.
   * @param {Object} [values] - Values interpolated into the localized message.
   * @returns {Error} Decorated error object.
   */
  function adapterError(code, message, values) {
    var error = new Error(message);
    error.code = code;
    error.values = values;
    return error;
  }

  window.DocsPlusAdapter = {
    /**
     * Expand the operation block so its RequestBody component gets mounted.
     *
     * While collapsed, the RequestBody component is not mounted yet and its
     * automatically generated example overwrites the values we write on mount,
     * so the block must be expanded before filling anything.
     *
     * @param {HTMLElement} button - AI button inside the operation summary.
     * @returns {Promise<void>} Resolves once the block is expanded, or
     *   immediately when it is already expanded.
     */
    ensureOperationExpanded: function (button) {
      var block = button && button.closest ? button.closest(".opblock") : null;
      if (!block || block.querySelector(".opblock-body")) return Promise.resolve();
      var control = block.querySelector(".opblock-summary-control");
      if (!control) return Promise.resolve();
      control.click();
      return new Promise(function (resolve) {
        setTimeout(resolve, 350);
      });
    },

    /**
     * Write a value into a single parameter field.
     *
     * @param {Object} system - Swagger UI system object.
     * @param {string} path - Operation path, e.g. "/shops/{shop_id}".
     * @param {string} method - Lowercase HTTP method, e.g. "get".
     * @param {string} name - Parameter name.
     * @param {string} location - One of "path", "query", "header", "cookie".
     * @param {*} value - Value to write.
     * @returns {boolean} True on success.
     * @throws {Error} With code "parameterNotFound" when the parameter is not
     *   declared in the OpenAPI document, or "paramActionMissing" when the
     *   Swagger UI version lacks the required action.
     */
    setParamValue: function (system, path, method, name, location, value) {
      var param = findRawParam(system, path, method, name, location);
      if (!param) {
        throw adapterError("parameterNotFound", "Parameter not found in OpenAPI: " + location + "." + name, {
          parameter: location + "." + name,
        });
      }
      if (!system.specActions || !system.specActions.changeParamByIdentity) {
        throw adapterError("paramActionMissing", "Swagger UI is missing the changeParamByIdentity action");
      }
      system.specActions.changeParamByIdentity([path, method], param, toFieldValue(value), false);
      return true;
    },

    /**
     * Write the request body into the body editor.
     *
     * @param {Object} system - Swagger UI system object.
     * @param {string} path - Operation path, e.g. "/shops/{shop_id}".
     * @param {string} method - Lowercase HTTP method, e.g. "post".
     * @param {*} value - Body value; non-strings are pretty-printed as JSON.
     * @returns {boolean} True on success.
     * @throws {Error} With code "bodyActionMissing" when the Swagger UI
     *   version lacks the required action.
     */
    setRequestBody: function (system, path, method, value) {
      var text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (system.oas3Actions && system.oas3Actions.setRequestBodyValue) {
        system.oas3Actions.setRequestBodyValue({ value: text, pathMethod: [path, method] });
        return true;
      }
      throw adapterError("bodyActionMissing", "Swagger UI is missing the setRequestBodyValue action");
    },

    /**
     * Trigger parameter validation after filling.
     *
     * Validation is best-effort; a failure does not affect the filled values.
     *
     * @param {Object} system - Swagger UI system object.
     * @param {string} path - Operation path, e.g. "/shops/{shop_id}".
     * @param {string} method - Lowercase HTTP method, e.g. "get".
     */
    validateParams: function (system, path, method) {
      try {
        if (system.specActions && system.specActions.validateParams) {
          system.specActions.validateParams([path, method], false);
        }
      } catch (err) {
        /* Validation is best-effort; failures must not affect the filled values. */
      }
    },

    /**
     * Read the path and method from an OperationSummary component's props.
     *
     * @param {Object} props - Props of the OperationSummary component.
     * @returns {{path: string, method: string}|null} Path and method, or null
     *   when they cannot be determined.
     */
    readPathMethod: function (props) {
      var operationProps = props && props.operationProps;
      if (operationProps && typeof operationProps.get === "function") {
        var path = operationProps.get("path");
        var method = operationProps.get("method");
        if (path && method) return { path: path, method: method };
      }
      if (props && props.path && props.method) {
        return { path: props.path, method: props.method };
      }
      return null;
    },
  };
})();
