(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  root.DuoChatHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function getApiErrorMessage(status, payload) {
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    return `请求失败 (${status})`;
  }

  function ensureApiSuccess(ok, status, payload) {
    if (!ok) {
      throw new Error(getApiErrorMessage(status, payload));
    }
    return payload;
  }

  function mergePendingMessages(history, pendingMessages) {
    const safeHistory = Array.isArray(history) ? history : [];
    const safePending = Array.isArray(pendingMessages) ? pendingMessages : [];
    const remainingPending = [];

    for (const pending of safePending) {
      const matched = safeHistory.some((msg) => {
        return msg != null
          && msg.role === pending.role
          && msg.content === pending.content;
      });
      if (!matched) {
        remainingPending.push(pending);
      }
    }

    return {
      messages: safeHistory.concat(remainingPending),
      pendingMessages: remainingPending,
    };
  }

  function getResumeAgentLabel(agent) {
    if (agent === 'codex') return 'Codex';
    if (agent === 'claude') return 'Claude Code';
    if (agent === 'copilot') return 'GitHub Copilot';
    return 'Agent';
  }

  return {
    ensureApiSuccess,
    getResumeAgentLabel,
    getApiErrorMessage,
    mergePendingMessages,
  };
});
