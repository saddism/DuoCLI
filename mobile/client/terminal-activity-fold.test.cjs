const test = require('node:test');
const assert = require('node:assert/strict');
const { readLines, groupLines, renderGroups } = require('./terminal-activity-fold.js');

test('Claude, Qoder and Gemini tool invocations fold without hiding the final answer', () => {
  for (const heading of ['⏺ Read(audit.txt)', '● Bash(cat audit.txt)', '✔ ReadFile audit.txt', '│ ✓ run_shell_command: cat audit.txt']) {
    const groups = groupLines(readLines(buffer([{ text: heading }, { text: '  42' }, { text: '' }, { text: '最终答案：42' }])));
    assert.equal(groups[0].type, 'activity', heading);
    assert.equal(groups.at(-1).type, 'plain', heading);
    assert.equal(groups.at(-1).lines[0].text, '最终答案：42', heading);
    assert.doesNotMatch(renderGroups(groups), /<details[^>]* open/);
  }
});

test('Called leaves an unmarked conclusion visible after the tool output separator', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Called read_file' }, { text: '  42' }, { text: '' }, { text: '最终答案：42' },
  ])));
  assert.equal(groups.at(-1).type, 'plain');
  assert.equal(groups.at(-1).lines[0].text, '最终答案：42');
});

test('bullet prose that merely starts with Read remains visible', () => {
  const groups = groupLines(readLines(buffer([{ text: '⏺ Read this carefully before continuing.' }, { text: '✔ Tests passed.' }])));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'plain');
});

test('failed Codex commands fold with their exit status while failure prose stays visible', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Failed (exit 1) npm check' }, { text: '  └ error detail' }, { text: '' },
    { text: '• Failed to reproduce the reported issue.' },
  ])));
  assert.equal(groups[0].label, 'Failed');
  assert.equal(groups.at(-1).type, 'plain');
  assert.match(groups.at(-1).lines[0].text, /Failed to reproduce/);
  assert.match(renderGroups(groups), /terminal-activity-status">exit 1/);
  assert.doesNotMatch(renderGroups(groups), /<details[^>]* open/);
});

test('computer action details fold while ordinary computer prose stays visible', () => {
  for (const heading of ['• Used computer · 3 actions', '• Using computer · 1 action']) {
    const groups = groupLines(readLines(buffer([
      { text: heading }, { text: '  └ 检查窗口' }, { text: '  + Show details' },
      { text: '' }, { text: '• Used computer tools to confirm the fix.' },
    ])));
    assert.equal(groups[0].type, 'activity');
    assert.equal(groups.at(-1).type, 'plain');
    assert.doesNotMatch(renderGroups(groups), /<details[^>]* open/);
  }
});

test('Pi folds only its bold tool cards and keeps unindented output in the card background', () => {
  const style = { start: 1, end: 5, flags: 1, bgMode: 1, bg: 2 };
  const lines = [
    { text: ' read audit.txt', styles: [style] },
    { text: ' 42', styles: [{ ...style, flags: 0, end: 3 }] },
    { text: '', styles: [] },
    { text: 'Answer is 42.', styles: [] },
  ];
  const groups = groupLines(lines, 'pi');
  assert.equal(groups[0].type, 'activity');
  assert.equal(groups[0].lines[1].text, ' 42');
  assert.equal(groups.at(-1).type, 'plain');
  assert.equal(groupLines(lines).length, 1);
  assert.equal(groupLines([{ text: 'read audit.txt carefully', styles: [] }], 'pi')[0].type, 'plain');
});

test('current Cursor combined tool summary leaves the less-indented final answer visible', () => {
  const lines = readLines(buffer([
    { text: '  I will read audit.txt.' }, { text: '' },
    { text: '    Globbed, read 1 glob, 1 file' },
    { text: '    Globbed "**/audit.txt" in .' }, { text: '    Read audit.txt' },
    { text: '' }, { text: '  DUOCLI_AUDIT_OK_42' }, { text: '' }, { text: '  → Add a follow-up' },
  ]));
  const groups = groupLines(lines, 'cursor');
  const tools = groups.filter(g => g.type === 'activity');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].label, 'Globbed, read');
  assert.doesNotMatch(tools[0].lines.map(l => l.text).join('\n'), /DUOCLI_AUDIT_OK/);
  assert.match(groups.filter(g => g.type === 'plain').flatMap(g => g.lines).map(l => l.text).join('\n'), /DUOCLI_AUDIT_OK_42/);
});

function buffer(rows, type = 'normal') {
  return {
    type,
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      return { isWrapped: Boolean(row.wrapped), translateToString: trim => trim ? row.text.trimEnd() : row.text };
    },
  };
}

