import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/pages.js';

test('dashboard car labels use the configured name with a generic fallback', async t => {
  const original = process.env.CAR_NAME;
  t.after(() => {
    if (original === undefined) delete process.env.CAR_NAME;
    else process.env.CAR_NAME = original;
  });

  for (const name of [undefined, '', '   ', '  Our EV  ', '<EV & "car">']) {
    if (name === undefined) delete process.env.CAR_NAME;
    else process.env.CAR_NAME = name;
    const expected = name?.trim() === 'Our EV' ? 'Our EV'
      : name?.startsWith('<') ? '&lt;EV &amp; &quot;car&quot;&gt;' : 'Voiture';
    for (const page of ['accueil', 'appareils', 'pilotage'] as const) {
      const html = await renderPage(page);
      assert.ok(html.includes(`<strong>${expected}</strong> · 75 kWh`), page);
      if (page === 'accueil') assert.ok(html.includes(`<span class="flow-name">${expected}</span>`));
      if (page === 'appareils') assert.ok(html.includes(`<strong>${expected}</strong><span id="tesla-detail">`));
      assert.doesNotMatch(html, /\{\{CAR_NAME\}\}|Model 3|<EV/);
    }
  }
});
