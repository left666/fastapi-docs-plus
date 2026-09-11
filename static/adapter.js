/**
 * swagger-ui 内部 action/selector 不是稳定公开 API，跨版本会变。
 * 所有对它们的调用只允许出现在这个文件里，升级 swagger-ui 时只需改这里。
 * 已验证版本：swagger-ui-dist 5.x
 */
(function () {
  "use strict";

  /**
   * 必须取「未合并 meta」的原始参数对象：
   * swagger-ui 把参数值存在 `${in}.${name}.hash-${param.hashCode()}` 下，
   * 而 ParameterRow 读的是原始参数算出的 hash。用 operationWithMeta 拿到的对象
   * 带 value/errors，hashCode 不同，写入会落到没人读的键上，表现为静默失效。
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

  function toFieldValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    // 数组参数的输入组件期望数组本身，序列化会导致 swagger-ui 渲染成单个字符串项
    if (Array.isArray(value)) return value.map(toFieldValue);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function adapterError(code, message, values) {
    var error = new Error(message);
    error.code = code;
    error.values = values;
    return error;
  }

  window.DocsPlusAdapter = {
    /**
     * 折叠状态下 RequestBody 组件尚未挂载，它挂载时会用自动生成的样例覆盖我们写入的值，
     * 所以回填前必须先把接口展开。
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

    setRequestBody: function (system, path, method, value) {
      var text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (system.oas3Actions && system.oas3Actions.setRequestBodyValue) {
        system.oas3Actions.setRequestBodyValue({ value: text, pathMethod: [path, method] });
        return true;
      }
      throw adapterError("bodyActionMissing", "Swagger UI is missing the setRequestBodyValue action");
    },

    validateParams: function (system, path, method) {
      try {
        if (system.specActions && system.specActions.validateParams) {
          system.specActions.validateParams([path, method], false);
        }
      } catch (err) {
        /* 校验只是顺手触发，失败不影响回填结果 */
      }
    },

    /** 从 OperationSummary 的 props 里读出 path/method */
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
