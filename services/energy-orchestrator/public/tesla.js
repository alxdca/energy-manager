(() => {
  'use strict';
  const form = document.getElementById('tesla-connect-form');
  if (!form) return;
  const input = document.getElementById('tesla-refresh-token');
  const disconnect = document.getElementById('tesla-disconnect');
  const feedback = document.getElementById('tesla-feedback');
  const buttons = [...form.querySelectorAll('button')];
  let pending = false;
  async function send(action) {
    if (pending) return;
    const refreshToken = input.value.trim();
    if (action === 'connect' && !form.reportValidity()) return;
    pending = true;
    buttons.forEach(button => { button.disabled = true; });
    input.value = '';
    feedback.textContent = action === 'connect' ? 'Connexion à Tesla…' : 'Déconnexion…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`/api/tesla/${action}`, { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'connect' ? { refreshToken } : {}) });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Connexion Tesla indisponible.');
      feedback.textContent = action === 'connect' ? 'Compte connecté. Lecture du véhicule en cours…' : 'Compte déconnecté de ce serveur.';
      document.dispatchEvent(new Event('tesla-connection-change'));
    } catch (error) {
      feedback.textContent = error.name === 'AbortError' ? 'La demande a expiré. Vérifiez l’état avant de réessayer.' : error.message;
    } finally {
      clearTimeout(timeout);
      pending = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void send('connect'); });
  disconnect.addEventListener('click', () => { void send('disconnect'); });
})();
