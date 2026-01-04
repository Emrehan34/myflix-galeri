(() => {
  const STORAGE_KEY = 'myflix_gallery_v1';
  const DB_NAME = 'myflix_gallery_db_v1';
  const DB_VERSION = 1;
  const MEDIA_STORE = 'media';

  /** @type {{authMode:'login'|'signup', currentUser:null|{id:string,name:string,email:string,provider:string,avatarUrl:string}, users:Record<string,{id:string,name:string,email:string,password:string,avatarUrl:string}>, albums:Array<any>, ui:{view:'grid'|'list', activeAlbumId:null|string}}} */
  let state = {
    authMode: 'login',
    currentUser: null,
    users: {},
    albums: [],
    ui: { view: 'grid', activeAlbumId: null },
  };

  /** @type {{name:string, type:'image'|'video', file:File, previewUrl:string, createdAt:number}[]} */
  let pendingMedia = [];
  /** @type {null|{albumId:string, mediaId:string}} */
  let activeModalRef = null;

  /** @type {Promise<IDBDatabase>|null} */
  let dbPromise = null;
  /** @type {Map<string,string>} */
  const objectUrlCache = new Map();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function safeId(prefix = 'id') {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('tr-TR', { year: 'numeric', month: 'short', day: '2-digit' });
    } catch {
      return '';
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      toast('Depolama Hatası', 'Tarayıcı depolaması dolu olabilir. Albüm bilgileri kaydedilemedi.', 'warning');
    }
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const store = db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
          store.createIndex('albumId', 'albumId', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb_open_failed'));
    });

    return dbPromise;
  }

  function idbTx(db, mode) {
    return db.transaction([MEDIA_STORE], mode).objectStore(MEDIA_STORE);
  }

  /** @param {{id:string, albumId:string, type:'image'|'video', name:string, blob:Blob, createdAt:string}} rec */
  async function idbPutMedia(rec) {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const store = idbTx(db, 'readwrite');
      const req = store.put(rec);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error || new Error('idb_put_failed'));
    });
  }

  /** @param {string} mediaId */
  async function idbGetMedia(mediaId) {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const store = idbTx(db, 'readonly');
      const req = store.get(mediaId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('idb_get_failed'));
    });
  }

  /** @param {string} albumId */
  async function idbDeleteAlbumMedia(albumId) {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const store = idbTx(db, 'readwrite');
      const idx = store.index('albumId');
      const req = idx.openCursor(IDBKeyRange.only(albumId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(true);
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error('idb_delete_failed'));
    });
  }

  /** @param {string} mediaId */
  async function ensureMediaUrl(mediaId) {
    const cached = objectUrlCache.get(mediaId);
    if (cached) return cached;
    const rec = await idbGetMedia(mediaId);
    if (!rec?.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    objectUrlCache.set(mediaId, url);
    return url;
  }

  /** @param {string} mediaId */
  function revokeMediaUrl(mediaId) {
    const url = objectUrlCache.get(mediaId);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrlCache.delete(mediaId);
    }
  }

  function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl).split(',');
    if (parts.length < 2) return null;
    const meta = parts[0] || '';
    const b64 = parts[1] || '';
    const match = /data:(.*?);base64/.exec(meta);
    const mime = match?.[1] || 'application/octet-stream';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function migrateLegacyBase64MediaIfAny() {
    let mutated = false;
    for (const album of state.albums) {
      if (!Array.isArray(album.media)) continue;
      for (const m of album.media) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.dataUrl !== 'string' || !m.dataUrl.startsWith('data:')) continue;

        const blob = dataUrlToBlob(m.dataUrl);
        if (!blob) continue;

        const id = m.id || safeId('m');
        m.id = id;

        await idbPutMedia({
          id,
          albumId: album.id,
          type: m.type === 'video' ? 'video' : 'image',
          name: m.name || 'media',
          blob,
          createdAt: m.createdAt || album.createdAt || nowIso(),
        });

        delete m.dataUrl;
        mutated = true;
      }
    }

    if (mutated) persist();
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      state = {
        authMode: parsed.authMode === 'signup' ? 'signup' : 'login',
        currentUser: parsed.currentUser ?? null,
        users: parsed.users ?? {},
        albums: Array.isArray(parsed.albums) ? parsed.albums : [],
        ui: {
          view: parsed.ui?.view === 'list' ? 'list' : 'grid',
          activeAlbumId: parsed.ui?.activeAlbumId ?? null,
        },
      };
    } catch {
      // ignore
    }
  }

  function toast(title, msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast';
    const icon = type === 'success' ? 'fa-circle-check' : type === 'warning' ? 'fa-triangle-exclamation' : type === 'danger' ? 'fa-circle-xmark' : 'fa-circle-info';
    el.innerHTML = `
      <i class="fas ${icon}" style="color:${type === 'success' ? 'var(--green)' : type === 'danger' ? 'var(--red2)' : 'rgba(255,255,255,.75)'}"></i>
      <div>
        <div class="t-title">${escapeHtml(title)}</div>
        <div class="t-msg">${escapeHtml(msg)}</div>
      </div>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    window.setTimeout(() => {
      el.classList.remove('show');
      window.setTimeout(() => el.remove(), 250);
    }, 3000);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function setAuthUI(mode) {
    state.authMode = mode;
    const title = $('#auth-title');
    const subtitle = $('#auth-subtitle');
    const btnText = $('#auth-submit-btn .btn-text');
    const switchText = $('#auth-switch-text');
    const switchLink = $('#auth-switch-link');

    if (mode === 'signup') {
      if (title) title.textContent = 'Kayıt Ol';
      if (subtitle) subtitle.textContent = 'Yeni hesabını oluştur';
      if (btnText) btnText.textContent = 'Kayıt Ol';
      if (switchText) switchText.childNodes[0].textContent = 'Zaten hesabın var mı? ';
      if (switchLink) switchLink.textContent = 'Giriş Yap';
    } else {
      if (title) title.textContent = 'Giriş Yap';
      if (subtitle) subtitle.textContent = 'Galerinize başlayın';
      if (btnText) btnText.textContent = 'Giriş Yap';
      if (switchText) switchText.childNodes[0].textContent = 'Hesabınız yok mu? ';
      if (switchLink) switchLink.textContent = 'Kayıt Ol';
    }
    persist();
  }

  function showAuth() {
    const auth = $('#auth-section');
    const app = $('.main-app');
    const header = $('.premium-header');
    if (auth) auth.style.display = '';
    if (app) app.style.display = 'none';
    if (header) header.style.display = 'none';
    setAuthUI(state.authMode);
  }

  function showApp() {
    const auth = $('#auth-section');
    const app = $('.main-app');
    const header = $('.premium-header');
    if (auth) auth.style.display = 'none';
    if (app) app.style.display = '';
    if (header) header.style.display = '';
    hydrateUserHeader();
    showHome();
  }

  function setActiveNav(key) {
    const mapping = {
      home: 0,
      explore: 1,
      albums: 2,
      create: 3,
    };
    const idx = mapping[key] ?? 0;
    const navItems = $$('.main-nav .nav-item');
    navItems.forEach((b, i) => {
      if (i === idx) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  function hideAllSections() {
    const ids = ['hero-section', 'featured-section', 'albums-section', 'create-section', 'album-detail-section'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  function updateStats() {
    const albumsCount = state.albums.length;
    const mediaCount = state.albums.reduce((acc, a) => acc + (Array.isArray(a.media) ? a.media.length : 0), 0);
    const views = state.albums.reduce((acc, a) => acc + (Number(a.views) || 0), 0);

    const sA = $('#stat-albums');
    const sM = $('#stat-media');
    const sV = $('#stat-views');
    if (sA) sA.textContent = String(albumsCount);
    if (sM) sM.textContent = String(mediaCount);
    if (sV) sV.textContent = String(views);
  }

  function renderAlbumsGrid(query = '') {
    const grid = $('#albums-grid');
    if (!grid) return;

    grid.classList.toggle('list', state.ui.view === 'list');

    const q = query.trim().toLowerCase();
    const albums = state.albums
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((a) => {
        if (!q) return true;
        const blob = `${a.name || ''} ${(a.tags || []).join(' ')} ${a.description || ''}`.toLowerCase();
        return blob.includes(q);
      });

    if (albums.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;opacity:.85;border:1px solid rgba(255,255,255,.10);background:rgba(18,18,24,.55);border-radius:18px;padding:16px">
          <div style="font-weight:900">Henüz albüm yok</div>
          <div style="margin-top:6px;color:rgba(255,255,255,.72);font-size:13px;line-height:1.55">"Oluştur" sekmesine gidip ilk albümünü saniyeler içinde oluşturabilirsin.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = albums
      .map((a) => {
        const coverId = pickAlbumCoverId(a);
        const mediaCount = Array.isArray(a.media) ? a.media.length : 0;
        const isFeatured = mediaCount > 0 && (a.views || 0) >= 1;

        const inner = `
          <div class="album-cover">
            ${coverId ? `<img data-cover-src="${escapeHtml(coverId)}" alt="${escapeHtml(a.name || 'Albüm')}"/>` : ''}
            <span class="badge ${isFeatured ? 'featured' : ''}">${isFeatured ? 'Öne Çıkan' : `${mediaCount} öğe`}</span>
          </div>
          <div class="album-body">
            <div class="album-title">${escapeHtml(a.name || 'İsimsiz Albüm')}</div>
            <div class="album-desc">${escapeHtml(a.description || 'Açıklama ekle ve içeriğini düzenle.')}</div>
            <div class="album-meta">
              <span><i class="fas fa-calendar" style="margin-right:6px"></i>${escapeHtml(formatDate(a.createdAt))}</span>
              <span><i class="fas fa-eye" style="margin-right:6px"></i>${escapeHtml(String(a.views || 0))}</span>
            </div>
          </div>
        `;

        if (state.ui.view === 'list') {
          return `
            <div class="album-card" role="button" data-album="${escapeHtml(a.id)}" style="overflow:visible">
              <div style="display:flex;gap:14px;align-items:center;padding:12px">
                <div class="album-cover" style="width:220px;flex:0 0 auto;border-radius:18px;overflow:hidden">
                  ${coverId ? `<img data-cover-src="${escapeHtml(coverId)}" alt="${escapeHtml(a.name || 'Albüm')}"/>` : ''}
                  <span class="badge ${isFeatured ? 'featured' : ''}">${isFeatured ? 'Öne Çıkan' : `${mediaCount} öğe`}</span>
                </div>
                <div style="flex:1">${inner.replace(/^[\s\S]*<div class=\"album-body\">/, '<div class="album-body" style="padding:0">')}</div>
              </div>
            </div>
          `;
        }

        return `<div class="album-card" role="button" data-album="${escapeHtml(a.id)}">${inner}</div>`;
      })
      .join('');

    $$('#albums-grid [data-album]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-album');
        if (id) openAlbum(id);
      });
    });

    hydrateAlbumCovers();
  }

  function pickAlbumCoverId(album) {
    const media = Array.isArray(album.media) ? album.media : [];
    const first = media.find((m) => m.type === 'image') || media[0];
    return first?.id || null;
  }

  function renderFeatured() {
    const container = $('#featured-container');
    if (!container) return;

    const items = [];
    for (const a of state.albums) {
      const media = Array.isArray(a.media) ? a.media : [];
      for (const m of media.slice(0, 2)) {
        items.push({
          albumId: a.id,
          title: a.name || 'Albüm',
          desc: a.description || 'Öne çıkan içerik',
          mediaId: m?.id || null,
          type: m.type === 'video' ? 'video' : 'image',
        });
      }
    }

    if (items.length === 0) {
      const placeholders = [
        { title: 'Yeni Albüm', desc: 'İlk albümünü oluştur ve içerik ekle.', seed: 'flix1' },
        { title: 'Keşfet', desc: 'Fotoğraf ve videolarını tek yerde yönet.', seed: 'flix2' },
        { title: 'Paylaş', desc: 'Albüm linkini kopyalayıp arkadaşlarınla paylaş.', seed: 'flix3' },
      ];
      container.innerHTML = placeholders
        .map(
          (p) => `
          <div class="featured-card" role="button" data-featured="create">
            <img src="https://picsum.photos/seed/${encodeURIComponent(p.seed)}/1200/700" alt="${escapeHtml(p.title)}"/>
            <div class="shade"></div>
            <div class="meta">
              <h3>${escapeHtml(p.title)}</h3>
              <p>${escapeHtml(p.desc)}</p>
            </div>
          </div>
        `
        )
        .join('');

      $$('#featured-container [data-featured]').forEach((el) => {
        el.addEventListener('click', () => showCreate());
      });
      return;
    }

    container.innerHTML = items
      .slice(0, 12)
      .map((it) => {
        const bg = `https://picsum.photos/seed/${encodeURIComponent(it.albumId)}/1200/700`;
        return `
        <div class="featured-card" role="button" data-album="${escapeHtml(it.albumId)}">
          <img ${it.type === 'image' && it.mediaId ? `data-featured-src="${escapeHtml(it.mediaId)}"` : ''} src="${bg}" alt="${escapeHtml(it.title)}"/>
          <div class="shade"></div>
          <div class="meta">
            <h3>${escapeHtml(it.title)}</h3>
            <p>${escapeHtml(it.desc)}</p>
          </div>
        </div>
      `;
      })
      .join('');

    hydrateFeaturedImages();

    $$('#featured-container [data-album]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-album');
        if (id) openAlbum(id);
      });
    });
  }

  function renderAlbumDetail() {
    const albumId = state.ui.activeAlbumId;
    const album = state.albums.find((a) => a.id === albumId);
    if (!album) {
      showAlbums();
      return;
    }

    const title = $('#album-detail-title');
    const desc = $('#album-detail-description');
    const mediaCountEl = $('#album-media-count');
    const viewsEl = $('#album-views');
    const dateEl = $('#album-date');

    if (title) title.textContent = album.name || 'Albüm';
    if (desc) desc.textContent = album.description || '';
    if (mediaCountEl) mediaCountEl.textContent = String((album.media || []).length);
    if (viewsEl) viewsEl.textContent = String(album.views || 0);
    if (dateEl) dateEl.textContent = formatDate(album.createdAt);

    const grid = $('#media-grid');
    if (!grid) return;

    const media = Array.isArray(album.media) ? album.media : [];
    if (media.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;opacity:.85;border:1px solid rgba(255,255,255,.10);background:rgba(18,18,24,.55);border-radius:18px;padding:16px">
          <div style="font-weight:900">Bu albüm boş</div>
          <div style="margin-top:6px;color:rgba(255,255,255,.72);font-size:13px;line-height:1.55">Yeni medya eklemek için "Oluştur" sayfasında albüm oluştururken dosya seçebilirsin.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = media
      .map((m) => {
        const badge = m.type === 'video' ? '<span class="media-badge">VIDEO</span>' : '<span class="media-badge">FOTO</span>';
        const body = m.type === 'video'
          ? `<video data-media-src="${escapeHtml(m.id)}" muted playsinline preload="metadata"></video>`
          : `<img data-media-src="${escapeHtml(m.id)}" alt="${escapeHtml(m.name || 'Medya')}"/>`;
        return `<div class="media-item" role="button" data-media="${escapeHtml(m.id)}">${badge}${body}</div>`;
      })
      .join('');

    hydrateMediaGridSources(album.id);

    $$('#media-grid [data-media]').forEach((el) => {
      el.addEventListener('click', () => {
        const mediaId = el.getAttribute('data-media');
        if (mediaId) openMediaModal(albumId, mediaId);
      });
    });
  }

  function openAlbum(albumId) {
    const album = state.albums.find((a) => a.id === albumId);
    if (!album) return;
    album.views = (album.views || 0) + 1;
    state.ui.activeAlbumId = albumId;
    persist();
    updateStats();

    hideAllSections();
    const detail = $('#album-detail-section');
    if (detail) detail.style.display = '';
    setActiveNav('albums');
    renderAlbumDetail();
  }

  function openMediaModal(albumId, mediaId) {
    const album = state.albums.find((a) => a.id === albumId);
    const media = album?.media?.find((m) => m.id === mediaId);
    if (!album || !media) return;

    activeModalRef = { albumId, mediaId };

    const container = $('#modal-media-container');
    const title = $('#modal-title');
    const desc = $('#modal-description');
    const modal = $('#media-modal');
    if (!container || !modal) return;

    if (title) title.textContent = media.name || album.name || 'Medya';
    if (desc) desc.textContent = album.description || '';

    container.innerHTML = media.type === 'video'
      ? `<video id="modal-video" controls autoplay playsinline></video>`
      : `<img id="modal-img" alt="${escapeHtml(media.name || 'Medya')}"/>`;

    ensureMediaUrl(mediaId).then((url) => {
      if (!url) return;
      const v = document.getElementById('modal-video');
      const i = document.getElementById('modal-img');
      if (v && v.tagName === 'VIDEO') v.setAttribute('src', url);
      if (i && i.tagName === 'IMG') i.setAttribute('src', url);
    });

    modal.classList.add('open');
    modal.style.display = '';
  }

  function closeModal() {
    const modal = $('#media-modal');
    const container = $('#modal-media-container');
    if (container) container.innerHTML = '';
    if (modal) {
      modal.classList.remove('open');
      modal.style.display = 'none';
    }
    activeModalRef = null;
  }

  function hydrateMediaGridSources(albumId) {
    const album = state.albums.find((a) => a.id === albumId);
    if (!album) return;
    const media = Array.isArray(album.media) ? album.media : [];

    for (const m of media) {
      if (!m?.id) continue;
      const els = document.querySelectorAll(`[data-media-src="${CSS.escape(m.id)}"]`);
      if (!els.length) continue;
      ensureMediaUrl(m.id).then((url) => {
        if (!url) return;
        els.forEach((el) => {
          if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
            el.setAttribute('src', url);
          }
        });
      });
    }
  }

  function hydrateAlbumCovers() {
    const imgs = Array.from(document.querySelectorAll('[data-cover-src]'));
    imgs.forEach((img) => {
      const id = img.getAttribute('data-cover-src');
      if (!id) return;
      ensureMediaUrl(id).then((url) => {
        if (!url) return;
        img.setAttribute('src', url);
      });
    });
  }

  function hydrateFeaturedImages() {
    const imgs = Array.from(document.querySelectorAll('[data-featured-src]'));
    imgs.forEach((img) => {
      const id = img.getAttribute('data-featured-src');
      if (!id) return;
      ensureMediaUrl(id).then((url) => {
        if (!url) return;
        img.setAttribute('src', url);
      });
    });
  }

  function hydrateUserHeader() {
    const n = $('#user-display-name');
    const e = $('#user-display-email');
    if (n) n.textContent = state.currentUser?.name || 'Kullanıcı';
    if (e) e.textContent = state.currentUser?.email || 'user@example.com';
  }

  function ensureLoggedIn() {
    if (state.currentUser) return true;
    showAuth();
    return false;
  }

  function toggleUserMenu() {
    const dd = $('#user-dropdown');
    if (!dd) return;
    dd.classList.toggle('open');
  }

  function closeUserMenu() {
    const dd = $('#user-dropdown');
    if (dd) dd.classList.remove('open');
  }

  function showHome() {
    if (!ensureLoggedIn()) return;
    hideAllSections();
    const hero = $('#hero-section');
    const featured = $('#featured-section');
    const albums = $('#albums-section');
    if (hero) hero.style.display = '';
    if (featured) featured.style.display = '';
    if (albums) albums.style.display = '';
    setActiveNav('home');
    renderFeatured();
    renderAlbumsGrid(getSearchQuery());
    updateStats();
  }

  function showExplore() {
    if (!ensureLoggedIn()) return;
    hideAllSections();
    const featured = $('#featured-section');
    const albums = $('#albums-section');
    if (featured) featured.style.display = '';
    if (albums) albums.style.display = '';
    setActiveNav('explore');
    renderFeatured();
    renderAlbumsGrid(getSearchQuery());
  }

  function showAlbums() {
    if (!ensureLoggedIn()) return;
    hideAllSections();
    const albums = $('#albums-section');
    if (albums) albums.style.display = '';
    setActiveNav('albums');
    renderAlbumsGrid(getSearchQuery());
    updateStats();
  }

  function showCreate() {
    if (!ensureLoggedIn()) return;
    hideAllSections();
    const s = $('#create-section');
    if (s) s.style.display = '';
    setActiveNav('create');
  }

  function getSearchQuery() {
    const input = $('.search-bar input');
    return input?.value || '';
  }

  function setView(view) {
    state.ui.view = view === 'list' ? 'list' : 'grid';
    persist();
    const buttons = $$('.view-btn');
    buttons.forEach((b) => {
      const v = b.getAttribute('data-view');
      if (v === state.ui.view) b.classList.add('active');
      else b.classList.remove('active');
    });
    renderAlbumsGrid(getSearchQuery());
  }

  async function filesToPendingMedia(files) {
    const accepted = [];
    for (const f of files) {
      const type = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
      if (!type) continue;
      const previewUrl = URL.createObjectURL(f);
      accepted.push({ name: f.name, type, file: f, previewUrl, createdAt: Date.now() });
    }
    return accepted;
  }

  function renderPendingPreviews() {
    const grid = $('#preview-grid');
    if (!grid) return;

    if (pendingMedia.length === 0) {
      grid.innerHTML = '';
      return;
    }

    grid.innerHTML = pendingMedia
      .map((m, idx) => {
        const pill = m.type === 'video' ? 'VIDEO' : 'FOTO';
        const body = m.type === 'video' ? `<video src="${m.previewUrl}" muted playsinline></video>` : `<img src="${m.previewUrl}" alt="${escapeHtml(m.name)}"/>`;
        return `
          <div class="preview-item" data-idx="${idx}">
            ${body}
            <div class="preview-actions">
              <span class="preview-pill">${pill}</span>
              <button class="preview-remove" type="button" aria-label="Kaldır"><i class="fas fa-times"></i></button>
            </div>
          </div>
        `;
      })
      .join('');

    $$('#preview-grid .preview-item').forEach((el) => {
      const idx = Number(el.getAttribute('data-idx'));
      const btn = el.querySelector('.preview-remove');
      if (!btn) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (Number.isFinite(idx)) {
          const item = pendingMedia[idx];
          if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
          pendingMedia = pendingMedia.filter((_, i) => i !== idx);
          renderPendingPreviews();
        }
      });
    });
  }

  function resetCreateForm() {
    const name = $('#album-name');
    const tags = $('#album-tags');
    const desc = $('#album-description');
    const file = $('#file-input');
    if (name) name.value = '';
    if (tags) tags.value = '';
    if (desc) desc.value = '';
    if (file) file.value = '';
    pendingMedia.forEach((m) => {
      if (m?.previewUrl) URL.revokeObjectURL(m.previewUrl);
    });
    pendingMedia = [];
    renderPendingPreviews();
  }

  async function createAlbumFromForm() {
    const name = String($('#album-name')?.value || '').trim();
    const tagsRaw = String($('#album-tags')?.value || '').trim();
    const desc = String($('#album-description')?.value || '').trim();

    if (!name) {
      toast('Eksik Bilgi', 'Albüm adı zorunlu.', 'warning');
      return null;
    }

    const tags = tagsRaw
      ? tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];

    const albumId = safeId('alb');
    const mediaMeta = [];

    for (const m of pendingMedia) {
      const mediaId = safeId('m');
      mediaMeta.push({
        id: mediaId,
        type: m.type,
        name: m.name,
        createdAt: nowIso(),
        liked: false,
      });
      await idbPutMedia({
        id: mediaId,
        albumId,
        type: m.type,
        name: m.name,
        blob: m.file,
        createdAt: nowIso(),
      });
    }

    const album = {
      id: albumId,
      ownerId: state.currentUser?.id,
      name,
      tags,
      description: desc,
      createdAt: nowIso(),
      views: 0,
      media: mediaMeta,
    };

    state.albums.unshift(album);
    persist();
    updateStats();
    toast('Albüm Oluşturuldu', 'Albüm anında hazır. İçeriği görüntüleniyor…', 'success');

    resetCreateForm();
    openAlbum(album.id);
    return album;
  }

  function togglePassword() {
    const input = $('#password');
    const icon = $('.toggle-password i');
    if (!input) return;
    const isPw = input.getAttribute('type') !== 'text';
    input.setAttribute('type', isPw ? 'text' : 'password');
    if (icon) icon.className = `fas ${isPw ? 'fa-eye-slash' : 'fa-eye'}`;
  }

  async function quickLogin(provider) {
    const name = provider === 'guest' ? 'Misafir' : provider === 'google' ? 'Google Kullanıcısı' : 'Apple Kullanıcısı';
    const email = provider === 'guest' ? `guest_${Date.now()}@myflix.local` : `${provider}_${Date.now()}@myflix.local`;
    const avatarUrl = `https://picsum.photos/seed/${encodeURIComponent(email)}/80/80`;

    const user = { id: safeId('u'), name, email, provider, avatarUrl };
    state.currentUser = user;
    persist();
    toast('Giriş Başarılı', `${name} olarak devam ediyorsun.`, 'success');
    showApp();
  }

  function toggleAuthMode() {
    setAuthUI(state.authMode === 'login' ? 'signup' : 'login');
  }

  function showAllFeatured() {
    toast('Öne Çıkanlar', 'Öne çıkanlar, albümlerdeki içeriklerden otomatik oluşur.', 'info');
  }

  function scrollFeatured(dir) {
    const container = $('#featured-container');
    if (!container) return;
    const amount = Math.round(container.clientWidth * 0.85);
    container.scrollBy({ left: dir === 'prev' ? -amount : amount, behavior: 'smooth' });
  }

  function shareAlbum() {
    const album = state.albums.find((a) => a.id === state.ui.activeAlbumId);
    if (!album) return;
    const text = `MYFLIX Albüm: ${album.name}\n${album.description || ''}\nÖğe: ${(album.media || []).length}`;
    copyToClipboard(text);
  }

  function editAlbum() {
    const album = state.albums.find((a) => a.id === state.ui.activeAlbumId);
    if (!album) return;

    const newName = window.prompt('Albüm Adı', album.name || '') ?? album.name;
    const newDesc = window.prompt('Albüm Açıklaması', album.description || '') ?? album.description;
    const newTags = window.prompt('Etiketler (virgülle)', (album.tags || []).join(', ')) ?? (album.tags || []).join(', ');

    const name = String(newName).trim();
    if (!name) {
      toast('İptal', 'Albüm adı boş olamaz.', 'warning');
      return;
    }

    album.name = name;
    album.description = String(newDesc || '').trim();
    album.tags = String(newTags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);

    persist();
    toast('Güncellendi', 'Albüm bilgileri kaydedildi.', 'success');
    renderAlbumDetail();
    renderAlbumsGrid(getSearchQuery());
    renderFeatured();
  }

  function deleteAlbum() {
    const album = state.albums.find((a) => a.id === state.ui.activeAlbumId);
    if (!album) return;
    const ok = window.confirm(`"${album.name}" albümü silinsin mi?`);
    if (!ok) return;

    const media = Array.isArray(album.media) ? album.media : [];
    media.forEach((m) => {
      if (m?.id) revokeMediaUrl(m.id);
    });

    idbDeleteAlbumMedia(album.id).catch(() => {
      // ignore
    });

    state.albums = state.albums.filter((a) => a.id !== album.id);
    state.ui.activeAlbumId = null;
    persist();
    toast('Silindi', 'Albüm kaldırıldı.', 'success');
    showAlbums();
    renderFeatured();
    updateStats();
  }

  function likeMedia() {
    if (!activeModalRef) return;
    const album = state.albums.find((a) => a.id === activeModalRef.albumId);
    const media = album?.media?.find((m) => m.id === activeModalRef.mediaId);
    if (!media) return;
    media.liked = !media.liked;
    persist();
    toast(media.liked ? 'Beğenildi' : 'Beğeni kaldırıldı', media.name || 'Medya', media.liked ? 'success' : 'info');
  }

  function downloadMedia() {
    if (!activeModalRef) return;
    const album = state.albums.find((a) => a.id === activeModalRef.albumId);
    const media = album?.media?.find((m) => m.id === activeModalRef.mediaId);
    if (!media) return;

    ensureMediaUrl(media.id).then((url) => {
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = media.name || (media.type === 'video' ? 'video.mp4' : 'image.jpg');
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('İndiriliyor', media.name || 'Medya', 'info');
    });
  }

  function shareMedia() {
    if (!activeModalRef) return;
    const album = state.albums.find((a) => a.id === activeModalRef.albumId);
    const media = album?.media?.find((m) => m.id === activeModalRef.mediaId);
    if (!album || !media) return;

    const text = `MYFLIX Medya: ${media.name || ''}\nAlbüm: ${album.name || ''}`;
    copyToClipboard(text);
  }

  function copyToClipboard(text) {
    const done = () => toast('Kopyalandı', 'Panoya kopyalandı.', 'success');
    const fail = () => toast('Kopyalama Başarısız', 'Tarayıcı izin vermedi. Manuel kopyalayabilirsin.', 'warning');

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
      return;
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch {
      fail();
    }
  }

  function showProfile() {
    toast('Profil', 'Profil ekranı yakında. Şimdilik albümlerine odaklan.', 'info');
    closeUserMenu();
  }

  function showSettings() {
    toast('Ayarlar', 'Tema/ayarlar yakında eklenecek.', 'info');
    closeUserMenu();
  }

  function showHelp() {
    toast('Yardım', 'Albüm oluştur: Oluştur > isim ver > dosya seç > Albümü Oluştur.', 'info');
    closeUserMenu();
  }

  function logout() {
    closeUserMenu();
    state.currentUser = null;
    state.ui.activeAlbumId = null;
    persist();
    showAuth();
  }

  function bindAuth() {
    const form = $('#auth-form');
    if (!form) return;

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();

      const email = String($('#email')?.value || '').trim().toLowerCase();
      const pw = String($('#password')?.value || '');

      if (!email || !pw) {
        toast('Eksik Bilgi', 'E-posta ve şifre gerekli.', 'warning');
        return;
      }

      if (state.authMode === 'signup') {
        if (state.users[email]) {
          toast('Kayıt Başarısız', 'Bu e-posta zaten kayıtlı.', 'warning');
          return;
        }

        const name = email.split('@')[0] || 'Kullanıcı';
        const user = {
          id: safeId('u'),
          name,
          email,
          password: pw,
          avatarUrl: `https://picsum.photos/seed/${encodeURIComponent(email)}/80/80`,
        };
        state.users[email] = user;
        state.currentUser = { id: user.id, name: user.name, email: user.email, provider: 'email', avatarUrl: user.avatarUrl };
        persist();
        toast('Kayıt Başarılı', 'Hesabın oluşturuldu.', 'success');
        showApp();
        return;
      }

      const user = state.users[email];
      if (!user || user.password !== pw) {
        toast('Giriş Başarısız', 'E-posta veya şifre hatalı.', 'danger');
        return;
      }

      state.currentUser = { id: user.id, name: user.name, email: user.email, provider: 'email', avatarUrl: user.avatarUrl };
      persist();
      toast('Hoş geldin', 'Giriş başarılı.', 'success');
      showApp();
    });
  }

  function bindCreate() {
    const createForm = $('#create-form');
    const fileInput = $('#file-input');
    const uploadArea = $('#upload-area');

    if (createForm) {
      createForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await createAlbumFromForm();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files || []);
        if (files.length === 0) return;
        const converted = await filesToPendingMedia(files);
        pendingMedia = pendingMedia.concat(converted).slice(0, 36);
        renderPendingPreviews();
        toast('Eklendi', `${converted.length} dosya hazır.`, 'success');
      });
    }

    if (uploadArea) {
      const prevent = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evName) => {
        uploadArea.addEventListener(evName, prevent);
      });

      uploadArea.addEventListener('dragenter', () => uploadArea.classList.add('dragover'));
      uploadArea.addEventListener('dragover', () => uploadArea.classList.add('dragover'));
      uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));

      uploadArea.addEventListener('drop', async (e) => {
        uploadArea.classList.remove('dragover');
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        const converted = await filesToPendingMedia(files);
        pendingMedia = pendingMedia.concat(converted).slice(0, 36);
        renderPendingPreviews();
        toast('Eklendi', `${converted.length} dosya hazır.`, 'success');
      });
    }
  }

  function bindSearch() {
    const input = $('.search-bar input');
    if (!input) return;
    input.addEventListener('input', () => {
      if (!state.currentUser) return;
      renderAlbumsGrid(getSearchQuery());
    });
  }

  function bindGlobal() {
    document.addEventListener('click', (e) => {
      const menu = $('.user-menu');
      const dd = $('#user-dropdown');
      if (!menu || !dd) return;
      if (dd.classList.contains('open')) {
        const t = /** @type {HTMLElement} */ (e.target);
        if (!menu.contains(t)) dd.classList.remove('open');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeUserMenu();
      }
    });
  }

  function initViewButtons() {
    const buttons = $$('.view-btn');
    buttons.forEach((b) => {
      const v = b.getAttribute('data-view');
      if (v === state.ui.view) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  async function bootstrap() {
    load();
    try {
      await openDb();
      await migrateLegacyBase64MediaIfAny();
    } catch {
      toast('Depolama Uyarısı', 'Tarayıcı IndexedDB desteği yok veya kapalı. Medyalar kalıcı kaydedilemeyebilir.', 'warning');
    }

    bindAuth();
    bindCreate();
    bindSearch();
    bindGlobal();
    initViewButtons();

    if (state.currentUser) showApp();
    else showAuth();
  }

  // Expose functions used by inline HTML onclick handlers
  window.showHome = showHome;
  window.showExplore = showExplore;
  window.showAlbums = showAlbums;
  window.showCreate = showCreate;
  window.toggleUserMenu = toggleUserMenu;
  window.showProfile = showProfile;
  window.showSettings = showSettings;
  window.showHelp = showHelp;
  window.logout = logout;
  window.togglePassword = togglePassword;
  window.quickLogin = quickLogin;
  window.toggleAuthMode = toggleAuthMode;
  window.showAllFeatured = showAllFeatured;
  window.scrollFeatured = scrollFeatured;
  window.setView = setView;
  window.shareAlbum = shareAlbum;
  window.editAlbum = editAlbum;
  window.deleteAlbum = deleteAlbum;
  window.closeModal = closeModal;
  window.likeMedia = likeMedia;
  window.downloadMedia = downloadMedia;
  window.shareMedia = shareMedia;

  bootstrap();
})();
