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

  function renderText(value, markdown = false) {
    const source = String(value || '');
    let html = '';
    let cursor = 0;
    const fence = /```([A-Za-z0-9_+-]*)[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```/g;
    const emit = chunk => {
      html += markdown ? renderMarkdownBlocks(chunk)
        : escapeHtml(chunk).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    };
    for (let match = fence.exec(source); match; match = fence.exec(source)) {
      emit(source.slice(cursor, match.index));
      html += renderCode(match[2], match[1]);
      cursor = match.index + match[0].length;
    }
    emit(source.slice(cursor));
    return html;
  }

  // —— 助手消息 Markdown：先转义再生成受限结构，任何原文都不会变成 HTML。 ——
  // 强调只在一行内闭合，避免失控的 ** 吞掉整段；_ 不参与斜体，防止路径与
  // 标识符（some_var_name）被误判。块级结构：标题、列表、引用、分隔线、段落。
  function findLineEnd(text, index) {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }

  function renderInline(raw, depth = 0) {
    const text = String(raw || '');
    const nested = depth < 2;
    let html = '';
    let plainStart = 0;
    let index = 0;
    const flushPlain = upTo => {
      html += escapeHtml(text.slice(plainStart, upTo))
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    };
    while (index < text.length) {
      const ch = text[index];
      if (nested && ch === '`') {
        const end = text.indexOf('`', index + 1);
        if (end > index + 1) {
          flushPlain(index);
          html += `<code class="native-chat-icode">${escapeHtml(text.slice(index + 1, end))}</code>`;
          index = end + 1;
          plainStart = index;
          continue;
        }
      }
      if (nested && ch === '*' && text[index + 1] === '*') {
        const lineEnd = findLineEnd(text, index);
        const end = text.indexOf('**', index + 2);
        if (end > index + 2 && end < lineEnd) {
          flushPlain(index);
          html += `<strong>${renderInline(text.slice(index + 2, end), depth + 1)}</strong>`;
          index = end + 2;
          plainStart = index;
          continue;
        }
      }
      if (nested && ch === '*' && text[index + 1] && text[index + 1] !== ' ' && text[index + 1] !== '*') {
        const lineEnd = findLineEnd(text, index);
        const end = text.indexOf('*', index + 1);
        if (end > index + 1 && end < lineEnd && text[index + 1] !== ' ') {
          flushPlain(index);
          html += `<em>${renderInline(text.slice(index + 1, end), depth + 1)}</em>`;
          index = end + 1;
          plainStart = index;
          continue;
        }
      }
      index++;
    }
    flushPlain(text.length);
    return html;
  }

  function renderMarkdownBlocks(raw) {
    const lines = String(raw || '').split('\n');
    let html = '';
    let paragraph = [];
    let list = null;
    let quote = [];
    const flushParagraph = () => {
      if (paragraph.length) {
        html += `<p>${paragraph.map(line => renderInline(line)).join('<br>')}</p>`;
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        html += `<${list.ordered ? 'ol' : 'ul'} class="native-chat-list">${
          list.items.map(item => `<li>${item}</li>`).join('')}</${list.ordered ? 'ol' : 'ul'}>`;
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        html += `<blockquote class="native-chat-quote">${quote.map(line => renderInline(line)).join('<br>')}</blockquote>`;
        quote = [];
      }
    };
    const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = Math.min(heading[1].length, 4);
        html += `<div class="native-chat-heading native-chat-heading-${level}">${renderInline(heading[2])}</div>`;
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        html += '<div class="native-chat-hr"></div>';
        continue;
      }
      const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quote.push(quoteMatch[1]);
        continue;
      }
      const ulMatch = /^\s*[*+-]\s+(.*)$/.exec(line);
      if (ulMatch) {
        flushParagraph();
        flushQuote();
        if (!list || list.ordered) {
          flushList();
          list = { ordered: false, items: [] };
        }
        list.items.push(renderInline(ulMatch[1]));
        continue;
      }
      const olMatch = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (olMatch) {
        flushParagraph();
        flushQuote();
        if (!list || !list.ordered) {
          flushList();
          list = { ordered: true, items: [] };
        }
        list.items.push(renderInline(olMatch[2]));
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line);
    }
    flushAll();
    return html;
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

  function renderBlock(block, markdown = false) {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') {
      return `<div class="native-chat-text${markdown ? ' native-chat-md' : ''}">${renderText(block.text, markdown)}</div>`;
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

  function messagePlainText(message) {
    return (message?.blocks || [])
      .filter(block => block?.type === 'text')
      .map(block => String(block.text || ''))
      .join('\n\n');
  }

  function reasoningCharCount(message) {
    return messagePlainText(message).replace(/\s/g, '').length;
  }

  // 今天之前的消息在时间旁补上日期，长对话跨天不再混淆顺序。
  function formatMessageTime(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp);
    const reference = new Date(now);
    const sameDay = date.getFullYear() === reference.getFullYear()
      && date.getMonth() === reference.getMonth()
      && date.getDate() === reference.getDate();
    const pad = value => String(value).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  }

  function renderMessage(message) {
    const role = message.role || 'assistant';
    // 助手与思考内容按 Markdown 渲染；用户输入保持原文（所见即所发）。
    const markdown = role === 'assistant' || role === 'reasoning';
    const body = (message.blocks || []).map(block => renderBlock(block, markdown)).join('');
    if (!body) return '';
    const deliveryState = /未确认|失败/.test(message.localStatus || '') ? 'error'
      : /发送中/.test(message.localStatus || '') ? 'sending'
        : /等待/.test(message.localStatus || '') ? 'waiting' : 'ready';
    const status = message.localStatus ? `<div class="native-chat-delivery state-${deliveryState}"><span class="native-chat-state-dot" aria-hidden="true"></span>${escapeHtml(message.localStatus)}</div>` : '';
    const labels = { user: '你', assistant: '助手', tool: '工具', reasoning: '思考', system: '状态' };
    const time = formatMessageTime(message.timestamp);
    const copyButton = (message.blocks || []).some(block => block?.type === 'text')
      ? '<button type="button" class="native-chat-copy-msg">复制全文</button>' : '';
    const meta = `<div class="native-chat-meta">${escapeHtml(labels[role] || role)}${time ? ` · ${escapeHtml(time)}` : ''}${copyButton}</div>`;
    // 思考内容默认折叠，避免长推理淹没对话；展开状态由节点复用逻辑保留。
    const bodyHtml = role === 'reasoning'
      ? `<details class="native-chat-reasoning-box"><summary>思考过程 · ${reasoningCharCount(message)} 字</summary>${body}</details>`
      : body;
    return `<article class="native-chat-msg native-chat-${escapeHtml(role)}">${meta}${bodyHtml}${status}</article>`;
  }

  // Control commands open the CLI's own UI and may never become transcript turns.
  // 任何单行 /command 形态都算斜杠命令（含未知技能）：发送后应临时切到终端看执行，
  // 由终端顶部的「对话」按钮回来；文件路径（/Users/...）与多行输入不在此列。
  function slashCommandText(text) {
    const match = /^\/([a-z][\w-]*)(?:[ \t]+[^\r\n]*)?$/i.exec(String(text || ''));
    return match ? match[1].toLowerCase() : null;
  }

  function terminalCommand(text) {
    const name = slashCommandText(text);
    const commands = new Set(['model', 'permissions', 'approvals', 'help', 'status', 'usage',
      'mcp', 'config', 'settings', 'theme', 'resume', 'review', 'skills', 'plugins',
      'agent', 'subagents', 'plan', 'compact', 'clear', 'new', 'fast', 'effort']);
    return name && commands.has(name) ? name : null;
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
  const messageCopyTexts = new WeakMap();

  function requestCopy(container, text, kind) {
    container.dispatchEvent(new CustomEvent('duocli-chat-copy', {
      bubbles: true, detail: { text, kind },
    }));
  }

  function bindContainer(container) {
    if (boundContainers.has(container) || !container.addEventListener) return;
    boundContainers.add(container);
    container.addEventListener('click', event => {
      const copyMessage = event.target?.closest?.('.native-chat-copy-msg');
      if (copyMessage && container.contains(copyMessage)) {
        event.preventDefault();
        event.stopPropagation();
        const article = copyMessage.closest('.native-chat-msg');
        const text = article ? messageCopyTexts.get(article) : '';
        if (text) requestCopy(container, text, 'message');
        return;
      }
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
      requestCopy(container, text, 'block');
    });
  }

  // —— 过程消息合并：连续的纯工具消息（调用/结果）折叠为一个「执行任务 · N 个」，
  // 避免一轮工作产生的一堆过程胶囊淹没结论。中间穿插正文即断组。 ——
  function isProcessOnlyMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role !== 'assistant' && message.role !== 'tool') return false;
    const blocks = message.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    return blocks.every(block => block?.type === 'tool-call' || block?.type === 'tool-result');
  }

  function buildChatRenderItems(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const items = [];
    let group = null;
    const flushGroup = () => {
      if (!group) return;
      items.push({ kind: 'tool-group', messages: group.messages, index: group.index });
      group = null;
    };
    source.forEach((message, index) => {
      if (isProcessOnlyMessage(message)) {
        if (!group) group = { messages: [], index };
        group.messages.push(message);
        return;
      }
      flushGroup();
      items.push({ kind: 'message', message, index });
    });
    flushGroup();
    // 单条不成组：按普通消息渲染，不给一次调用多包一层折叠。
    return items.flatMap(item => (item.kind === 'tool-group' && item.messages.length === 1
      ? [{ kind: 'message', message: item.messages[0], index: item.index }]
      : [item]));
  }

  /** 组内按 callId 把调用与输出配对成单条；未配对的独立成项。 */
  function pairToolGroupBlocks(messages) {
    const pairs = [];
    const byCallId = new Map();
    for (const message of messages) {
      for (const block of message.blocks || []) {
        if (block.type === 'tool-call') {
          const pair = { call: block, result: null };
          pairs.push(pair);
          if (block.callId && !byCallId.has(block.callId)) byCallId.set(block.callId, pair);
        } else if (block.type === 'tool-result') {
          const pair = block.callId ? byCallId.get(block.callId) : null;
          if (pair && !pair.result) pair.result = block;
          else pairs.push({ call: null, result: block });
        }
      }
    }
    return pairs;
  }

  const TOOL_GROUP_STATES = { running: '进行中', completed: '已完成', failed: '失败' };

  function toolPairState(pair) {
    if (pair.result) return pair.result.isError ? 'failed' : 'completed';
    if (pair.call?.state) return pair.call.state;
    return 'running';
  }

  function renderToolGroupItem(pair) {
    const state = toolPairState(pair);
    const name = pair.call?.name
      || (pair.result?.callId ? `结果 ${pair.result.callId}` : '工具');
    const stateBadge = `<span class="native-chat-tool-state state-${state}">${TOOL_GROUP_STATES[state]}</span>`;
    let body = pair.call ? formatToolInput(pair.call.input) : '';
    if (pair.result) {
      const output = String(pair.result.output ?? '');
      body += body ? '\n\n—— 输出 ——\n' : '';
      body += output;
    }
    return `<details class="native-chat-tool${pair.result?.isError ? ' native-chat-tool-error' : ''}">`
      + `<summary><span class="native-chat-tool-name">${escapeHtml(name)}</span>${stateBadge}`
      + '<button type="button" class="native-chat-copy">复制</button></summary>'
      + `<pre>${escapeHtml(body)}</pre></details>`;
  }

  function renderToolGroup(messages) {
    const pairs = pairToolGroupBlocks(messages);
    const states = pairs.map(toolPairState);
    const failed = states.filter(state => state === 'failed').length;
    const running = states.filter(state => state === 'running').length;
    // 进行中优先提示，但失败不因此隐藏：两个徽标并列。
    const badges = [];
    if (running > 0) badges.push(`<span class="native-chat-tool-state state-running">进行中${running > 1 ? ` ${running}` : ''}</span>`);
    if (failed > 0) badges.push(`<span class="native-chat-tool-state state-failed">${failed} 个失败</span>`);
    if (!badges.length) badges.push('<span class="native-chat-tool-state state-completed">已完成</span>');
    const html = pairs.map(renderToolGroupItem).join('');
    return `<article class="native-chat-msg native-chat-tool-source">`
      + `<details class="native-chat-tool-group"><summary>`
      + '<span class="native-chat-tool-name">执行任务</span>'
      + `<span class="native-chat-tool-count">${pairs.length} 个</span>`
      + badges.join('')
      + '</summary>'
      + `<div class="native-chat-tool-items">${html}</div>`
      + '</details></article>';
  }

  function renderChatItemHtml(item) {
    return item.kind === 'tool-group' ? renderToolGroup(item.messages) : renderMessage(item.message);
  }

  function updateMessages(container, messages) {
    // Reuse unchanged articles so polling preserves selection and expanded tools.
    if (!container.ownerDocument) {
      container.innerHTML = buildChatRenderItems(messages).map(renderChatItemHtml).join('');
      return;
    }
    const previous = messageNodes.get(container) || new Map();
    const next = new Map();
    const occurrences = new Map();
    let cursor = container.firstChild;
    buildChatRenderItems(messages).forEach((item) => {
      const html = renderChatItemHtml(item);
      if (!html) return;
      const identity = item.kind === 'tool-group'
        // 组以首条过程消息为锚：后续追加新过程消息不换锚，展开状态可延续。
        ? ['group', item.messages[0].id || item.index, item.messages[0].role]
        : [item.message.id || item.index, item.message.role];
      const baseKey = JSON.stringify(identity);
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
      if (item.kind === 'message') messageCopyTexts.set(entry.node, messagePlainText(item.message));
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
        snapshot.unbound ? '正在关联这个终端的对话记录，会自动重试…'
          : snapshot.notFound ? '暂时未找到这个会话的对话记录，正在重试。可切到终端查看。'
            : snapshot.ready ? '这个会话还没有对话记录。' : '正在读取对话…'
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

  // 打开会话一律进终端。只有这次手动切到对话，才会记住并再打开对话。
  function chooseSessionViewMode(input) {
    const chatCapable = Boolean(input && input.chatCapable);
    const pref = input && input.pref;
    if (!chatCapable) return 'terminal';
    if (pref === 'chat') return 'chat';
    return 'terminal';
  }

  return {
    render, escapeHtml, highlightCode, chooseSessionViewMode, countUserText, mergeLocalMessages,
    terminalCommand, slashCommandText, renderText, renderInline, renderMarkdownBlocks,
    messagePlainText, formatMessageTime, buildChatRenderItems, pairToolGroupBlocks,
  };
});
