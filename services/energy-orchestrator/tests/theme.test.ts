import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function browser(options: { dark?: boolean; saved?: string; blockedStorage?: boolean; loading?: boolean } = {}) {
  const storage = new Map<string, string>();
  if (options.saved) storage.set('energy-manager-theme', options.saved);
  const root = { dataset: {} as Record<string, string> };
  const attributes = new Map<string, string>();
  const metaAttributes = new Map<string, string>();
  const label = { textContent: '' };
  let click!: () => void;
  let ready!: () => void;
  let systemChange!: () => void;
  const button = {
    title: '',
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    addEventListener: (name: string, callback: () => void) => { assert.equal(name, 'click'); click = callback; },
  };
  const media = {
    matches: Boolean(options.dark),
    addEventListener: (name: string, callback: () => void) => { assert.equal(name, 'change'); systemChange = callback; },
  };
  const document = {
    documentElement: root,
    readyState: options.loading ? 'loading' : 'complete',
    querySelector: () => ({ setAttribute: (name: string, value: string) => metaAttributes.set(name, value) }),
    getElementById: (id: string) => {
      assert.ok(!options.loading, 'Must not look for controls before the DOM is ready');
      assert.ok(id === 'theme-toggle' || id === 'theme-label');
      return id === 'theme-toggle' ? button : label;
    },
    addEventListener: (name: string, callback: () => void) => { assert.equal(name, 'DOMContentLoaded'); ready = callback; },
  };
  vm.runInNewContext(script, {
    document,
    window: {
      matchMedia: (query: string) => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; },
      localStorage: {
        getItem: (key: string) => {
          if (options.blockedStorage) throw new Error('Storage blocked');
          return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (options.blockedStorage) throw new Error('Storage blocked');
          storage.set(key, value);
        },
      },
    },
  });
  return {
    root, storage, attributes, metaAttributes, label, button,
    click: () => click(),
    ready: () => { options.loading = false; ready(); },
    systemChange: (dark: boolean) => { media.matches = dark; systemChange(); },
  };
}

test('initial theme follows the system and continues to follow changes until explicitly selected', () => {
  const b = browser();
  assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.attributes.get('aria-pressed'), 'false');
  assert.equal(b.label.textContent, 'Mode sombre');
  assert.equal(b.button.title, 'Activer le mode sombre');
  b.systemChange(true);
  assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.attributes.get('aria-pressed'), 'true');
  assert.equal(b.metaAttributes.get('content'), '#101817');
  assert.equal(b.label.textContent, 'Mode clair');
  assert.equal(b.button.title, 'Activer le mode clair');
  assert.equal(b.storage.size, 0);
});

test('explicit theme overrides the system and survives a reload', () => {
  const b = browser();
  b.click();
  assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.storage.get('energy-manager-theme'), 'dark');
  b.systemChange(false);
  assert.equal(b.root.dataset.theme, 'dark');
  const restored = browser({ saved: b.storage.get('energy-manager-theme') });
  assert.equal(restored.root.dataset.theme, 'dark');
  restored.click();
  assert.equal(restored.root.dataset.theme, 'light');
  assert.equal(restored.storage.get('energy-manager-theme'), 'light');
  assert.equal(restored.metaAttributes.get('content'), '#f5f6f4');
  assert.equal(restored.attributes.get('aria-pressed'), 'false');
});

test('blocked browser storage does not prevent theme changes or erase an in-page choice', () => {
  const b = browser({ blockedStorage: true, dark: true });
  assert.equal(b.root.dataset.theme, 'dark');
  b.click();
  assert.equal(b.root.dataset.theme, 'light');
  b.systemChange(true);
  assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.attributes.get('aria-pressed'), 'false');
});

test('invalid saved themes are ignored in favor of the system preference', () => {
  const b = browser({ saved: 'unexpected-value', dark: true });
  assert.equal(b.root.dataset.theme, 'dark');
  b.systemChange(false);
  assert.equal(b.root.dataset.theme, 'light');
});

test('theme applies before CSS and controls bind only when the DOM is ready', () => {
  const b = browser({ loading: true, saved: 'dark' });
  assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.attributes.size, 0);
  assert.ok(html.indexOf('src="/theme.js"') < html.indexOf('href="/dashboard.css"'));
  b.ready();
  assert.equal(b.attributes.get('aria-pressed'), 'true');
  assert.equal(b.button.title, 'Activer le mode clair');
  b.click();
  assert.equal(b.root.dataset.theme, 'light');
});
