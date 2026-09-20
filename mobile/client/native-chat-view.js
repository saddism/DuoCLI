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

  const CODE_KEYWORDS = new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'do', 'else',
    'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'interface',
    'let', 'new', 'of', 'return', 'static', 'switch', 'throw', 'try', 'type', 'var', 'while', 'with',
    'yield', 'public', 'private', 'protected', 'readonly', 'enum', 'implements', 'package', 'select',
    'where', 'insert', 'update', 'delete', 'create', 'table', 'and', 'or', 'not', 'as', 'is', 'lambda',
  ]);
  const CODE_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil']);

  function codeLanguageLabel(language) {
    const value = String(language || '').trim().toLowerCase();
    const aliases = { js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', py: 'Python', sh: 'Shell', bash: 'Shell', zsh: 'Shell', json: 'JSON', html: 'HTML', css: 'CSS', sql: 'SQL' };
    return aliases[value] || (value ? value.toUpperCase() : 'CODE');
  }

  function highlightCode(value, language) {
    const code = String(value || '');
    const lang = String(language || '').toLowerCase();
    const hashComments = ['py', 'python', 'sh', 'bash', 'zsh', 'shell'].includes(lang);
    let html = '';
    let index = 0;
    while (index < code.length) {
      const rest = code.slice(index);
      const lineComment = rest.startsWith('//') || (hashComments && rest.startsWith('#'));
      if (lineComment) {
        const end = code.indexOf('\n', index);
        const next = end < 0 ? code.length : end;
        html += `<span class="tok-comment">${escapeHtml(code.slice(index, next))}</span>`;
        index = next;
        continue;
      }
      if (rest.startsWith('/*')) {
        const end = code.indexOf('*/', index + 2);
        const next = end < 0 ? code.length : end + 2;
        html += `<span class="tok-comment">${escapeHtml(code.slice(index, next))}</span>`;
        index = next;
        continue;
      }
      const quote = code[index];
      if (quote === '"' || quote === "'" || quote === '`') {
        let next = index + 1;
        while (next < code.length) {
          if (code[next] === '\\') { next += 2; continue; }
          if (code[next++] === quote) break;
        }
        html += `<span class="tok-string">${escapeHtml(code.slice(index, next))}</span>`;
        index = next;
        continue;
      }
      const number = rest.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)/i);
      if (number) {
        html += `<span class="tok-number">${escapeHtml(number[0])}</span>`;
        index += number[0].length;
        continue;
      }
      const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
      if (identifier) {
        const word = identifier[0];
        const normalized = word.toLowerCase();
        const cls = CODE_KEYWORDS.has(normalized) ? 'tok-keyword' : CODE_LITERALS.has(normalized) ? 'tok-literal' : '';
        html += cls ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word);
        index += word.length;
        continue;
      }
      if (/^[=+!*%&|<>?:~-]$/.test(code[index])) html += `<span class="tok-operator">${escapeHtml(code[index])}</span>`;
      else html += escapeHtml(code[index]);
      index++;
    }
    return html;
  }

  function renderCode(value, language) {
    const label = codeLanguageLabel(language);
    return `<div class="native-chat-code-wrap"><div class="native-chat-code-head"><span>${escapeHtml(label)}</span><button type="button" class="native-chat-copy">复制代码</button></div><pre class="native-chat-code"><code>${highlightCode(value, language)}</code></pre></div>`;
  }

  function renderText(value) {
    const source = String(value || '');
    let html = '';
    let cursor = 0;
    const fence = /```([A-Za-z0-9_+-]*)[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```/g;
    for (let match = fence.exec(source); match; match = fence.exec(source)) {
      html += escapeHtml(source.slice(cursor, match.index)).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      html += renderCode(match[2], match[1]);
      cursor = match.index + match[0].length;
    }
    return html + escapeHtml(source.slice(cursor)).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
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
      return `<div class="native-chat-text">${renderText(block.text)}</div>`;
    }
    if (block.type === 'image-ref') {
      const label = block.path || block.url || block.alt || 'image';
      if (block.path) return `<button type="button" class="native-chat-image" data-chat-path="${escapeHtml(block.path)}">${escapeHtml(label)}</button>`;
      if (/^https?:\/\//i.test(block.url || '')) return `<a class="native-chat-image" href="${escapeHtml(block.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      return `<div class="native-chat-image">${escapeHtml(label)}</div>`;
    }
    if (block.type === 'tool-call') {
      const body = escapeHtml(formatToolInput(block.input));
      const states = { running: '进行中', completed: '已完成', failed: '失败' };
      const state = block.state && states[block.state]
        ? `<span class="native-chat-tool-state state-${escapeHtml(block.state)}">${states[block.state]}</span>` : '';
      return `<details class="native-chat-tool"><summary><span class="native-chat-tool-name">${escapeHtml(block.name || 'tool')}</span>${state}<button type="button" class="native-chat-copy">复制</button></summary><pre>${body}</pre></details>`;
    }
    if (block.type === 'tool-result') {
      const cls = block.isError ? ' native-chat-tool-error' : '';
      const call = block.callId ? ` · ${block.callId}` : '';
      return `<details class="native-chat-tool${cls}"><summary>结果${escapeHtml(call)}<button type="button" class="native-chat-copy">复制</button></summary><pre>${escapeHtml(block.output)}</pre></details>`;
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
    const deliveryState = /未确认|失败/.test(message.localStatus || '') ? 'error'
      : /发送中/.test(message.localStatus || '') ? 'sending'
        : /等待/.test(message.localStatus || '') ? 'waiting' : 'ready';
    const status = message.localStatus ? `<div class="native-chat-delivery state-${deliveryState}"><span class="native-chat-state-dot" aria-hidden="true"></span>${escapeHtml(message.localStatus)}</div>` : '';
    const labels = { user: '你', assistant: '助手', tool: '工具', reasoning: '思考', system: '状态' };
    const time = Number.isFinite(message.timestamp) ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const meta = `<div class="native-chat-meta">${escapeHtml(labels[role] || role)}${time ? ` · ${escapeHtml(time)}` : ''}</div>`;
    return `<article class="native-chat-msg native-chat-${escapeHtml(role)}">${meta}${body}${status}</article>`;
  }

  function countUserText(messages, text) {
    return (messages || []).filter(message => message.role === 'user'
      && (message.blocks || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim() === text.trim()).length;
  }

  function mergeLocalMessages(snapshot, pending) {
    const messages = snapshot?.messages || [];
    const remaining = pending.filter(item => snapshot?.submissionTracking
      ? !messages.some(message => message.submissionId === item.id)
      : countUserText(messages, item.text) < item.occurrence);
    return {
      pending: remaining,
      snapshot: remaining.length ? {
        ...snapshot,
        supported: true,
        messages: messages.concat(remaining.map(item => ({
          id: `local:${item.id}`, role: 'user', blocks: [{ type: 'text', text: item.text }],
          localStatus: item.status,
        }))),
      } : snapshot,
    };
  }

  function snapshotSignature(snapshot) {
    if (!snapshot) return 'loading';
    return JSON.stringify(snapshot);
  }

  const lastSignature = new WeakMap();
  const messageNodes = new WeakMap();
  const boundContainers = new WeakSet();
  const visibleLimits = new WeakMap();
  const lastSnapshots = new WeakMap();

  function bindContainer(container) {
    if (boundContainers.has(container) || !container.addEventListener) return;
    boundContainers.add(container);
    container.addEventListener('click', event => {
      const button = event.target?.closest?.('.native-chat-copy');
      const older = event.target?.closest?.('.native-chat-load-older');
      if (older && container.contains(older)) {
        const snapshot = lastSnapshots.get(container);
        if (snapshot?.paged && snapshot.hasMore) {
          container.dispatchEvent(new CustomEvent('duocli-chat-older', { bubbles: true }));
          return;
        }
        const before = container.scrollHeight;
        visibleLimits.set(container, (visibleLimits.get(container) || 300) + 300);
        lastSignature.delete(container);
        render(container, lastSnapshots.get(container));
        container.scrollTop += container.scrollHeight - before;
        return;
      }
      const image = event.target?.closest?.('[data-chat-path]');
      if (image && container.contains(image)) {
        container.dispatchEvent(new CustomEvent('duocli-chat-file', {
          bubbles: true, detail: { path: image.dataset.chatPath },
        }));
        return;
      }
      if (!button || !container.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      const text = button.closest('details, .native-chat-code-wrap')?.querySelector('pre')?.textContent || '';
      void navigator.clipboard?.writeText(text);
    });
  }

  function updateMessages(container, messages) {
    // Reuse unchanged articles so polling preserves selection and expanded tools.
    if (!container.ownerDocument) {
      container.innerHTML = messages.map(renderMessage).join('');
      return;
    }
    const previous = messageNodes.get(container) || new Map();
    const next = new Map();
    const occurrences = new Map();
    let cursor = container.firstChild;
    messages.forEach((message, index) => {
      const html = renderMessage(message);
      if (!html) return;
      const baseKey = JSON.stringify([message.id || index, message.role]);
      const occurrence = occurrences.get(baseKey) || 0;
      occurrences.set(baseKey, occurrence + 1);
      const key = `${baseKey}:${occurrence}`;
      let entry = previous.get(key);
      if (!entry || entry.html !== html) {
        const template = container.ownerDocument.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;
        const expanded = entry ? Array.from(entry.node.querySelectorAll('details'), el => el.open) : [];
        node.querySelectorAll('details').forEach((el, i) => { el.open = !!expanded[i]; });
        if (entry?.node.parentNode === container) {
          if (cursor === entry.node) cursor = node;
          entry.node.replaceWith(node);
        }
        entry = { html, node };
      }
      entry.node.dataset.chatKey = key;
      if (entry.node !== cursor) container.insertBefore(entry.node, cursor);
      cursor = entry.node.nextSibling;
      next.set(key, entry);
    });
    while (cursor) {
      const nextNode = cursor.nextSibling;
      cursor.remove();
      cursor = nextNode;
    }
    messageNodes.set(container, next);
  }

  function render(container, snapshot) {
    if (!container) return;
    bindContainer(container);
    lastSnapshots.set(container, snapshot);
    const signature = snapshotSignature(snapshot);
    if (lastSignature.get(container) === signature) return;
    lastSignature.set(container, signature);
    if (!snapshot) {
      container.innerHTML = '<div class="native-chat-empty">正在读取对话…</div>';
      messageNodes.delete(container);
      return;
    }
    if (!snapshot.supported) {
      container.innerHTML = '<div class="native-chat-empty">这个会话没有结构化对话，请切到终端。</div>';
      messageNodes.delete(container);
      return;
    }
    if (snapshot.error && !snapshot.notFound) {
      container.innerHTML = `<div class="native-chat-empty">${escapeHtml(snapshot.error)}</div>`;
      messageNodes.delete(container);
      return;
    }
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    if (!messages.length) {
      container.innerHTML = `<div class="native-chat-empty">${
        snapshot.notFound ? '还没有对话记录，发一条就会出现在这里。' : '正在读取对话…'
      }</div>`;
      messageNodes.delete(container);
      return;
    }
    const limit = visibleLimits.get(container) || 300;
    const visible = snapshot.paged ? messages : messages.slice(-limit);
    updateMessages(container, visible);
    if ((snapshot.hasMore || visible.length < messages.length) && container.ownerDocument) {
      const button = container.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'native-chat-load-older';
      const remaining = snapshot.paged ? snapshot.startIndex : messages.length - visible.length;
      button.textContent = `加载更早消息（还有 ${remaining} 条）`;
      container.insertBefore(button, container.firstChild);
    }
  }

  // 没有明确偏好时：有 transcript 才进对话视图。新建 Codex/Claude 还没有
  // 记录，否则会只剩「还没有对话」空态，把真正的 CLI 欢迎屏藏掉。
  function chooseSessionViewMode(input) {
    const chatCapable = Boolean(input && input.chatCapable);
    const pref = input && input.pref;
    const hasMessages = Boolean(input && input.hasMessages);
    if (!chatCapable) return 'terminal';
    if (pref === 'terminal') return 'terminal';
    if (pref === 'chat') return 'chat';
    return hasMessages ? 'chat' : 'terminal';
  }

  return { render, escapeHtml, highlightCode, chooseSessionViewMode, countUserText, mergeLocalMessages };
});