test('activity sections start closed and preserve the complete command and output', () => {
  const lines = readLines(buffer([
    { text: 'Before' },
    { text: '• Explored' },
    { text: '  Read session-auth.js' },
    { text: '• Ran ssh -o BatchMode=yes' },
    { text: '  output one' },
    { text: '  output two' },
    { text: '• Edited test/file.dart (+2 -1)' },
    { text: '  15 + final value' },
    { text: '› Enter a message' },
  ]));
  const groups = groupLines(lines);
  assert.deepEqual(groups.filter(group => group.type === 'activity').map(group => group.label),
    ['Explored', 'Ran', 'Edited']);
  const html = renderGroups(groups);
  assert.equal((html.match(/<details /g) || []).length, 3);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Read session-auth\.js/);
  assert.match(html, /ssh -o BatchMode=yes/);
  assert.match(html, /15 \+ final value/);
  assert.match(html, /› Enter a message/);
  assert.match(html, /<span class="terminal-activity-label">Ran<\/span>/);
  assert.match(html, /terminal-activity-detail">ssh -o BatchMode=yes/);
  assert.match(html, /terminal-activity-detail">test\/file\.dart/);
});

test('Edited diff remains one closed section until the next activity', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Edited uniapp-unified/backend/admin/admin-http-routes.js (+4 -7)' },
    { text: '  3565  const collection = readRequiredString(body, "collection")' },
    { text: '  3566 + await writeRequiredAudit(context, body, "db.query", {' },
    { text: '  3574 - await writeAudit(context, body, "db.query", {' },
    { text: '• Ran git status --short' },
    { text: '  M backend/admin/admin-http-routes.js' },
  ])));
  assert.deepEqual(groups.map(group => group.label), ['Edited', 'Ran']);
  assert.equal(groups[0].lines.length, 4);
  const html = renderGroups(groups);
  assert.equal((html.match(/<details /g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /3566 \+ await writeRequiredAudit/);
});

test('wrapped command headings stay in one activity and content is escaped', () => {
  const lines = readLines(buffer([
    { text: '• Ran echo <script>' },
    { text: ' and more', wrapped: true },
    { text: '  <img src=x>' },
    { text: '• Next step' },
  ]));
  const groups = groupLines(lines);
  assert.equal(groups[0].lines[0].text, '• Ran echo <script> and more');
  assert.equal(groups[0].lines.length, 2);
  const html = renderGroups(groups);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.equal(groups[1].type, 'plain');
});

test('alternate screen is left to the real terminal', () => {
  assert.deepEqual(readLines(buffer([{ text: '• Ran foo' }], 'alternate')), []);
});

test('Cursor dollar command folds indented output but leaves the conclusion visible', () => {
  const groups = groupLines(readLines(buffer([
    { text: '$ python3 check.py' },
    { text: '  import os 31s exit 1' },
    { text: '  30 input lines hidden' },
    { text: '  File "<stdin>", line 12' },
    { text: '' },
    { text: 'Monitored background task, 1 complete' },
    { text: '结论：配置缺失。' },
  ])));
  assert.equal(groups[0].type, 'activity');
  assert.equal(groups[0].label, 'Command');
  assert.equal(groups.at(-1).type, 'plain');
  assert.match(groups.at(-1).lines.map(line => line.text).join('\n'), /结论：配置缺失/);
  const html = renderGroups(groups);
  assert.match(html, /<span class="terminal-activity-status">exit 1<\/span>/);
  assert.match(html.slice(0, html.indexOf('</summary>')), /python3 check\.py/);
});

test('a lone dollar prompt remains visible', () => {
  const groups = groupLines(readLines(buffer([{ text: '$ pwd' }, { text: 'plain answer' }])));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'plain');
});

test('Cursor search and background task summaries fold while prose remains', () => {
  const groups = groupLines(readLines(buffer([
    { text: '  Monitored background task, 1 complete' },
    { text: '  Waited for shell' },
    { text: '  Read terminals/904833.txt' },
    { text: '' },
    { text: '  Grepped, globbed 5 greps, 1 glob' },
    { text: '  … 3 earlier items hidden' },
    { text: '  Globbed "**/*.pem"' },
    { text: '' },
    { text: '这个小程序没有保存过密钥。' },
  ])));
  assert.deepEqual(groups.filter(group => group.type === 'activity').map(group => group.label),
    ['Monitored background task', 'Waited for shell', 'Grepped, globbed']);
  assert.equal(groups.at(-1).type, 'plain');
  assert.match(groups.at(-1).lines[0].text, /这个小程序/);
});

