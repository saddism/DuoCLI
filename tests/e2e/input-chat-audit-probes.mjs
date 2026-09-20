// Optional diagnostics in the isolated mobile fixture. Never use against a live session.
export async function runInputChatAudit(page) {
  const findings = await page.evaluate(async () => {
    const findings = [];
    const originalApi = api;
    const originalWsSend = wsSend;
    const originalRequestSubmission = requestSubmission;
    const originalSession = currentSessionId;
    const input = document.getElementById('msg-input');
    let release;
    let opening;
    try {
      // Freeze the first awaited request during a real session switch.
      const previousSocket = ws;
      api = (path, options) => path === '/api/sessions'
        ? new Promise(resolve => { release = resolve; }) : originalApi(path, options);
      const captured = [];
      wsSend = data => {
        captured.push({ type: data.type, uiSession: currentSessionId, oldSocket: ws === previousSocket });
        pendingSubmissions.get(data.id)?.resolve();
      };
      opening = openSession('s2');
      const ready = isTerminalInputReady();
      input.value = 'AUDIT_SWITCH_FIXTURE_ONLY';
      await sendMessage();
      findings.push({ id: 'INPUT-01', readyDuringSwitch: ready, writes: captured });
    } finally {
      terminalOpenRequest++;
      release?.([]);
      await opening;
      api = originalApi;
      wsSend = originalWsSend;
      currentSessionId = originalSession;
    }
    try {
      const captured = [];
      requestSubmission = async (sessionId, text) => { captured.push({ sessionId, text }); };
      sessionViewMode = 'chat';
      input.focus();
      input.value = 'A会话组合中的文字';
      composerComposing = true;
      await sendMessage();
      currentSessionId = 's2';
      input.value = 'B会话尚未发送的草稿';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      findings.push({ id: 'INPUT-02', writes: captured });
    } finally {
      composerComposing = false;
      submitAfterComposition = null;
      requestSubmission = originalRequestSubmission;
      currentSessionId = originalSession;
      sessionViewMode = 'terminal';
    }
    try {
      let acknowledge;
      requestSubmission = () => new Promise(resolve => { acknowledge = resolve; });
      sessionViewMode = 'chat';
      input.focus();
      input.value = 'A会话等待确认';
      const sending = sendMessage();
      currentSessionId = 's2';
      input.value = '正在B会话编辑';
      input.focus();
      const focusedBeforeAck = document.activeElement === input;
      acknowledge();
      await sending;
      findings.push({ id: 'INPUT-03', focusedBeforeAck, focusedAfterAck: document.activeElement === input });
    } finally {
      requestSubmission = originalRequestSubmission;
      currentSessionId = originalSession;
      sessionViewMode = 'terminal';
    }
    const pendingId = 'audit-pending';
    mobilePendingSubmissions.set(pendingId, { id: 'audit', sessionId: pendingId, text: '未确认的文字' });
    mobileDrafts.delete(pendingId);
    restoreMobileDraft(pendingId);
    findings.push({ id: 'INPUT-04', pendingText: mobilePendingSubmissions.get(pendingId).text, restoredInput: input.value });
    mobilePendingSubmissions.delete(pendingId);
    restoreMobileDraft(originalSession);
    const originalCreate = createTerminal;
    const originalConnect = connectWebSocket;
    try {
      let finishCreate;
      const connections = [];
      createTerminal = () => new Promise(resolve => { finishCreate = resolve; });
      connectWebSocket = sessionId => connections.push({ sessionId, mode: sessionViewMode });
      const rawOpening = openRawTerminalView(originalSession, terminalOpenRequest);
      await openNativeChatView(originalSession);
      finishCreate();
      await rawOpening;
      findings.push({ id: 'CHAT-01', connections });
    } finally {
      stopNativeChatPolling();
      createTerminal = originalCreate;
      connectWebSocket = originalConnect;
    }
    return findings;
  });
  console.log('INPUT_CHAT_AUDIT', JSON.stringify(findings));
  await page.evaluate(() => openSession('s1'));
  await page.waitForFunction(() => currentSessionId === 's1' && isTerminalInputReady());
  return findings;
}
