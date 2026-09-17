const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('./native-chat-view.js');

test('native chat view renders user and assistant turns', () => {
  const container = { innerHTML: '' };
  render(container, {
    supported: true,
    ready: true,
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: '<hi>' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] },
    ],
  });
  assert.match(container.innerHTML, /native-chat-user/);
  assert.match(container.innerHTML, /&lt;hi&gt;/);
  assert.match(container.innerHTML, /native-chat-assistant/);
});

test('native chat view skips an unchanged snapshot', () => {
  const container = { innerHTML: '' };
  const snapshot = {
    supported: true,
    ready: true,
    messages: [
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ],
  };
  render(container, snapshot);
  container.innerHTML = 'keep-me';
  render(container, snapshot);
  assert.equal(container.innerHTML, 'keep-me');
});
