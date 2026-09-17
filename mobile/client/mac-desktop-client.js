/**
 * Mac 桌面远程控制客户端
 * 
 * 基于 noVNC (打包成 UMD) 的封装，提供：
 * - 屏幕显示与画面适配
 * - 触控板/直接点按手势模式
 * - 拖拽、滚动操作
 * - 文字输入与快捷键
 */

class MacDesktopClient {
  constructor(options = {}) {
    // 配置项 - 提供默认值避免 undefined 错误
    this.api = options.api || `${window.location.origin}`;
    this.container = options.container;
    
    // 状态管理
    this.state = 'disabled'; // disabled, setup-required, busy, connecting, authenticating, awaiting-frame, active, suspended, disconnected, unsupported
    this.sessionId = null;
    this.ticket = null;
    this.generations = 0;
    
    // noVNC RFB 实例
    this.rfb = null;
    
    // 手势模式
    this.pointerMode = 'trackpad'; // trackpad | click | right-click
    this.dragMode = false;
    this.viewMode = false; // 查看模式（暂停远端输入）
    
    // 视口管理
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    
    // DOM 引用
    this.$container = null;
    this.$statusMask = null;
    this.$statusText = null;
    this.$toolbar = null;
    this.$disconnectBtn = null;
    this.$connectBtn = null;
    
    // 事件监听
    this.bindEvents();
  }

