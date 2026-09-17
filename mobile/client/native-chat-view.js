(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoNativeChatView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function previewText(value, limit) {
    const text = String(value || '').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}…`;
  }

  function formatToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  function renderBlock(block) {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') {
      return `<div class="native-chat-text">${escapeHtml(block.text)}</div>`;
    }
    if (block.type === 'image-ref') {
      const label = block.path || block.url || block.alt || 'image';
      return `<div class="native-chat-image">${escapeHtml(label)}</div>`;
    }
    if (block.type === 'tool-call') {
      const body = escapeHtml(previewText(formatToolInput(block.input), 800));
      return `<details class="native-chat-tool"><summary>${escapeHtml(block.name || 'tool')}</summary><pre>${body}</pre></details>`;
    }
    if (block.type === 'tool-result') {
      const cls = block.isError ? ' native-chat-tool-error' : '';
      return `<details class="native-chat-tool${cls}"><summary>结果</summary><pre>${escapeHtml(previewText(block.output, 4000))}</pre></details>`;
    }
    if (block.type === 'subagent-group') {
      const names = (block.agents || []).map(agent => agent.label || agent.id).join(', ');
      return `<div class="native-chat-system">${escapeHtml(names || 'subagent')}</div>`;
    }
    return '';
  }

  function renderMessage(message) {
    const role = message.role || 'assistant';
    const body = (message.blocks || []).map(renderBlock).join('');
    if (!body) return '';
    return `<article class="native-chat-msg native-chat-${escapeHtml(role)}">${body}</article>`;
  }

  function snapshotSignature(snapshot) {
    if (!snapshot) return 'loading';
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const last = messages[messages.length - 1];
    const lastLen = (last?.blocks || []).reduce((sum, block) => {
      if (!block) return sum;
      if (typeof block.text === 'string') return sum + block.text.length;
      if (typeof block.output === 'string') return sum + block.output.length;
      return sum;
    }, 0);
    return [
      snapshot.supported,
      snapshot.ready,
      snapshot.notFound,
      snapshot.error || '',
      messages.length,
      last?.id || '',
      lastLen,
    ].join('|');
  }

  const lastSignature = new WeakMap();

  function render(container, snapshot) {
    if (!container) return;
    const signature = snapshotSignature(snapshot);
    if (lastSignature.get(container) === signature) return;
    lastSignature.set(container, signature);
    if (!snapshot) {
      container.innerHTML = '<div class="native-chat-empty">正在读取对话…</div>';
      return;
    }
    if (!snapshot.supported) {
      container.innerHTML = '<div class="native-chat-empty">这个会话没有结构化对话，请切到终端。</div>';
      return;
    }
    if (snapshot.error && !snapshot.notFound) {
      container.innerHTML = `<div class="native-chat-empty">${escapeHtml(snapshot.error)}</div>`;
      return;
    }
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    if (!messages.length) {
      container.innerHTML = `<div class="native-chat-empty">${
        snapshot.notFound ? '还没有对话记录，发一条就会出现在这里。' : '正在读取对话…'
      }</div>`;
      return;
    }
    container.innerHTML = messages.map(renderMessage).join('');
  }

  return { render, escapeHtml };
});
