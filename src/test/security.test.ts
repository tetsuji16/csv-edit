import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Provide a minimal vscode stub so the provider module can be loaded outside VS Code.
// IMPORTANT: this must run BEFORE `import { CsvEditorProvider }` is evaluated, because
// the provider calls require('vscode') at module-load time. tsc compiles imports in
// source order, so the stub is declared above the provider import on purpose.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      window: { activeColorTheme: { kind: 1 } },
      ColorThemeKind: { Dark: 1 }
    } as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m] as string);
}

describe('HTML Escaping', () => {
  it('escapes special characters', () => {
    const result = escapeHtml('<script>alert("x")</script>');
    assert.strictEqual(result, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});

describe('CSS escaping (font-family injection guard)', () => {
  it('strips characters that could break out of a CSS declaration', () => {
    const evil = 'Arial; background:url(javascript:alert(1))';
    const safe = CsvEditorProvider.__test.escapeCss(evil);
    assert.ok(!safe.includes(';'));
    assert.ok(!safe.includes('('));
    assert.ok(!safe.includes(')'));
    assert.ok(!safe.includes(':'));
  });

  it('strips CSS comment markers and braces', () => {
    const evil = 'X} body{color:red} /*';
    const safe = CsvEditorProvider.__test.escapeCss(evil);
    assert.ok(!safe.includes('{'));
    assert.ok(!safe.includes('}'));
    assert.ok(!safe.includes('/'));
  });

  it('keeps valid font-family characters', () => {
    const ok = "Menlo, 'Courier New', MS Gothic-Regular";
    const safe = CsvEditorProvider.__test.escapeCss(ok);
    assert.strictEqual(safe, ok);
  });
});
