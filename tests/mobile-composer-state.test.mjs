import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../mobile/client/app.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function harness(sending = false, draft = '') {
  const input = { value: '' };
  const context = vm.createContext({
    $: () => input, resizeComposer() {},
    mobileDrafts: new Map(draft ? [['a', draft]] : []),
    mobilePendingSubmissions: new Map([['a', { id: 'send-a', text: 'already sending' }]]),
    composerSubmissions: new Map(sending ? [['a', { id: 'send-a' }]] : []),
  });
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'restoreMobileDraft');
  vm.runInContext(node.getText(ast), context);
  return { context, input };
}

test('returning to a session during a send does not restore submitted text as a new draft', () => {
  const { context, input } = harness(true);
  context.restoreMobileDraft('a');
  assert.equal(input.value, '');
});

test('returning during a send preserves a separately edited draft', () => {
  const { context, input } = harness(true, 'next prompt');
  context.restoreMobileDraft('a');
  assert.equal(input.value, 'next prompt');
});

test('an unconfirmed submission remains recoverable after reload', () => {
  const { context, input } = harness();
  context.restoreMobileDraft('a');
  assert.equal(input.value, 'already sending');
});
