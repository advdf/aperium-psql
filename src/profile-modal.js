(function () {
  function avatarHtml(user) {
    if (user.avatarUrl) {
      return `<img src="${user.avatarUrl}" alt="avatar">`;
    }
    return (user.displayName || user.email || 'U').charAt(0).toUpperCase();
  }

  function open() {
    const user = window.__currentUser || {};
    const root = document.createElement('div');
    root.className = 'modal-overlay';
    root.innerHTML = `
      <div class="modal-panel">
        <div class="modal-header">
          <h2>Mon profil</h2>
          <button class="modal-close" type="button" aria-label="Fermer">✕</button>
        </div>
        <div class="modal-body">
          <div class="profile-avatar-section">
            <div class="avatar-preview">${avatarHtml(user)}</div>
            <label class="btn-secondary avatar-upload-btn">
              Changer l'avatar
              <input type="file" accept="image/*" hidden>
            </label>
          </div>
          <div class="profile-form">
            <label>Nom d'affichage
              <input type="text" name="displayName" value="${(user.displayName || '').replace(/"/g, '&quot;')}">
            </label>
            <label>Email
              <input type="email" name="email" value="${(user.email || '').replace(/"/g, '&quot;')}">
            </label>
          </div>
          <details class="password-section">
            <summary>Changer le mot de passe</summary>
            <div class="profile-form">
              <label>Mot de passe actuel
                <input type="password" name="currentPassword" autocomplete="current-password">
              </label>
              <label>Nouveau mot de passe (8 caractères minimum)
                <input type="password" name="newPassword" autocomplete="new-password">
              </label>
            </div>
          </details>
          <div class="profile-actions">
            <span class="error-msg"></span>
            <button class="btn-primary save-btn" type="button">Sauvegarder</button>
          </div>
        </div>
      </div>
    `;

    const errEl = root.querySelector('.error-msg');
    const close = () => root.remove();

    root.querySelector('.modal-close').addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });

    const fileInput = root.querySelector('.avatar-upload-btn input');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      errEl.textContent = '';
      try {
        const updated = await window.api.updateAvatar(file);
        window.__currentUser = { ...window.__currentUser, ...updated };
        const preview = root.querySelector('.avatar-preview');
        preview.innerHTML = `<img src="${updated.avatarUrl}" alt="avatar">`;
        document.dispatchEvent(new CustomEvent('user-updated', { detail: updated }));
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    root.querySelector('.save-btn').addEventListener('click', async () => {
      errEl.textContent = '';
      const data = {
        displayName: root.querySelector('input[name=displayName]').value.trim(),
        email: root.querySelector('input[name=email]').value.trim(),
      };
      const cur = root.querySelector('input[name=currentPassword]').value;
      const next = root.querySelector('input[name=newPassword]').value;
      if (cur || next) {
        if (!cur || !next) {
          errEl.textContent = 'Indique le mot de passe actuel et le nouveau.';
          return;
        }
        data.currentPassword = cur;
        data.newPassword = next;
      }
      try {
        const updated = await window.api.updateProfile(data);
        window.__currentUser = { ...window.__currentUser, ...updated };
        document.dispatchEvent(new CustomEvent('user-updated', { detail: updated }));
        close();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.body.appendChild(root);
  }

  window.openProfileModal = open;
})();
