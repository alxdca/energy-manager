import { readFile } from 'node:fs/promises';

export type PageKey = 'accueil' | 'pilotage' | 'donnees' | 'planification' | 'tarifs' | 'appareils';

const forecastFragment = new URL('../public/pages/forecast.html', import.meta.url);

const pages: Record<PageKey, {
  path: string;
  title: string;
  navLabel?: string;
  description: string;
  icon: string;
  fragment: URL;
}> = {
  accueil: {
    path: '/', title: 'Accueil',
    description: 'Production, consommation et réserves de votre maison.',
    icon: 'overview', fragment: new URL('../public/pages/home.html', import.meta.url),
  },
  pilotage: {
    path: '/pilotage', title: 'Pilotage',
    description: 'Réglez la batterie et la voiture, ou revenez en mode auto.',
    icon: 'controls', fragment: new URL('../public/pages/controls.html', import.meta.url),
  },
  donnees: {
    path: '/donnees', title: 'Données',
    description: 'Consultez les mesures et les prévisions enregistrées, jour par jour.',
    icon: 'history', fragment: new URL('../public/pages/history.html', import.meta.url),
  },
  planification: {
    path: '/planification', title: 'Planification', navLabel: 'Plan',
    description: 'Décisions automatiques, réserve et besoins à venir.',
    icon: 'battery', fragment: new URL('../public/pages/planning.html', import.meta.url),
  },
  tarifs: {
    path: '/tarifs', title: 'Tarifs',
    description: 'Consultez vos tarifs, vos créneaux et les objectifs de votre installation.',
    icon: 'clock', fragment: new URL('../public/pages/tariffs.html', import.meta.url),
  },
  appareils: {
    path: '/appareils', title: 'Appareils',
    description: 'Retrouvez les connexions et la disponibilité de vos mesures.',
    icon: 'link', fragment: new URL('../public/pages/devices.html', import.meta.url),
  },
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/** Render only explicitly registered pages and their trusted local fragments. */
export async function renderPage(page: PageKey): Promise<string> {
  const metadata = pages[page];
  const [shell, content, homeControls, homeForecast] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(metadata.fragment, 'utf8'),
    page === 'accueil' ? readFile(pages.pilotage.fragment, 'utf8') : Promise.resolve(''),
    page === 'accueil' ? readFile(forecastFragment, 'utf8') : Promise.resolve(''),
  ]);
  const carName = escapeHtml(process.env.CAR_NAME?.trim() || 'Voiture');
  const displayContent = content.replaceAll('{{ENERGY_UNIT}}', 'kWh');
  const replacements: Record<string, string> = {
    CAR_NAME: carName,
    PAGE_KEY: page,
    PAGE_TITLE: escapeHtml(metadata.title),
    PAGE_DESCRIPTION: escapeHtml(metadata.description),
    PAGE_INITIAL_DATE: page === 'donnees' ? '—' : 'Europe/Zurich',
    PAGE_TIMEZONE_LABEL: page === 'donnees' ? '' : 'Zurich',
    PAGE_STYLES: page === 'donnees' ? '<link rel="stylesheet" href="/history.css">' : '',
    PAGE_CONTENT: homeControls ? `<div class="home-overview">${content}\n<div class="desktop-home-forecast">${homeForecast.replaceAll('{{ENERGY_UNIT}}', 'kWh')}</div></div>\n<div class="desktop-home-controls">${homeControls}</div>` : displayContent,
    PAGE_SCRIPTS: [
      page !== 'donnees' ? '<script src="/dashboard.js" defer></script>' : '',
      page === 'accueil' || page === 'pilotage' ? '<script src="/controls.js" defer></script>' : '',
      page === 'accueil' || page === 'appareils' ? '<script src="/forecast.js" defer></script>' : '',
      page === 'appareils' ? '<script src="/tesla.js" defer></script>' : '',
      page === 'donnees' ? '<script src="/history.js" type="module"></script>' : '',
    ].filter(Boolean).join('\n  '),
    PAGE_NAV: Object.entries(pages).map(([key, item]) => {
      const active = key === page;
      return `<a class="nav-link${active ? ' active' : ''}" href="${item.path}"${active ? ' aria-current="page"' : ''}${item.navLabel ? ` aria-label="${item.title}"` : ''}><svg class="icon"><use href="#i-${item.icon}"/></svg><span class="nav-label">${item.navLabel ?? item.title}</span>${active ? '<span class="nav-dot"></span>' : ''}</a>`;
    }).join('\n      '),
  };
  replacements.PAGE_CONTENT = replacements.PAGE_CONTENT.replaceAll('{{CAR_NAME}}', () => carName);
  return shell.replace(/\{\{([A-Z_]+)\}\}/g, (token, key: string) => replacements[key] ?? token);
}