test('shell output hidden by the CLI stays inside one closed command fold', () => {
  const groups = groupLines(readLines(buffer([
    { text: '$ node --test mobile/client/terminal-activity-fold.test.cjs 1.8s' },
    { text: '… 15 output lines hidden · ctrl+o to expand' },
    { text: 'ℹ tests 9' },
    { text: 'ℹ pass 9' },
    { text: 'ℹ duration_ms 143.350125' },
    { text: '' },
    { text: '测试通过。' },
  ])));
  assert.equal(groups[0].type, 'activity');
  assert.equal(groups[0].label, 'Command');
  assert.match(groups[0].lines.map(line => line.text).join('\n'), /output lines hidden/);
  assert.match(groups[0].lines.map(line => line.text).join('\n'), /duration_ms 143/);
  assert.equal(groups.at(-1).type, 'plain');
  assert.match(groups.at(-1).lines[0].text, /测试通过/);
  assert.doesNotMatch(renderGroups(groups), /<details[^>]* open/);
});

test('Called and Calling stay folded through blank lines until the next item', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Called' },
    { text: '  cua_repl.js({"code":"const names=[]"})' },
    { text: '' },
    { text: 'Error: Browser Use encountered an error' },
    { text: 'Warning: names was declared with const' },
    { text: '• Calling' },
    { text: '  cua_repl.js({"code":"const items=[]"})' },
    { text: '• Working (2m 38s • esc to interrupt)' },
  ])));
  assert.deepEqual(groups.filter(group => group.type === 'activity').map(group => group.label),
    ['Called', 'Calling']);
  assert.match(groups[0].lines.map(line => line.text).join('\n'), /Error: Browser Use/);
  assert.match(groups[0].lines.map(line => line.text).join('\n'), /Warning: names was declared/);
  assert.equal(groups.at(-1).type, 'plain');
  assert.match(groups.at(-1).lines[0].text, /Working/);
  const html = renderGroups(groups);
  assert.equal((html.match(/<details /g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('Codex conclusion after a blank separator stays outside the last tool group', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Ran flutter test' },
    { text: '  12 tests passed' },
    { text: '' },
    { text: '已修复：按钮现在默认折叠。' },
  ])));
  assert.equal(groups[0].type, 'activity');
  assert.equal(groups[0].lines.length, 3);
  assert.equal(groups[1].type, 'plain');
  assert.equal(groups[1].lines[0].text, '已修复：按钮现在默认折叠。');
});

test('indented paragraphs after tool output remain visible when details are closed', () => {
  for (const heading of ['• Ran npm test', '• Called read_file', '⏺ Read(audit.txt)']) {
    const groups = groupLines(readLines(buffer([
      { text: heading }, { text: '  └ PASS checks' }, { text: '' },
      { text: '  已完成检查，下面是结论。' }, { text: '    后续步骤仍需展示。' },
    ])));
    assert.equal(groups.at(-1).type, 'plain', heading);
    assert.match(groups.at(-1).lines.map(line => line.text).join('\n'), /已完成检查/);
  }
});

test('wrapped text preserves a meaningful space at the physical line boundary', () => {
  const lines = readLines(buffer([
    { text: '• Ran git diff ' }, { text: '--check', wrapped: true },
  ]));
  assert.equal(lines[0].text, '• Ran git diff --check');
});

test('closed shell and tool summaries retain the command or file being inspected', () => {
  for (const heading of ['$ python3 check.py', '⏺ Read(audit.txt)', '✔ ReadFile audit.txt']) {
    const html = renderGroups(groupLines(readLines(buffer([{ text: heading }, { text: '  42' }]))));
    const summary = html.slice(0, html.indexOf('</summary>'));
    assert.match(summary, /check\.py|audit\.txt/, heading);
  }
});

test('Markdown conclusions and next-step lists are not mistaken for test reporters or patches', () => {
  for (const answer of ['  # 检查结果', '  # tests overview', '  - 下一步：继续检查。', '  ok, the fix is ready.']) {
    const groups = groupLines(readLines(buffer([
      { text: '• Ran npm test' }, { text: '  └ PASS' }, { text: '' }, { text: answer },
    ])));
    assert.equal(groups.at(-1).type, 'plain', answer);
    assert.equal(groups.at(-1).lines.at(-1).text, answer);
  }
});

test('different quoted command arguments never share their folding state', () => {
  const groups = groupLines(readLines(buffer([
    { text: '• Ran echo "a b"' }, { text: '  a b' },
    { text: '• Ran echo "a  b"' }, { text: '  a  b' },
  ])));
  assert.notEqual(groups[0].id, groups[1].id);
});
