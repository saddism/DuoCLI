/**
 * Mac Desktop Keyboard Helper
 * 
 * Provides keyboard input handling for noVNC-based Mac remote desktop
 * 
 * Key approach: Send actual physical keystrokes through noVNC's internal handler
 * This ensures proper Unicode/IME support as macOS receives real keyboard events
 */

const MacDesktopKeyboard = {
  /**
   * Send a complete key press (keydown + keyup)
   * @param {string} keyCode - DOM code identifier (e.g., 'KeyA', 'Enter', 'Escape')
   */
  sendKey(keyCode) {
    if (!window.macDesktopClient || !window.macDesktopClient.rfb) {
      console.warn('[MacDesktopKeyboard] No RFB instance available');
      return;
    }

    const rfb = window.macDesktopClient.rfb;
    
    // Call noVNC's internal handleKeyEvent directly
    // This ensures the keyboard state is properly synchronized
    // and Unicode characters are handled correctly
    console.log(`[MacDesktopKeyboard] Sending physical key: ${keyCode}`);
    
    // Create a synthetic keyboard event
    const fakeEvent = {
      code: keyCode,
      key: this._getKeyFromCode(keyCode),
      location: 0,
      repeat: false,
      getModifierState: () => false
    };
    
    // Trigger noVNC's internal key handler
    if (rfb._keyboard && rfb._keyboard.handleKeydown) {
      rfb._keyboard.handleKeydown(fakeEvent);
    }
    
    if (rfb._keyboard && rfb._keyboard.handleKeyup) {
      rfb._keyboard.handleKeyup(fakeEvent);
    }
  },

  /**
   * Send text character by character with proper IME handling
   * Uses noVNC's internal keyboard event dispatch for best compatibility
   * @param {string} text - Text to send
   */
  sendText(text) {
    if (!window.macDesktopClient || !window.macDesktopClient.rfb) {
      console.warn('[MacDesktopKeyboard] No RFB instance available');
      return;
    }

    const rfb = window.macDesktopClient.rfb;
    
    // Try extended clipboard paste first (faster for long text)
    try {
      // Check if server supports clipboard extension
      if (rfb._clipboardServerCapabilitiesActions) {
        const caps = rfb._clipboardServerCapabilitiesActions;
        if (caps[1 << 25] || caps[1 << 28]) { // Request or Provide action
          rfb.clipboardPasteFrom(text);
          console.log(`[MacDesktopKeyboard] Sent ${text.length} chars via clipboard`);
          return;
        }
      }
    } catch (error) {
      console.log('[MacDesktopKeyboard] Clipboard not supported, falling back to key-by-key');
    }
    
    // Fallback: Send each character as physical keystroke
    // This works but may be slower for long text
    console.log(`[MacDesktopKeyboard] Sending ${text.length} characters as keystrokes...`);
    
    // For Chinese IME and complex text, we need to simulate typing
    // This mimics what happens when user types on physical keyboard
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const charCode = char.charCodeAt(0);
      
      // Get appropriate key code for printable ASCII
      let keyCode = '';
      
      if (charCode >= 65 && charCode <= 90) { // A-Z
        keyCode = `Key${String.fromCharCode(charCode + 32)}`; // Convert to lowercase
      } else if (charCode >= 97 && charCode <= 122) { // a-z
        keyCode = `Key${char.toUpperCase()}`;
      } else if (charCode >= 48 && charCode <= 57) { // 0-9
        keyCode = `Digit${char}`;
      } else if (charCode >= 32 && charCode <= 126) { // Other printable ASCII
        keyCode = `Key${char}`;
      } else {
        // Non-ASCII (Chinese, emoji, etc.)
        console.warn(`[MacDesktopKeyboard] Non-ASCII char '${char}' (code ${charCode}) requires IME`);
        
        // For non-ASCII, we can't properly simulate in browser without actual IME
        // Option 1: Use clipboard as fallback
        try {
          rfb.clipboardPasteFrom(char);
        } catch (e) {
          console.error('[MacDesktopKeyboard] Failed to paste non-ASCII character');
        }
        continue;
      }
      
      // Send physical key event through noVNC handler
      const fakeEvent = {
        code: keyCode,
        key: char,
        location: 0,
        repeat: false,
        getModifierState: () => false
      };
      
      if (rfb._keyboard && rfb._keyboard.handleKeydown) {
        rfb._keyboard.handleKeydown(fakeEvent);
      }
      if (rfb._keyboard && rfb._keyboard.handleKeyup) {
        rfb._keyboard.handleKeyup(fakeEvent);
      }
      
      // Small delay between keys to allow rendering
      // Note: This is synchronous, so actual delay would require async
    }
  },

  /**
   * Send Ctrl+Shortcut combination
   * @param {string} shortcut - The shortcut key (e.g., 'C' for Ctrl+C)
   */
  sendCtrlShortcut(shortcut) {
    if (!window.macDesktopClient || !window.macDesktopClient.rfb) {
      return;
    }

    const rfb = window.macDesktopClient.rfb;
    
    // Map common keys
    const keyMap = {
      'C': 'KeyC',
      'V': 'KeyV',
      'A': 'KeyA',
      'Z': 'KeyZ',
      'T': 'KeyT',
      'W': 'KeyW',
      'Q': 'KeyQ',
      'N': 'KeyN',
      'D': 'KeyD',
      'R': 'KeyR',
      'F': 'KeyF',
      'G': 'KeyG',
      'H': 'KeyH',
      'J': 'KeyJ',
      'K': 'KeyK',
      'L': 'KeyL',
      'M': 'KeyM',
      'S': 'KeyS',
      'X': 'KeyX',
      'Y': 'KeyY',
      'U': 'KeyU',
      'O': 'KeyO',
      'P': 'KeyP',
      'I': 'KeyI',
      'E': 'KeyE',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',
      '0': 'Digit0',
      'Space': 'Space',
      'Return': 'Enter',
      'Enter': 'Enter',
      'Tab': 'Tab',
      'Escape': 'Escape',
      'Delete': 'Delete',
      'ArrowLeft': 'ArrowLeft',
      'ArrowRight': 'ArrowRight',
      'ArrowUp': 'ArrowUp',
      'ArrowDown': 'ArrowDown',
    };

    const keyCode = keyMap[shortcut] || `Key${shortcut.toUpperCase()}`;
    
    console.log(`[MacDesktopKeyboard] Sending Ctrl+${shortcut}`);
    
    // Press Ctrl + Key
    const ctrlEvent = {
      code: 'ControlLeft',
      key: 'Control',
      location: 3,
      repeat: false,
      getModifierState: () => false
    };
    
    const keyEvent = {
      code: keyCode,
      key: shortcut.toLowerCase(),
      location: 0,
      repeat: false,
      getModifierState: () => true // Ctrl is pressed
    };
    
    if (rfb._keyboard) {
      rfb._keyboard.handleKeydown(ctrlEvent);
      rfb._keyboard.handleKeydown(keyEvent);
      rfb._keyboard.handleKeyup(keyEvent);
      rfb._keyboard.handleKeyup(ctrlEvent);
    }
  },

  /**
   * Map key code to readable key name
   */
  _getKeyFromCode(code) {
    const map = {
      'ControlLeft': 'Control',
      'AltLeft': 'Alt',
      'ShiftLeft': 'Shift',
      'MetaLeft': 'Meta',
      'Space': ' ',
      'Enter': 'Enter',
      'Escape': 'Escape',
      'Delete': 'Delete',
      'Backspace': 'Backspace',
      'Tab': 'Tab',
      'ArrowUp': 'ArrowUp',
      'ArrowDown': 'ArrowDown',
      'ArrowLeft': 'ArrowLeft',
      'ArrowRight': 'ArrowRight',
    };
    return map[code] || code;
  },
};

// Export to global scope
window.MacDesktopKeyboard = MacDesktopKeyboard;