  /**
   * 绑定事件监听
   */
  bindEvents() {
    // 页面切换时自动断开
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'active') {
        this.suspend();
      }
    });

    // 窗口大小变化时更新视口
    window.addEventListener('resize', () => {
      this.updateViewport();
    });
  }

  /**
   * 初始化并渲染 UI
   */
  async init() {
    try {
      this.renderContainer();
      
      // 手机端设备列表里的「电脑」入口会用到，不再按 UA 跳过
      
      // 暴露键盘辅助到全局，供外部调用
      window.macDesktopClient = this;
      
      console.log('[MacDesktop] Initializing Mac desktop client...');
      await this.fetchCapabilities();
      
      // 设置定期刷新（每 30 秒检查一次服务状态）
      this.refreshInterval = setInterval(() => {
        this.fetchCapabilities();
      }, 30000); // 30 seconds
    } catch (error) {
      console.error('[MacDesktop] Initialization failed:', error);
      this.updateStatus('初始化失败', true);
    }
  }

  /**
   * 检查当前是否为 Mac 或移动设备
   */
  checkIsMacOrMobile() {
    return navigator.userAgent.includes('Mac') || 
           navigator.userAgent.includes('iPhone') ||
           navigator.userAgent.includes('iPad');
  }

  /**
   * 渲染容器 DOM
   */
  renderContainer() {
    // 创建状态遮罩（如果不存在）
    if (!$('#mac-desktop-status-mask')) {
      const mask = document.createElement('div');
      mask.id = 'mac-desktop-status-mask';
      mask.className = '';
      mask.innerHTML = '<div class="mac-desktop-status-text" id="mac-desktop-status-text">加载中...</div>';
      document.body.appendChild(mask);
    }
    this.$statusMask = $('#mac-desktop-status-mask');
    this.$statusText = $('#mac-desktop-status-text');

    // 创建无 VNC 容器（如果不存在）
    if (!$('#mac-desktop-container')) {
      const container = document.createElement('div');
      container.id = 'mac-desktop-container';
      container.className = 'mac-desktop-hidden';
      document.body.appendChild(container);
    }
    this.$container = $('#mac-desktop-container');
  }

  /**
   * 更新状态显示
   */
  updateStatus(message, blocking = true) {
    if (!this.$statusText) return;

    this.$statusText.textContent = message;
    
    if (blocking) {
      this.$statusMask?.classList.add('active');
    } else {
      this.$statusMask?.classList.remove('active');
    }
  }

  /**
   * 获取能力信息
   */
  async fetchCapabilities() {
    try {
      const response = await fetch(`${this.api}/api/mac-desktop/capabilities`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
        },
      });

      const data = await response.json();

      if (data.success) {
        this.handleCapabilities(data);
      } else {
        this.handleCapabilityError(data);
      }
    } catch (error) {
      console.error('[MacDesktop] Failed to fetch capabilities:', error);
      this.updateStatus('网络错误，请检查连接', true);
      this.state = 'disconnected';
    }
  }

  /**
   * 处理能力响应
   */
  handleCapabilities(data) {
    this.generations = data.generation || this.generations;

    if (!data.enabled) {
      if (data.status === 'disabled') {
        this.updateStatus('请在电脑端启用远程桌面', true);
        this.state = 'disabled';
      } else if (data.status === 'setup-required') {
        this.updateStatus('请在 Mac 系统设置中完成屏幕共享设置', true);
        this.state = 'setup-required';
      } else if (data.status === 'unsupported') {
        this.updateStatus(`当前显示器配置暂不支持：${data.reasonCode}`, true);
        this.state = 'unsupported';
      } else {
        this.updateStatus('服务不可用', true);
        this.state = 'unavailable';
      }
      return;
    }

    if (data.busy) {
      this.updateStatus('另一连接正在使用', true);
      this.state = 'busy';
      return;
    }

    if (data.serviceReachable) {
      this.state = 'ready';
      this.enableToolbar();
      this.updateStatus('点击"连接"开始', false);
    } else {
      this.updateStatus('服务未就绪', true);
      this.state = 'unavailable';
    }
  }

  /**
   * 处理能力错误
   */
  handleCapabilityError(data) {
    let message = '无法加载服务状态';
    let state = 'disconnected';

    switch (data.code) {
      case 'SERVICE_DISABLED':
        message = '请在电脑端启用远程桌面';
        state = 'disabled';
        break;
      case 'SERVICE_BUSY':
        message = '另一连接正在使用';
        state = 'busy';
        break;
      case 'UNSUPPORTED_DISPLAY':
        message = data.error || '不支持的显示器配置';
        state = 'unsupported';
        break;
      default:
        message = data.error || '服务错误';
        state = 'disconnected';
    }

    this.updateStatus(message, true);
    this.state = state;
  }

  /**
   * 启用工具栏
   */
  enableToolbar() {
    if (!this.$toolbar) {
      const $toolbar = document.createElement('div');
      $toolbar.className = 'mac-desktop-toolbar';
      
      // 连接按钮
      const $connectBtn = this.createButton({
        label: '连接',
        onClick: () => this.connect(),
      });

      // 键盘按钮
      const $keyboardBtn = this.createButton({
        label: '键盘',
        onClick: () => this.toggleKeyboard(),
      });

      // 拖拽模式切换
      const $dragBtn = this.createButton({
        label: '拖拽',
        toggle: true,
        onClick: () => this.toggleDragMode(),
      });

      // 右键模式切换
      const $rightClickBtn = this.createButton({
        label: '右键',
        toggle: true,
        onClick: () => this.toggleRightClickMode(),
      });

      // 查看模式按钮
      const $viewBtn = this.createButton({
        label: '查看',
        toggle: true,
        onClick: () => this.toggleViewMode(),
      });

      // 适应屏幕按钮
      const $fitBtn = this.createButton({
        label: '适应',
        onClick: () => this.fitToScreen(),
      });

      // 断开按钮（初始隐藏）
      const $disconnectBtn = this.createButton({
        label: '断开',
        onClick: () => this.disconnect(),
        style: { color: '#ff4444' },
      });
      $disconnectBtn.style.display = 'none';

      $toolbar.append($connectBtn, $keyboardBtn, $dragBtn, $rightClickBtn, $viewBtn, $fitBtn, $disconnectBtn);
      this.$container.appendChild($toolbar);
      
      this.$toolbar = $toolbar;
      this.$disconnectBtn = $disconnectBtn;
      this.$connectBtn = $connectBtn;
    }
  }

  /**
   * 创建按钮
   */
  createButton({ label, onClick, toggle = false, style = {} }) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = `mac-desktop-tool-btn ${toggle ? 'toggle-btn' : ''}`;
    Object.assign(btn.style, style);
    btn.onclick = onClick;
    return btn;
  }

  /**
   * 连接桌面
   */
  async connect() {
    if (this.state !== 'ready') {
      console.warn('[MacDesktop] Cannot connect in state:', this.state);
      return;
    }

    this.updateStatus('正在连接...', true);
    this.state = 'connecting';

    try {
      // 1. 创建会话并获取票据
      const sessionResponse = await fetch(`${this.api}/api/mac-desktop/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
          'Cache-Control': 'no-store',
        },
      });

      const sessionData = await sessionResponse.json();

      if (!sessionData.success) {
        throw new Error(sessionData.error || 'Failed to create session');
      }

      this.sessionId = sessionData.sessionId;
      this.ticket = sessionData.ticket;

      console.log('[MacDesktop] Session created:', this.sessionId.substring(0, 8));
      console.log('[MacDesktop] Ticket:', this.ticket.substring(0, 8));

      // 2. 初始化 noVNC 连接
      await this.initNoVncConnection();

    } catch (error) {
      console.error('[MacDesktop] Connection failed:', error);
      this.handleConnectionError(error);
    }
  }

  /**
   * 初始化 noVNC 连接
   */
  async initNoVncConnection() {
    this.updateStatus('正在进行 Mac 认证，请输入密码...', true);
    this.state = 'authenticating';

    try {
      // 使用后端代理的 WebSocket 地址
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${location.host}/mac-desktop-ws?sessionId=${encodeURIComponent(this.sessionId)}&ticket=${encodeURIComponent(this.ticket)}`;
      
      console.log('[MacDesktop] Connecting to VNC via WSS:', wsUrl);
      
      // 创建 RFB 实例 - noVNC UI 类提供了简便的初始化
      // 使用 NoVNCUI.RFB 或直接 new RFB(...)
      
      // ✅ RFB 构造函数接收 DOM 容器元素（非 ID 字符串）
      // noVNC 会在容器内自动创建_screen 和_canvas
      this.rfb = new RFB(this.$container, wsUrl, {
        viewOnly: false,
        clipViewport: true,
        scaleViewport: false,
        resizeSession: false,
        showControls: false,
        shared: true,
      });

      // 设置事件处理器
      this.rfb.addEventListener('connected', (e) => {
        console.log('[MacDesktop] ✅ VNC connected');
        this.state = 'active';
        this.updateStatus('已连接', false);
        this.toggleConnectionState(true);
        
        // 启动视口调整
        this.updateViewport();
      });

      this.rfb.addEventListener('failed', (e) => {
        console.error('[MacDesktop] ❌ VNC connection failed:', e.detail);
        this.handleConnectionError(new Error('VNC connection failed: ' + e.detail));
      });

      this.rfb.addEventListener('securityfailure', (e) => {
        console.error('[MacDesktop] ❌ Security failure:', e);
        this.updateStatus('Mac 认证失败，请检查账户和共享权限', true);
        this.state = 'auth-failed';
      });

      this.rfb.addEventListener('passwordrequired', (e) => {
        console.warn('[MacDesktop] Password required - triggering input modal...');
        this.updateStatus('请输入 Mac 密码', true);
        // Trigger password prompt UI here if not using noVNC built-in
      });

      this.rfb.addEventListener('disconnecting', (e) => {
        console.log('[MacDesktop] VNC disconnecting');
      });

      this.rfb.addEventListener('disconnect', (e) => {
        console.log('[MacDesktop] ✅ VNC disconnected');
        this.state = 'disconnected';
        this.toggleConnectionState(false);
      });

      this.rfb.addEventListener('update', (e) => {
        // 图像更新时的回调
        this._lastUpdateReceived = Date.now();
      });

      this.rfb.addEventListener('resize', (e) => {
        console.log('[MacDesktop] Resize:', e.width, 'x', e.height);
        this.updateViewport();
      });

      console.log('[MacDesktop] 🔄 Starting RFB connection (auto-initiated)...');
      console.log('[MacDesktop] Current state:', this.rfb._rfbConnectionState);

    } catch (error) {
      console.error('[MacDesktop] noVNC initialization failed:', error);
      this.updateStatus('noVNC 初始化失败：' + error.message, true);
      this.state = 'protocol-error';
    }
  }

  /**
   * 处理连接错误
   */
  handleConnectionError(error) {
    console.error('[MacDesktop] Connection error:', error);
    
    let message = '连接失败';
    let state = 'disconnected';

    if (error?.message?.includes('Another connection')) {
      message = '另一连接正在使用';
      state = 'busy';
    } else if (error?.message?.includes('Service not ready')) {
      message = '服务未就绪';
      state = 'unavailable';
    } else if (error?.message?.includes('Security')) {
      message = 'Mac 认证失败';
      state = 'auth-failed';
    }

    this.updateStatus(message, true);
    this.state = state;
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (!this.sessionId) {
      this.reset();
      return;
    }

    try {
      await fetch(`${this.api}/api/mac-desktop/sessions/${this.sessionId}/disconnect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
        },
      });
    } catch (error) {
      console.error('[MacDesktop] Disconnect error:', error);
    } finally {
      this.reset();
    }
  }

  /**
   * 重置状态
   */
  reset() {
    // 清理定时器
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    
    this.sessionId = null;
    this.ticket = null;
    
    // 关闭 noVNC
    if (this.rfb) {
      console.log('[MacDesktop] Disconnecting RFB instance...');
      this.rfb.disconnect();
      this.rfb = null;
    }

    this.state = 'disconnected';
    this.updateStatus('连接已断开', false);
    
    this.toggleConnectionState(false);
  }

  /**
   * 获取当前状态文本
   */
  getStatusText() {
    const statusMap = {
      disabled: '请在电脑端启用远程桌面',
      'setup-required': '请在 Mac 系统设置中完成屏幕共享设置',
      busy: '另一连接正在使用',
      connecting: '正在连接...',
      authenticating: '正在进行 Mac 认证，请输入密码...',
      awaitingFrame: '已连接，正在等待画面',
      active: '已连接',
      suspended: '连接已暂停',
      disconnected: '连接已断开',
      'auth-failed': 'Mac 认证失败，请检查账户和共享权限',
      'service-unreachable': '服务未就绪',
      unsupported: '不支持的显示器配置',
      'protocol-error': '协议错误，请稍后重试',
      congested: '网络拥堵，请稍后重试',
    };
    
    return statusMap[this.state] || '未知状态';
  }

  /**
   * 绑定键盘输入支持
   * 当 VNC 连接成功后调用，将物理键盘事件转发到 noVNC
   */
  bindKeyboardInput() {
    console.log('[MacDesktop] Binding keyboard input...');
    
    // noVNC 会自动处理大部分键盘事件，但我们可以通过其 API 增强功能
    // 添加全局快捷键支持
    document.addEventListener('keydown', (e) => {
      // 如果正在使用 Mac Desktop 连接且不是表单输入中
      if (this.state === 'active' && !this._isTyping()) {
        const rfb = this.rfb;
        
        // 让 noVNC 处理标准键盘事件
        // e.preventDefault(); // 不要阻止默认行为，除非明确需要
        
        console.log('[MacDesktop] Keyboard event:', e.key, e.code, {
          ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey
        });
      }
    });
  }

  /**
   * 检查当前是否在文本输入框中
   */
  _isTyping() {
    const activeElement = document.activeElement;
    if (!activeElement) return false;
    
    const typingTags = ['INPUT', 'TEXTAREA'];
    const typingTypes = ['text', 'password', 'email', 'search', 'tel', 'url'];
    
    return typingTags.includes(activeElement.tagName) ||
           (activeElement.tagName === 'INPUT' && 
            typingTypes.includes(activeElement.type));
  }

  /**
   * 切换连接状态 UI
   */
  toggleConnectionState(isConnected) {
    if (this.$connectBtn) {
      this.$connectBtn.style.display = isConnected ? 'none' : '';
    }
    if (this.$disconnectBtn) {
      this.$disconnectBtn.style.display = isConnected ? '' : 'none';
    }
  }

  /**
   * 挂起连接（页面切后台）
   */
  suspend() {
    if (this.state !== 'active') return;

    this.state = 'suspended';
    this.updateStatus('连接已暂停', false);
    
    // 通知服务端断开
    if (this.sessionId) {
      fetch(`${this.api}/api/mac-desktop/sessions/${this.sessionId}/disconnect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
        },
      }).catch(console.error);
    }
  }

  /**
   * 恢复连接（页面切前台）
   */
  async resume(ticket) {
    // ✅ Fix: Allow resume from both suspended AND disconnected states
    if (this.state !== 'suspended' && this.state !== 'disconnected') {
      console.warn('[MacDesktop] Resume called but state is:', this.state);
      return;
    }

    console.log('[MacDesktop] Resuming connection...');
    
    // ✅ Reset to ready state to allow reconnection
    this.state = 'ready';
    this._lastTicket = ticket;
    
    return await this.connect();
  }

  /**
   * 切换拖拽模式
   */
  toggleDragMode() {
    this.dragMode = !this.dragMode;
    this.updateButtonState('拖拽', this.dragMode);
    
    if (this.dragMode) {
      this.pointerMode = 'click';
    } else if (this.pointerMode === 'click') {
      this.pointerMode = 'trackpad';
    }
  }

  /**
   * 切换右键模式
   */
  toggleRightClickMode() {
    if (this.pointerMode === 'right-click') {
      this.pointerMode = 'trackpad';
    } else {
      this.pointerMode = 'right-click';
    }
    this.updateButtonState('右键', this.pointerMode === 'right-click');
  }

  /**
   * 切换查看模式（暂停远端输入）
   */
  toggleViewMode() {
    this.viewMode = !this.viewMode;
    this.updateButtonState('查看', this.viewMode);

    if (this.viewMode) {
      this.releaseAllInputs();
    } else {
      this.dragMode = false;
      this.pointerMode = 'trackpad';
      this.updateButtonState('拖拽', false);
      this.updateButtonState('右键', false);
    }
  }

  /**
   * 适应屏幕
   */
  fitToScreen() {
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.updateViewport();
  }

  /**
   * 更新视口
   */
  updateViewport() {
    if (!this.$container) return;

    this.viewportWidth = this.$container.clientWidth;
    this.viewportHeight = this.$container.clientHeight;

    if (this.rfb && this.rfb.display) {
      // noVNC display 提供 setClipRect 方法
      try {
        this.rfb.display.setClipRegion(0, 0, this.viewportWidth, this.viewportHeight);
      } catch (e) {
        console.warn('[MacDesktop] Viewport update failed:', e);
      }
    }
  }

  /**
   * 更新按钮激活状态
   */
  updateButtonState(textContent, isActive) {
    const buttons = document.querySelectorAll('.mac-desktop-tool-btn');
    buttons.forEach(btn => {
      if (btn.textContent === textContent) {
        btn.classList.toggle('active', isActive);
      }
    });
  }

  /**
   * 切换软键盘显示/隐藏
   */
  toggleKeyboard() {
    if (!this.$keyboardContainer) {
      this.createKeyboard();
    }
    
    this.isKeyboardVisible = !this.isKeyboardVisible;
    
    if (this.isKeyboardVisible) {
      this.$keyboardContainer?.classList.remove('mac-desktop-hidden');
      // Focus on input field
      this.$keyboardInput?.focus();
    } else {
      this.$keyboardContainer?.classList.add('mac-desktop-hidden');
      this.$keyboardInput?.blur();
    }
  }

  /**
   * 创建虚拟键盘 UI
   */
  createKeyboard() {
    // Keyboard container
    const $container = document.createElement('div');
    $container.className = 'mac-desktop-keyboard-container mac-desktop-hidden';
    
    // Top bar (status + shortcuts)
    const $topBar = document.createElement('div');
    $topBar.className = 'mac-desktop-keyboard-topbar';
    
    // Status text
    const $statusText = document.createElement('span');
    $statusText.className = 'mac-desktop-keyboard-status';
    $statusText.textContent = '已连接';
    $topBar.appendChild($statusText);
    
    // ESC button
    const $escBtn = this.createButton({
      label: 'ESC',
      onClick: () => this.sendKey('Escape'),
      style: { backgroundColor: '#ff9800' },
    });
    $topBar.appendChild($escBtn);
    
    // Close keyboard button
    const $closeBtn = this.createButton({
      label: '×',
      onClick: () => this.toggleKeyboard(),
      style: { width: '32px', fontSize: '18px' },
    });
    $topBar.appendChild($closeBtn);
    
    $container.appendChild($topBar);
    
    // Text input field
    const $inputGroup = document.createElement('div');
    $inputGroup.className = 'mac-desktop-keyboard-input-group';
    
    const $input = document.createElement('input');
    $input.type = 'text';
    $input.placeholder = '输入文字，按发送键...';
    $input.className = 'mac-desktop-keyboard-input';
    $input.autocomplete = 'off';
    $input.autocorrect = 'off';
    $input.spellcheck = 'false';
    this.$keyboardInput = $input;
    
    // Auto-send on Enter
    $input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSendText();
      }
    });
    
    const $sendBtn = this.createButton({
      label: '发送',
      onClick: () => this.handleSendText(),
      style: { 
        minWidth: '60px',
        backgroundColor: '#4caf50',
        color: 'white',
      },
    });
    
    $inputGroup.appendChild($input);
    $inputGroup.appendChild($sendBtn);
    
    $container.appendChild($inputGroup);
    
    // Shortcut row 1
    const $row1 = document.createElement('div');
    $row1.className = 'mac-desktop-keyboard-row';
    for (const [label, shortcut] of Object.entries({
      '⌘C': 'C', '⌘V': 'V', '⌘A': 'A', '⌘Z': 'Z',
    })) {
      const $btn = this.createButton({
        label,
        onClick: () => this.sendCtrlShortcut(shortcut),
        style: { flex: 1, padding: '10px' },
      });
      $row1.appendChild($btn);
    }
    $container.appendChild($row1);
    
    // Shortcut row 2
    const $row2 = document.createElement('div');
    $row2.className = 'mac-desktop-keyboard-row';
    for (const [label, shortcut] of Object.entries({
      '⌘T': 'T', '⌘W': 'W', '⌘Q': 'Q', 'Tab': 'Tab',
    })) {
      const $btn = this.createButton({
        label,
        onClick: () => this.sendCtrlShortcut(shortcut),
        style: { flex: 1, padding: '10px' },
      });
      $row2.appendChild($btn);
    }
    $container.appendChild($row2);
    
    // Navigation keys
    const $navRow = document.createElement('div');
    $navRow.className = 'mac-desktop-keyboard-row';
    for (const code of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) {
      const $btn = this.createButton({
        label: code.replace('Arrow', ''),
        onClick: () => this.sendKey(code),
        style: { flex: 1, padding: '10px' },
      });
      $navRow.appendChild($btn);
    }
    $container.appendChild($navRow);
    
    // Function keys
    const $funcRow = document.createElement('div');
    $funcRow.className = 'mac-desktop-keyboard-row';
    for (const num of ['F1', 'F2', 'F3', 'F4']) {
      const $btn = this.createButton({
        label: num,
        onClick: () => this.sendKey(num),
        style: { flex: 1, padding: '8px' },
      });
      $funcRow.appendChild($btn);
    }
    $container.appendChild($funcRow);
    
    this.$keyboardContainer = $container;
    this.$container.appendChild($container);
  }

  /**
   * 处理发送文本
   */
  handleSendText() {
    const text = this.$keyboardInput?.value.trim();
    if (!text || !this.sessionId) return;
    
    console.log(`[MacDesktop] Sending text: "${text}"`);
    
    // Use keyboard helper to send text
    window.MacDesktopKeyboard.sendText(text);
    
    // Clear input
    this.$keyboardInput.value = '';
    this.$keyboardInput.focus();
  }

  /**
   * 发送单个按键（用于快捷键按钮）
   */
  sendKey(keyCode) {
    console.log(`[MacDesktop] Sending key: ${keyCode}`);
    window.MacDesktopKeyboard.sendKey(keyCode);
  }

  /**
   * 发送 Ctrl+ 组合键
   */
  sendCtrlShortcut(shortcut) {
    console.log(`[MacDesktop] Sending Ctrl+${shortcut}`);
    window.MacDesktopKeyboard.sendCtrlShortcut(shortcut);
  }

  /**
   * 释放所有输入（取消按键保持状态）
   */
  releaseAllInputs() {
    // 重置手势模式
    this.dragMode = false;
    this.viewMode = false;
    this.pointerMode = 'trackpad';
    
    // 更新按钮状态
    if (this.$dragBtn) this.$dragBtn.classList.remove('active');
    if (this.$rightClickBtn) this.$rightClickBtn.classList.remove('active');
    
    // 通知服务端释放（如果已连接）
    if (this.sessionId && this.state === 'active') {
      console.log('[MacDesktop] Releasing all inputs...');
      try {
        fetch(`${this.api}/api/mac-desktop/sessions/${this.sessionId}/disconnect`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
          },
        }).catch(console.error);
      } catch (error) {
        console.error('[MacDesktop] Failed to release inputs:', error);
      }
    }
    
    // 如果仍在查看模式中，退出该模式
    if (this.viewMode) {
      this.toggleViewMode();
    }
  }

  /**
   * 发送文本
   */
  async sendText(text) {
    if (!this.sessionId || this.state !== 'active') return;

    try {
      const response = await fetch(`${this.api}/api/mac-desktop/input`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          type: 'text',
          text,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send text');
      }

      return response.json();
    } catch (error) {
      console.error('[MacDesktop] Send text error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发送快捷键
   */
  async sendShortcut(modifiers, key) {
    if (!this.sessionId || this.state !== 'active') return;

    try {
      const response = await fetch(`${this.api}/api/mac-desktop/input`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('duocli_token')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          type: 'shortcut',
          modifiers,
          key,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send shortcut');
      }

      return response.json();
    } catch (error) {
      console.error('[MacDesktop] Send shortcut error:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 初始化客户端 - 注册事件绑定和 UI 回调
   */
  async init() {
    try {
      console.log('[MacDesktop] Initializing client...');
      
      // 设置容器引用
      this.$container = document.getElementById('mac-desktop-container') || document.body;
      
      // 如果没有容器元素，创建动态容器
      if (this.$container === document.body && !document.getElementById('mac-desktop-container')) {
        const containerDiv = document.createElement('div');
        containerDiv.id = 'mac-desktop-container';
        containerDiv.style.cssText = 'width: 100%; height: 100%; position: relative; overflow: hidden;';
        document.body.insertBefore(containerDiv, document.body.firstChild);
        this.$container = containerDiv;
      }
      
      if (typeof this.checkMacDesktopCapabilities === 'function') {
        await this.checkMacDesktopCapabilities();
      } else {
        this.renderContainer();
        await this.fetchCapabilities();
      }
      
      // 如果可用，自动显示控制面板
      if (this.state === 'active' || this.state === 'suspended') {
        this.showControlPanel();
      }
      
      console.log('[MacDesktop] Client initialized, state:', this.state);
    } catch (error) {
      console.error('[MacDesktop] Initialization failed:', error);
      this.state = 'error';
      this.updateStatus('初始化失败：' + error.message, true);
    }
  }
  
  /**
   * 显示控制面板
   */
  showControlPanel() {
    if (!this.$container) return;
    
    let panel = document.getElementById('mac-desktop-control-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mac-desktop-control-panel';
      panel.className = 'mac-desktop-control-panel';
      panel.style.cssText = `
        position: absolute;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        background: rgba(30, 30, 30, 0.95);
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
        display: flex;
        gap: 12px;
        align-items: center;
        font-size: 14px;
        color: white;
      `;
      
      // 连接按钮
      const connectBtn = document.createElement('button');
      connectBtn.id = 'mac-desktop-connect-btn';
      connectBtn.className = 'btn-primary';
      connectBtn.textContent = '连接到 Mac';
      connectBtn.style.cssText = 'background: #007AFF; border: none; padding: 8px 16px; border-radius: 6px; color: white; cursor: pointer; font-weight: 500; transition: all 0.2s;';
      connectBtn.onmouseover = () => connectBtn.style.background = '#0056b3';
      connectBtn.onmouseout = () => connectBtn.style.background = '#007AFF';
      connectBtn.onclick = () => this.connect();
      panel.appendChild(connectBtn);
      
      // 状态指示器
      const statusIndicator = document.createElement('div');
      statusIndicator.id = 'mac-desktop-status-indicator';
      statusIndicator.style.cssText = 'display: flex; align-items: center; gap: 8px; min-width: 120px; justify-content: flex-end;';
      
      const statusDot = document.createElement('span');
      statusDot.className = 'status-dot';
      statusDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: gray;';
      statusIndicator.appendChild(statusDot);
      
      const statusText = document.createElement('span');
      statusText.id = 'mac-desktop-status-text';
      statusText.style.cssText = 'font-size: 12px; opacity: 0.8;';
      statusIndicator.appendChild(statusText);
      
      panel.appendChild(statusIndicator);
      
      this.$container.appendChild(panel);
      this.$connectBtn = connectBtn;
      this.$statusIndicator = statusIndicator;
      this.$statusDot = statusDot;
      this.$statusText = statusText;
    } else {
      panel.style.display = 'flex';
    }
  }
  
  /**
   * 隐藏控制面板
   */
  hideControlPanel() {
    const panel = document.getElementById('mac-desktop-control-panel');
    if (panel) {
      panel.style.display = 'none';
    }
  }
}

// 导出类供全局使用
window.MacDesktopClient = MacDesktopClient;
