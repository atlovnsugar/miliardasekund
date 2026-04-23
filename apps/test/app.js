/**
 * Voting Visualization App - FINAL OPTIMIZED VERSION
 * Features: Lazy loading, LRU cache, batch fetching, retry logic, 
 *           pagination (20 items/page), collapsible details, loading animations
 * Data: index.json, politicians/registry.json, sessions/session_N.json
 */

// ============================================================================
// MODULE 1: Config & State
// ============================================================================
const AppConfig = {
  DATA_BASE: './data',
  COMPRESSED: false,
  CACHE_DURATION: 3600000,
  MAX_CACHED_SESSIONS: 15,
  TERM_RANGES: {
    '2021-2025': { from: '2021-10-01', to: '2025-12-31' },
    '2017-2021': { from: '2017-10-01', to: '2021-09-30' },
    '2013-2017': { from: '2013-10-01', to: '2017-09-30' },
    '2010-2013': { from: '2010-06-01', to: '2013-09-30' },
    '2006-2010': { from: '2006-06-01', to: '2010-05-31' },
    '2002-2006': { from: '2002-06-01', to: '2006-05-31' },
    '1998-2002': { from: '1998-06-01', to: '2002-05-31' },
    '1996-1998': { from: '1996-06-01', to: '1998-05-31' },
  },
  MAX_TIMELINE_ITEMS: 2000,
  BATCH_SIZE: 8,
  LAZY_LOAD_MARGIN: '300px',
  
  // ⭐ NOVÉ: Pagination & Retry config
  ITEMS_PER_PAGE: 20,
  MAX_PAGES_VISIBLE: 5,
  RETRY_MAX_ATTEMPTS: 3,
  RETRY_BASE_DELAY: 500, // ms
  RETRY_BACKOFF_MULTIPLIER: 2,
};

const AppState = {
  index: null,
  registry: null,
  sessionCache: new Map(),
  sessionAccessOrder: [],
  currentTerm: null,
  currentPolitician: null,
  currentPoliticianId: null,
  filteredVotes: [],
  monthlySort: 'date',
  activeFetchControllers: new Map(),
  
  // ⭐ NOVÉ: Pagination state
  timelinePage: 1,
  timelineTotalPages: 1,
  popupPage: 1,
  popupTotalPages: 1,
  
  // ⭐ NOVÉ: Loading state
  isLoading: false,
  loadingProgress: 0,
  loadingMessage: '',
  
  // ⭐ NOVÉ: UI state
  showPopupDetails: true, // Collapsible detail default: otevřeno
};

// ============================================================================
// MODULE 2: Data Loader (with Retry Logic + Progress Callback)
// ============================================================================
const DataLoader = (() => {
  const memoryCache = new Map();
  const retryCounts = new Map(); // Track retry attempts per URL

  function markSessionAccessed(sessionNum) {
    const idx = AppState.sessionAccessOrder.indexOf(sessionNum);
    if (idx > -1) AppState.sessionAccessOrder.splice(idx, 1);
    AppState.sessionAccessOrder.push(sessionNum);
  }

  function evictOldestSession() {
    if (AppState.sessionAccessOrder.length === 0) return;
    const oldest = AppState.sessionAccessOrder.shift();
    AppState.sessionCache.delete(oldest);
  }

  // ⭐ NOVÉ: Exponential backoff retry helper
  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchJSON(url, onProgress = null) {
    const cached = memoryCache.get(url);
    if (cached && Date.now() - cached.time < AppConfig.CACHE_DURATION) {
      if (onProgress) onProgress(100, 'Načteno z cache');
      return cached.data;
    }

    // Abort previous request for same URL
    if (AppState.activeFetchControllers.has(url)) {
      AppState.activeFetchControllers.get(url).abort();
      AppState.activeFetchControllers.delete(url);
    }
    
    const controller = new AbortController();
    AppState.activeFetchControllers.set(url, controller);

    let lastError = null;
    
    // ⭐ NOVÉ: Retry loop with exponential backoff
    for (let attempt = 1; attempt <= AppConfig.RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        if (onProgress && attempt > 1) {
          onProgress(Math.round(30 + (attempt - 1) * 20), `Opakovaný pokus ${attempt}/${AppConfig.RETRY_MAX_ATTEMPTS}...`);
        }

        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

        if (onProgress) onProgress(70, 'Dekomprimace dat...');

        let data;
        if (url.endsWith('.gz')) {
          const buffer = await res.arrayBuffer();
          const decompressed = pako.inflate(new Uint8Array(buffer), { to: 'string' });
          data = JSON.parse(decompressed);
        } else {
          data = await res.json();
        }

        memoryCache.set(url, { data, time: Date.now() });
        retryCounts.delete(url); // Reset retry count on success
        
        if (onProgress) onProgress(100, 'Hotovo');
        return data;
        
      } catch (err) {
        lastError = err;
        
        if (err.name === 'AbortError') {
          console.debug(`Fetch aborted: ${url}`);
          return null;
        }
        
        console.warn(`Fetch attempt ${attempt} failed for ${url}:`, err.message);
        
        // ⭐ NOVÉ: Wait before retry (exponential backoff)
        if (attempt < AppConfig.RETRY_MAX_ATTEMPTS) {
          const delay = AppConfig.RETRY_BASE_DELAY * Math.pow(AppConfig.RETRY_BACKOFF_MULTIPLIER, attempt - 1);
          if (onProgress) onProgress(Math.round(30 + (attempt - 1) * 15), `Čekám ${Math.round(delay/1000)}s před dalším pokusem...`);
          await sleep(delay);
        }
      }
    }
    
    // All attempts failed
    console.error(`Failed to fetch ${url} after ${AppConfig.RETRY_MAX_ATTEMPTS} attempts`);
    if (onProgress) onProgress(-1, `Chyba: ${lastError?.message || 'Neznámá chyba'}`);
    throw lastError;
  }

  return {
    async loadIndex(onProgress = null) {
      if (onProgress) onProgress(0, 'Načítám index...');
      const data = await fetchJSON(`${AppConfig.DATA_BASE}/index.json`, onProgress);
      AppState.index = data;
      return data;
    },
    async loadRegistry(onProgress = null) {
      if (onProgress) onProgress(0, 'Načítám registry...');
      const data = await fetchJSON(`${AppConfig.DATA_BASE}/politicians/registry.json`, onProgress);
      AppState.registry = data.pol;
      return data.pol;
    },
    async loadSession(sessionNum, onProgress = null) {
      if (AppState.sessionCache.has(sessionNum)) {
        markSessionAccessed(sessionNum);
        return AppState.sessionCache.get(sessionNum);
      }

      const file = `${AppConfig.DATA_BASE}/sessions/session_${sessionNum}.json`;
      const data = await fetchJSON(file, onProgress);
      if (!data) return null;

      while (AppState.sessionCache.size >= AppConfig.MAX_CACHED_SESSIONS) {
        evictOldestSession();
      }

      AppState.sessionCache.set(sessionNum, data);
      markSessionAccessed(sessionNum);
      return data;
    },
    async loadVoteDetail(voteId, onProgress = null) {
      const entry = AppState.index?.entries?.find(e => e.id === voteId);
      if (!entry) return null;
      const session = await this.loadSession(entry.s, onProgress);
      return session?.votes?.find(v => v.id === voteId);
    },
    async loadSessionsBatched(sessionNums, batchSize = AppConfig.BATCH_SIZE, onProgress = null) {
      const uniqueSessions = [...new Set(sessionNums.filter(Boolean))];
      const total = uniqueSessions.length;
      
      for (let i = 0; i < uniqueSessions.length; i += batchSize) {
        const batch = uniqueSessions.slice(i, i + batchSize);
        await Promise.all(batch.map((n, idx) => 
          this.loadSession(n, onProgress ? (p, m) => onProgress(Math.round((i + idx) / total * 100), m) : null)
        ));
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI
      }
    },
    clearCache() {
      memoryCache.clear();
      AppState.sessionCache.clear();
      AppState.sessionAccessOrder = [];
      for (const controller of AppState.activeFetchControllers.values()) {
        controller.abort();
      }
      AppState.activeFetchControllers.clear();
      retryCounts.clear();
    },
    invalidateSession(sessionNum) {
      AppState.sessionCache.delete(sessionNum);
      const idx = AppState.sessionAccessOrder.indexOf(sessionNum);
      if (idx > -1) AppState.sessionAccessOrder.splice(idx, 1);
    }
  };
})();

// ============================================================================
// MODULE 3: Utilities
// ============================================================================
const Utils = {
  getTermForDate(dateStr) {
    const d = new Date(dateStr);
    for (const [term, range] of Object.entries(AppConfig.TERM_RANGES)) {
      if (d >= new Date(range.from) && d <= new Date(range.to)) return term;
    }
    return null;
  },
  getVotesForTerm(term) {
    if (!AppState.index?.entries) return [];
    const range = AppConfig.TERM_RANGES[term];
    if (!range) return [];
    return AppState.index.entries.filter(v => v.d >= range.from && v.d <= range.to);
  },
  formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
  },
  formatMonth(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
  },
  monthKey(dateStr) {
    return dateStr.substring(0, 7);
  },
  getVoteLabel(vt) {
    const labels = { A: 'Ano', N: 'Ne', Z: 'Zdržel se', '0': 'Nepřihlášen', M: 'Omluven' };
    return labels[vt] || '?';
  },
  getVoteClass(vt) {
    const classes = { A: 'vote-yes', N: 'vote-no', Z: 'vote-abstain', '0': 'vote-not-logged', M: 'vote-excused' };
    return classes[vt] || '';
  },
  debounce(fn, ms) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), ms);
    };
  },
  
  // ⭐ NOVÉ: Pagination helpers
  paginateArray(arr, page, itemsPerPage) {
    const start = (page - 1) * itemsPerPage;
    return arr.slice(start, start + itemsPerPage);
  },
  calculateTotalPages(totalItems, itemsPerPage) {
    return Math.max(1, Math.ceil(totalItems / itemsPerPage));
  },
  getPageRange(currentPage, totalPages, maxVisible = AppConfig.MAX_PAGES_VISIBLE) {
    const half = Math.floor(maxVisible / 2);
    let start = Math.max(1, currentPage - half);
    let end = Math.min(totalPages, start + maxVisible - 1);
    
    if (end - start + 1 < maxVisible) {
      start = Math.max(1, end - maxVisible + 1);
    }
    
    const pages = [];
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  },
  
  // ⭐ NOVÉ: Loading UI helpers
  showLoading(message = 'Načítám data...', progress = 0) {
    AppState.isLoading = true;
    AppState.loadingMessage = message;
    AppState.loadingProgress = progress;
    const loader = document.getElementById('globalLoader');
    const loaderMsg = document.getElementById('loaderMessage');
    const loaderBar = document.getElementById('loaderProgress');
    
    if (loader) loader.classList.remove('hidden');
    if (loaderMsg) loaderMsg.textContent = message;
    if (loaderBar) {
      loaderBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      if (progress < 0) loaderBar.classList.add('indeterminate');
      else loaderBar.classList.remove('indeterminate');
    }
  },
  hideLoading() {
    AppState.isLoading = false;
    const loader = document.getElementById('globalLoader');
    if (loader) loader.classList.add('hidden');
  },
  updateLoadingProgress(progress, message) {
    AppState.loadingProgress = progress;
    AppState.loadingMessage = message;
    const loaderMsg = document.getElementById('loaderMessage');
    const loaderBar = document.getElementById('loaderProgress');
    if (loaderMsg) loaderMsg.textContent = message;
    if (loaderBar) {
      loaderBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      if (progress < 0) loaderBar.classList.add('indeterminate');
      else loaderBar.classList.remove('indeterminate');
    }
  }
};

// ============================================================================
// MODULE 4: Politician Search
// ============================================================================
const PoliticianSearch = (() => {
  const input = document.getElementById('politicianInput');
  const dropdown = document.getElementById('politicianDropdown');
  const clearBtn = document.getElementById('clearPoliticianBtn');

  function showDropdown(items) {
    dropdown.innerHTML = '';
    if (items.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }
    items.slice(0, 15).forEach(([pid, pol]) => {
      const div = document.createElement('div');
      div.className = 'dropdown-item';
      div.innerHTML = `<span class="pi-name">${pol.n}</span><span class="pi-party">${pol.p}</span>`;
      div.onclick = () => selectPolitician(pid, pol.n);
      dropdown.appendChild(div);
    });
    dropdown.classList.remove('hidden');
  }

  function selectPolitician(pid, name) {
    AppState.currentPoliticianId = pid;
    AppState.currentPolitician = name;
    input.value = name;
    dropdown.classList.add('hidden');
    if (clearBtn) clearBtn.style.display = 'inline-flex';
    App.render();
  }

  function clearSelection() {
    AppState.currentPoliticianId = null;
    AppState.currentPolitician = null;
    input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    App.render();
  }

  function init() {
    if (!input) return;
    
    input.addEventListener('input', Utils.debounce(() => {
      const q = input.value.toLowerCase().trim();
      if (!q || !AppState.registry) {
        dropdown.classList.add('hidden');
        return;
      }
      const matches = Object.entries(AppState.registry)
        .filter(([pid, pol]) => {
          const nameMatch = pol.n.toLowerCase().includes(q);
          const aliasMatch = pol.a?.some(a => a.toLowerCase().includes(q));
          return nameMatch || aliasMatch;
        })
        .sort((a, b) => a[1].n.localeCompare(b[1].n));
      showDropdown(matches);
    }, 200));

    input.addEventListener('focus', () => {
      if (input.value && dropdown.children.length > 0) dropdown.classList.remove('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.politician-search-wrapper')) dropdown.classList.add('hidden');
    });

    if (clearBtn) clearBtn.addEventListener('click', clearSelection);

    const closeBtn = document.getElementById('popupClose');
  if (closeBtn) {
    closeBtn.onclick = hide;
    closeBtn.setAttribute('aria-label', 'Zavřít detail');
  }
  if (overlay) {
    overlay.onclick = (e) => { if (e.target === overlay) hide(); };
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.showVotePopup = show;
  window.VotePopup = { retryLast }; 
  }

  return { init, selectPolitician, clearSelection };
})();

// ============================================================================
// MODULE 5: Timeline Renderer (Lazy Loading + Pagination)
// ============================================================================
const TimelineRenderer = (() => {
  const container = document.getElementById('timelineTrack');
  const countEl = document.getElementById('voteCount');
  const emptyEl = document.getElementById('timelineEmpty');
  const paginationEl = document.getElementById('timelinePagination');
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
      if (entry.isIntersecting) {
        const item = entry.target;
        const vote = item._voteData;
        const politicianId = item._politicianId;
        
        if (politicianId && !item._loaded && !item._loading) {
          item._loading = true;
          item.classList.add('loading');
          
          try {
            const session = await DataLoader.loadSession(vote.s);
            if (!session?.votes) throw new Error('No votes in session');
            
            const voteDetail = session.votes.find(v => v.id === vote.id);
            const politicianVote = voteDetail?.vl?.find(v => v.i == politicianId);
            const voteType = politicianVote?.vt || null;
            
            item.innerHTML = `
              <div class="timeline-dot ${voteType ? Utils.getVoteClass(voteType) : (vote.r || 'unknown')}"></div>
              <div class="timeline-item-content">
                <div class="timeline-item-left">
                  <span class="timeline-date">${Utils.formatDate(vote.d)}</span>
                  <span class="timeline-session">Schůze ${vote.s}, hlasování ${vote.v}</span>
                </div>
                <div class="timeline-item-right">
                  <span class="timeline-badge ${voteType ? Utils.getVoteClass(voteType) : (vote.r === 'accepted' ? 'vote-yes' : 'vote-no')}">
                    ${voteType ? Utils.getVoteLabel(voteType) : (vote.r === 'accepted' ? 'Přijato' : 'Zamítnuto')}
                  </span>
                </div>
              </div>
            `;
            item.onclick = () => showVotePopup(vote.id);
            item.classList.remove('loading');
            item._loaded = true;
          } catch (e) {
            console.warn('Failed to load vote detail:', e);
            item.classList.add('loading-error');
            const badge = item.querySelector('.timeline-badge');
            if (badge) {
              badge.textContent = 'Chyba';
              badge.title = e.message;
            }
          }
        }
        observer.unobserve(item);
      }
    });
  }, { rootMargin: AppConfig.LAZY_LOAD_MARGIN });

  function render(votes, politicianId, page = 1) {
    observer.disconnect();
    container.innerHTML = '';
    
    if (!votes || votes.length === 0) {
      emptyEl.style.display = 'block';
      if (countEl) countEl.textContent = '0 hlasování';
      if (paginationEl) paginationEl.innerHTML = '';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    
    // ⭐ NOVÉ: Pagination logic
    const totalPages = Utils.calculateTotalPages(votes.length, AppConfig.ITEMS_PER_PAGE);
    AppState.timelineTotalPages = totalPages;
    AppState.timelinePage = Math.min(page, totalPages);
    
    const paginatedVotes = Utils.paginateArray(votes, AppState.timelinePage, AppConfig.ITEMS_PER_PAGE);
    const displayVotes = paginatedVotes.slice(-AppConfig.MAX_TIMELINE_ITEMS).reverse();
    
    if (countEl) countEl.textContent = `${votes.length} hlasování (strana ${AppState.timelinePage}/${totalPages})`;

    displayVotes.forEach(vote => {
      const placeholder = createPlaceholderItem(vote, politicianId);
      container.appendChild(placeholder);
      observer.observe(placeholder);
    });
    
    // ⭐ NOVÉ: Render pagination controls
    renderPagination(paginationEl, AppState.timelinePage, totalPages, (newPage) => {
      render(votes, politicianId, newPage);
    });
  }

  function renderPagination(container, currentPage, totalPages, onPageChange) {
    if (!container) return;
    
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }
    
    const pages = Utils.getPageRange(currentPage, totalPages);
    const hasPrev = currentPage > 1;
    const hasNext = currentPage < totalPages;
    
    container.innerHTML = `
      <div class="pagination-wrapper">
        <button class="pagination-btn ${!hasPrev ? 'disabled' : ''}" data-action="prev" ${!hasPrev ? 'disabled' : ''}>
          ← Předchozí
        </button>
        <div class="pagination-pages">
          ${pages.map(p => `
            <button class="pagination-page ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>
          `).join('')}
          ${pages[0] > 1 ? '<span class="pagination-ellipsis">...</span>' : ''}
          ${pages[pages.length - 1] < totalPages ? '<span class="pagination-ellipsis">...</span>' : ''}
        </div>
        <button class="pagination-btn ${!hasNext ? 'disabled' : ''}" data-action="next" ${!hasNext ? 'disabled' : ''}>
          Další →
        </button>
      </div>
    `;
    
    // Bind events
    container.querySelectorAll('[data-action="prev"]').forEach(btn => {
      btn.onclick = (e) => { e.preventDefault(); if (hasPrev) onPageChange(currentPage - 1); };
    });
    container.querySelectorAll('[data-action="next"]').forEach(btn => {
      btn.onclick = (e) => { e.preventDefault(); if (hasNext) onPageChange(currentPage + 1); };
    });
    container.querySelectorAll('[data-page]').forEach(btn => {
      btn.onclick = (e) => { e.preventDefault(); onPageChange(parseInt(btn.dataset.page)); };
    });
  }

  function createPlaceholderItem(vote, politicianId) {
    const item = document.createElement('div');
    item.className = 'timeline-item loading';
    item._voteData = vote;
    item._politicianId = politicianId;
    item._loaded = false;
    item._loading = false;
    
    item.onclick = () => showVotePopup(vote.id);
    
    item.innerHTML = `
      <div class="timeline-dot loading"></div>
      <div class="timeline-item-content">
        <div class="timeline-item-left">
          <span class="timeline-date">${Utils.formatDate(vote.d)}</span>
          <span class="timeline-session">Schůze ${vote.s}, hlasování ${vote.v}</span>
        </div>
        <div class="timeline-item-right">
          <span class="timeline-badge loading">Načítám...</span>
        </div>
      </div>
    `;
    return item;
  }

  return { render, destroy: () => observer.disconnect() };
})();

// ============================================================================
// MODULE 6: Stats Renderer (Batch Loading)
// ============================================================================
const StatsRenderer = (() => {
  const panel = document.getElementById('statsPanel');
  const nameEl = document.getElementById('statsPoliticianName');
  const partyEl = document.getElementById('statsPoliticianParty');

  async function render(votes, politicianId) {
    if (!politicianId) {
      if (panel) panel.classList.add('hidden');
      return;
    }

    if (panel) panel.classList.remove('hidden');
    const pol = AppState.registry?.[politicianId];
    if (nameEl) nameEl.textContent = pol?.n || 'Neznámý';
    if (partyEl) partyEl.textContent = pol?.p || '';

    const polVotes = [];
    const sessionsNeeded = new Set(votes.map(v => v.s).filter(Boolean));
    
    // Show loading progress for stats
    Utils.updateLoadingProgress(10, 'Načítám data pro statistiky...');
    
    await DataLoader.loadSessionsBatched([...sessionsNeeded], AppConfig.BATCH_SIZE, 
      (progress, message) => Utils.updateLoadingProgress(10 + progress * 0.6, message)
    );
    
    sessionsNeeded.forEach(sessionNum => {
      const session = AppState.sessionCache.get(sessionNum);
      if (!session?.votes) return;
      session.votes.forEach(sv => {
        const politicianVote = sv.vl?.find(v => v.i == politicianId);
        if (politicianVote) {
          polVotes.push({
            ...sv,
            politicianVote: politicianVote.vt,
            party: politicianVote.p,
          });
        }
      });
    });
    
    Utils.updateLoadingProgress(95, 'Generuji statistiky...');
    
    renderAttendance(polVotes);
    renderVoteDistribution(polVotes);
    renderResults(polVotes);
    renderMonthlyAttendance(polVotes, votes, politicianId);
    renderVotingHistory(polVotes);
    
    Utils.updateLoadingProgress(100, 'Hotovo');
  }

  function renderAttendance(polVotes) {
    const total = polVotes.length;
    const present = polVotes.filter(v => ['A','N','Z'].includes(v.politicianVote)).length;
    const rate = total > 0 ? Math.round((present / total) * 100) : 0;

    const statEl = document.getElementById('statAttendance');
    if (statEl) {
      statEl.textContent = `${rate}%`;
      statEl.style.color = rate >= 80 ? 'var(--emerald-2)' : rate >= 60 ? 'var(--gold-2)' : '#f87171';
    }
    
    const detailEl = document.getElementById('statAttendanceDetail');
    if (detailEl) detailEl.textContent = `${present} přítomno z ${total} hlasování`;
    
    const fill = document.getElementById('attendanceFill');
    if (fill) {
      fill.style.width = `${rate}%`;
      fill.style.background = rate >= 80 ? 'var(--emerald-2)' : rate >= 60 ? 'var(--gold-2)' : '#f87171';
    }
  }

  function renderVoteDistribution(polVotes) {
    const counts = { A: 0, N: 0, Z: 0, '0': 0, M: 0 };
    polVotes.forEach(v => counts[v.politicianVote] = (counts[v.politicianVote] || 0) + 1);
    
    const total = polVotes.length;
    const colors = { A: 'var(--emerald-2)', N: '#f87171', Z: 'var(--gold-2)', '0': 'var(--platinum-2)', M: 'var(--text-muted)' };
    const labels = { A: 'Ano', N: 'Ne', Z: 'Zdržel se', '0': 'Nepřihlášen', M: 'Omluven' };

    const container = document.getElementById('voteDistributionChart');
    if (!container) return;
    
    container.innerHTML = '<div class="vote-bars">' + Object.entries(counts)
      .filter(([,c]) => c > 0)
      .map(([key, count]) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `
          <div class="vote-bar-row">
            <span class="vote-bar-label">${labels[key]}</span>
            <div class="vote-bar-track">
              <div class="vote-bar-fill" style="width:${pct}%;background:${colors[key]}"></div>
            </div>
            <span class="vote-bar-value">${count} (${pct}%)</span>
          </div>`;
      }).join('') + '</div>';
  }

  function renderResults(polVotes) {
    const accepted = polVotes.filter(v => v.r === 'accepted').length;
    const rejected = polVotes.filter(v => v.r === 'rejected').length;
    const total = polVotes.length;

    const badgesEl = document.getElementById('resultBadges');
    if (badgesEl) {
      badgesEl.innerHTML = `
        <div class="result-badge-item">
          <div class="rb-number vote-yes">${accepted}</div>
          <div class="rb-label">Přijato</div>
        </div>
        <div class="result-badge-item">
          <div class="rb-number vote-no">${rejected}</div>
          <div class="rb-label">Zamítnuto</div>
        </div>
      `;
    }

    const chartEl = document.getElementById('resultChart');
    if (chartEl) {
      if (total > 0) {
        const aPct = Math.round((accepted / total) * 100);
        const rPct = Math.round((rejected / total) * 100);
        chartEl.innerHTML = `
          <div class="comparison-bar" style="height:28px;border-radius:14px;display:flex;overflow:hidden">
            <div class="comparison-segment yes" style="flex-grow:${aPct};background:var(--emerald-2);display:flex;align-items:center;justify-content:center;color:white;font-size:0.75rem;font-weight:600">${aPct > 8 ? aPct+'%' : ''}</div>
            <div class="comparison-segment no" style="flex-grow:${rPct};background:#f87171;display:flex;align-items:center;justify-content:center;color:white;font-size:0.75rem;font-weight:600">${rPct > 8 ? rPct+'%' : ''}</div>
          </div>
        `;
      } else {
        chartEl.innerHTML = '';
      }
    }
  }

  function renderMonthlyAttendance(polVotes, allVotes, politicianId) {
    const polMonthly = {};
    polVotes.forEach(v => {
      const key = Utils.monthKey(v.d);
      if (!polMonthly[key]) polMonthly[key] = { present: 0, total: 0, month: key };
      polMonthly[key].total++;
      if (['A','N','Z'].includes(v.politicianVote)) polMonthly[key].present++;
    });

    const allPresent = allVotes.reduce((sum, v) => sum + (v.pr || 0), 0);
    const totalSlots = allVotes.length * 200;
    const overallRate = totalSlots > 0 ? Math.round((allPresent / totalSlots) * 100) : 80;

    const months = Object.values(polMonthly).sort((a, b) => {
      if (AppState.monthlySort === 'date') return a.month.localeCompare(b.month);
      if (AppState.monthlySort === 'attendance') {
        const rA = a.total > 0 ? a.present / a.total : 0;
        const rB = b.total > 0 ? b.present / b.total : 0;
        return rB - rA;
      }
      if (AppState.monthlySort === 'deviation') {
        const dA = a.total > 0 ? (a.present / a.total * 100) - overallRate : -overallRate;
        const dB = b.total > 0 ? (b.present / b.total * 100) - overallRate : -overallRate;
        return dB - dA;
      }
      return 0;
    });

    const tbody = document.getElementById('monthlyTableBody');
    if (tbody) {
      tbody.innerHTML = months.map(m => {
        const rate = m.total > 0 ? Math.round((m.present / m.total) * 100) : 0;
        const deviation = rate - overallRate;
        const devClass = deviation > 0 ? 'positive' : deviation < 0 ? 'negative' : 'neutral';
        const barColor = rate >= 80 ? 'var(--emerald-2)' : rate >= 60 ? 'var(--gold-2)' : '#f87171';

        return `
          <tr>
            <td>${Utils.formatMonth(m.month + '-01')}</td>
            <td>${m.present}</td>
            <td>${m.total}</td>
            <td style="font-weight:600;color:${barColor}">${rate}%</td>
            <td>${overallRate}%</td>
            <td class="${devClass}" style="font-weight:600">${deviation > 0 ? '+' : ''}${deviation}pp</td>
            <td>
              <div class="mini-bar-cell">
                <div class="mini-bar"><div class="mini-bar-fill" style="width:${rate}%;background:${barColor}"></div></div>
              </div>
            </td>
          </tr>`;
      }).join('');
    }

    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        AppState.monthlySort = btn.dataset.sort;
        renderMonthlyAttendance(polVotes, allVotes, politicianId);
      };
    });
  }

  function renderVotingHistory(polVotes) {
    const sorted = [...polVotes].sort((a, b) => b.d.localeCompare(a.d));
    const tbody = document.getElementById('votingHistoryBody');
    if (!tbody) return;
    
    tbody.innerHTML = sorted.slice(0, 100).map(v => {
      const vtClass = Utils.getVoteClass(v.politicianVote);
      return `
        <tr style="cursor:pointer" onclick="showVotePopup('${v.id}')">
          <td>${Utils.formatDate(v.d)}</td>
          <td>${v.s}</td>
          <td>${v.v}</td>
          <td>${v.r === 'accepted' ? '✅ Přijato' : '❌ Zamítnuto'}</td>
          <td><span class="timeline-badge ${vtClass}">${Utils.getVoteLabel(v.politicianVote)}</span></td>
        </tr>`;
    }).join('') + (sorted.length > 100 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:12px">...a dalších ${sorted.length - 100}</td></tr>` : '');
  }

  return { render };
})();

// ============================================================================
// MODULE 7: Vote Popup (Collapsible Details + Pagination)
// ============================================================================
const VotePopup = (() => {
  const overlay = document.getElementById('voteOverlay');
  const content = document.getElementById('popupContent');
  const detailsToggle = document.getElementById('popupDetailsToggle');
  const detailsSection = document.getElementById('popupDetailsSection');
  const popupPagination = document.getElementById('popupPagination');

  function show(voteId) {
    if (!overlay || !content) return;
    
    // Reset pagination
    AppState.popupPage = 1;
    
    // Show loading state with progress
    Utils.showLoading('Načítám detail hlasování...', 0);
    content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Načítám detail...</div>';
    overlay.classList.remove('hidden');
    
    DataLoader.loadVoteDetail(voteId, (progress, message) => {
      Utils.updateLoadingProgress(progress, message);
    }).then(vote => {
      Utils.hideLoading();
      
      if (!vote) {
        content.innerHTML = '<div style="padding:20px;text-align:center;color:#f87171">Nepodařilo se načíst detail hlasování.<br><button class="btn-retry" onclick="VotePopup.retryLast()">Zkusit znovu</button></div>';
        return;
      }
      
      // Store current vote for pagination
      AppState.currentPopupVote = vote;
      
      renderPopupContent(vote);
      renderPopupPagination(vote);
      
    }).catch(err => {
      Utils.hideLoading();
      console.error('Error loading vote detail:', err);
      content.innerHTML = `<div style="padding:20px;text-align:center;color:#f87171">Chyba: ${err.message}<br><button class="btn-retry" onclick="VotePopup.retryLast('${voteId}')">Zkusit znovu</button></div>`;
    });
  }
  
  // ⭐ NOVÉ: Retry function
  function retryLast(voteId = null) {
    if (voteId || AppState.currentPopupVote?.id) {
      show(voteId || AppState.currentPopupVote.id);
    }
  }

  function renderPopupContent(vote) {
    if (!content) return;
    
    const detailsOpen = AppState.showPopupDetails ? 'open' : '';
    const detailsIcon = AppState.showPopupDetails ? '▼' : '▶';
    
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px">
        <h3 style="margin:0">Schůze ${vote._sess || vote.s || '?'}, hlasování ${vote.v}</h3>
        <button id="popupClose" class="popup-close-btn" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted);line-height:1">&times;</button>
      </div>
      
      <div class="popup-meta">
        <div class="popup-meta-item"><span class="pml">Datum</span><span class="pmv">${Utils.formatDate(vote.d)} ${vote.t || ''}</span></div>
        <div class="popup-meta-item"><span class="pml">Výsledek</span><span class="pmv ${vote.r === 'accepted' ? 'vote-yes' : 'vote-no'}">${vote.r === 'accepted' ? '✅ Přijato' : '❌ Zamítnuto'}</span></div>
        <div class="popup-meta-item"><span class="pml">Přítomno</span><span class="pmv">${vote.pr || vote.tot ? Object.values(vote.tot || {}).reduce((a,b) => a+b, 0) : '?'}</span></div>
        <div class="popup-meta-item"><span class="pml">Je třeba</span><span class="pmv">${vote.req || '?'}</span></div>
      </div>
      
      ${renderPopupParties(vote)}
      
      <!-- ⭐ NOVÉ: Collapsible voters section -->
      <div class="popup-details-wrapper" style="margin-top:20px">
        <button id="popupDetailsToggle" class="details-toggle-btn" style="width:100%;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--surface-2);border:none;border-radius:8px;cursor:pointer;font-weight:600;color:var(--text-primary)">
          <span>Seznam politiků</span>
          <span class="toggle-icon">${detailsIcon}</span>
        </button>
        <div id="popupDetailsSection" class="details-content" style="${AppState.showPopupDetails ? '' : 'display:none'};margin-top:12px">
          ${renderPopupVoters(vote)}
        </div>
      </div>
    `;
    
    // Bind collapsible toggle
    const toggleBtn = document.getElementById('popupDetailsToggle');
    const detailsSec = document.getElementById('popupDetailsSection');
    const toggleIcon = toggleBtn?.querySelector('.toggle-icon');
    
    if (toggleBtn && detailsSec) {
      toggleBtn.onclick = () => {
        AppState.showPopupDetails = !AppState.showPopupDetails;
        detailsSec.style.display = AppState.showPopupDetails ? '' : 'none';
        if (toggleIcon) toggleIcon.textContent = AppState.showPopupDetails ? '▼' : '▶';
      };
    }
    
    // Re-bind close button
    const closeBtn = document.getElementById('popupClose');
    if (closeBtn) closeBtn.onclick = hide;
  }
  
  // ⭐ NOVÉ: Pagination for voters list
  function renderPopupPagination(vote) {
    if (!popupPagination || !vote.vl?.length) {
      if (popupPagination) popupPagination.innerHTML = '';
      return;
    }
    
    const totalVoters = vote.vl.length;
    const totalPages = Utils.calculateTotalPages(totalVoters, AppConfig.ITEMS_PER_PAGE);
    AppState.popupTotalPages = totalPages;
    
    if (totalPages <= 1) {
      popupPagination.innerHTML = '';
      return;
    }
    
    const pages = Utils.getPageRange(AppState.popupPage, totalPages);
    const hasPrev = AppState.popupPage > 1;
    const hasNext = AppState.popupPage < totalPages;
    
    popupPagination.innerHTML = `
      <div class="pagination-wrapper" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border-color)">
        <button class="pagination-btn ${!hasPrev ? 'disabled' : ''}" data-action="prev" ${!hasPrev ? 'disabled' : ''}>
          ← Předchozí
        </button>
        <div class="pagination-pages">
          ${pages.map(p => `
            <button class="pagination-page ${p === AppState.popupPage ? 'active' : ''}" data-page="${p}">${p}</button>
          `).join('')}
          ${pages[0] > 1 ? '<span class="pagination-ellipsis">...</span>' : ''}
          ${pages[pages.length - 1] < totalPages ? '<span class="pagination-ellipsis">...</span>' : ''}
        </div>
        <button class="pagination-btn ${!hasNext ? 'disabled' : ''}" data-action="next" ${!hasNext ? 'disabled' : ''}>
          Další →
        </button>
        <span style="margin-left:12px;font-size:0.85rem;color:var(--text-muted)">
          Strana ${AppState.popupPage}/${totalPages}
        </span>
      </div>
    `;
    
    // Bind pagination events
    popupPagination.querySelectorAll('[data-action="prev"]').forEach(btn => {
      btn.onclick = (e) => { 
        e.preventDefault(); 
        if (hasPrev) { 
          AppState.popupPage--; 
          renderPopupVotersSection(vote); 
        } 
      };
    });
    popupPagination.querySelectorAll('[data-action="next"]').forEach(btn => {
      btn.onclick = (e) => { 
        e.preventDefault(); 
        if (hasNext) { 
          AppState.popupPage++; 
          renderPopupVotersSection(vote); 
        } 
      };
    });
    popupPagination.querySelectorAll('[data-page]').forEach(btn => {
      btn.onclick = (e) => { 
        e.preventDefault(); 
        AppState.popupPage = parseInt(btn.dataset.page); 
        renderPopupVotersSection(vote); 
      };
    });
  }
  
  // ⭐ NOVÉ: Render only paginated voters
  function renderPopupVotersSection(vote) {
    const detailsSec = document.getElementById('popupDetailsSection');
    if (!detailsSec) return;
    
    // Keep the toggle button, replace only the content
    const toggleBtn = detailsSec.previousElementSibling;
    const paginatedVoters = Utils.paginateArray(vote.vl, AppState.popupPage, AppConfig.ITEMS_PER_PAGE);
    
    detailsSec.innerHTML = renderPopupVotersContent(vote, paginatedVoters);
    
    // Re-bind toggle after re-render
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        AppState.showPopupDetails = !AppState.showPopupDetails;
        detailsSec.style.display = AppState.showPopupDetails ? '' : 'none';
        const icon = toggleBtn.querySelector('.toggle-icon');
        if (icon) icon.textContent = AppState.showPopupDetails ? '▼' : '▶';
      };
    }
  }
  
  function renderPopupVotersContent(vote, votersToShow) {
    if (!vote.vl?.length) return '<p style="color:var(--text-muted);padding:12px">Žádná data o hlasování politiků.</p>';
    
    const byType = { A: [], N: [], Z: [], '0': [], M: [] };
    votersToShow.forEach(v => { if (byType[v.vt]) byType[v.vt].push(v); });
    const labels = { A: 'Ano', N: 'Ne', Z: 'Zdržel se', '0': 'Nepřihlášen', M: 'Omluven' };
    const colors = { A: 'var(--emerald-2)', N: '#f87171', Z: 'var(--gold-2)', '0': 'var(--platinum-2)', M: 'var(--text-muted)' };

    return `
      <div class="popup-voters">
        ${Object.entries(byType).filter(([,v]) => v.length > 0).map(([type, voters]) => `
          <details open="${type === 'A' || type === 'N'}" style="margin-bottom:8px">
            <summary style="cursor:pointer;font-weight:600;color:${colors[type]||'var(--text-muted)'};padding:8px 0;display:flex;justify-content:space-between;align-items:center">
              <span>${labels[type]}</span>
              <span style="background:var(--surface-2);padding:2px 10px;border-radius:12px;font-size:0.85rem">${voters.length}</span>
            </summary>
            <div class="popup-voter-list" style="padding:8px 0 8px 16px;max-height:200px;overflow-y:auto">
              ${voters.map(v => `
                <div class="popup-voter-item" style="padding:4px 0;font-size:0.9rem;display:flex;justify-content:space-between">
                  <span class="pvi-name" style="font-weight:500">${v.n}</span>
                  <span class="pvi-party" style="color:var(--text-muted);font-size:0.85rem">${v.p}</span>
                </div>
              `).join('')}
            </div>
          </details>
        `).join('')}
        ${vote.vl.length > AppConfig.ITEMS_PER_PAGE ? 
          `<p style="text-align:center;color:var(--text-muted);font-size:0.85rem;margin-top:8px">
            Zobrazuji ${votersToShow.length} z ${vote.vl.length} politiků (strana ${AppState.popupPage}/${AppState.popupTotalPages})
          </p>` : ''}
      </div>`;
  }

  function renderPopupParties(vote) {
    if (!vote.par?.length) return '';
    return `
      <div class="popup-parties" style="margin-top:20px">
        <h4 style="font-size:0.9rem;font-weight:600;color:var(--text-secondary);margin-bottom:12px">Rozdělení podle stran</h4>
        ${vote.par.map(p => {
          const c = p.c || {};
          const yes = c['A']||0, no = c['N']||0, abstain = c['Z']||0, total = yes+no+abstain;
          if (total === 0) return '';
          return `
            <div class="popup-party-row" style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
              <div class="popup-party-name" style="min-width:120px;font-weight:500">${p.n}</div>
              <div class="popup-party-bar" style="flex:1;height:20px;background:var(--surface-2);border-radius:10px;overflow:hidden;display:flex">
                ${yes > 0 ? `<div class="popup-party-segment" style="flex:${yes};background:var(--emerald-2);opacity:0.9" title="Ano: ${yes}"></div>` : ''}
                ${no > 0 ? `<div class="popup-party-segment" style="flex:${no};background:#f87171;opacity:0.9" title="Ne: ${no}"></div>` : ''}
                ${abstain > 0 ? `<div class="popup-party-segment" style="flex:${abstain};background:var(--gold-2);opacity:0.9" title="Zdržel: ${abstain}"></div>` : ''}
              </div>
              <div style="min-width:60px;text-align:right;font-size:0.85rem;color:var(--text-muted)">${total}</div>
            </div>`;
        }).join('')}
      </div>`;
  }

  function renderPopupVoters(vote) {
    // Use pagination-aware rendering
    const votersToShow = Utils.paginateArray(vote.vl, AppState.popupPage, AppConfig.ITEMS_PER_PAGE);
    return renderPopupVotersContent(vote, votersToShow);
  }

  function hide() {
    if (overlay) overlay.classList.add('hidden');
    Utils.hideLoading();
  }

  function init() {
    if (overlay) {
      overlay.onclick = (e) => { if (e.target === overlay) hide(); };
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.showVotePopup = show;
    window.VotePopup = { retryLast }; // Expose retry for HTML onclick
  }

  return { show, hide, init, retryLast };
})();

// ============================================================================
// MODULE 8: Main App Controller
// ============================================================================
const App = (() => {
  const termSelect = document.getElementById('termFilter');
  const loadingEl = document.getElementById('loadingIndicator');
  const errorEl = document.getElementById('errorState');
  const errorMsg = document.getElementById('errorMessage');

  async function init() {
    try {
      // ⭐ NOVÉ: Show global loading with progress
      Utils.showLoading('Inicializuji aplikaci...', 0);
      
      // Load index and registry with progress
      await Promise.all([
        DataLoader.loadIndex((p, m) => Utils.updateLoadingProgress(p * 0.4, m)),
        DataLoader.loadRegistry((p, m) => Utils.updateLoadingProgress(40 + p * 0.3, m))
      ]);
      
      Utils.updateLoadingProgress(80, 'Připravuji data...');
      
      const availableTerms = new Set();
      if (AppState.index?.entries) {
        AppState.index.entries.forEach(v => {
          const term = Utils.getTermForDate(v.d);
          if (term) availableTerms.add(term);
        });
      }

      if (termSelect) {
        termSelect.innerHTML = '<option value="">— Vyberte období —</option>';
        [...availableTerms].sort().reverse().forEach(term => {
          const opt = document.createElement('option');
          opt.value = term;
          opt.textContent = `Volební období ${term}`;
          termSelect.appendChild(opt);
        });

        if (availableTerms.size > 0) {
          const latest = [...availableTerms].sort().pop();
          termSelect.value = latest;
          AppState.currentTerm = latest;
        }
      }

      Utils.updateLoadingProgress(95, 'Spouštím aplikaci...');
      
      PoliticianSearch.init();
      VotePopup.init();
      render();
      
      Utils.updateLoadingProgress(100, 'Hotovo');
      setTimeout(() => Utils.hideLoading(), 300); // Small delay for smooth UX

    } catch (e) {
      console.error('Init failed:', e);
      Utils.hideLoading();
      if (errorEl) errorEl.classList.remove('hidden');
      if (errorMsg) errorMsg.textContent = e.message;
      
      // ⭐ NOVÉ: Show retry option on init error
      if (errorEl) {
        errorEl.innerHTML += `<br><button class="btn-retry" onclick="App.retryInit()">Zkusit znovu</button>`;
      }
    }
  }
  
  // ⭐ NOVÉ: Retry init function
  async function retryInit() {
    DataLoader.clearCache();
    await init();
  }

  function render() {
    TimelineRenderer.destroy?.();
    
    if (!AppState.currentTerm) {
      TimelineRenderer.render([], null);
      StatsRenderer.render([], null);
      return;
    }

    const votes = Utils.getVotesForTerm(AppState.currentTerm);
    AppState.filteredVotes = votes;

    TimelineRenderer.render(votes, AppState.currentPoliticianId, AppState.timelinePage);
    StatsRenderer.render(votes, AppState.currentPoliticianId);
  }

  function initEventListeners() {
    if (termSelect) {
      termSelect.addEventListener('change', Utils.debounce(() => {
        AppState.currentTerm = termSelect.value || null;
        AppState.timelinePage = 1; // Reset pagination on term change
        render();
      }, 250));
    }

    const resetBtn = document.getElementById('resetAllBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (termSelect) termSelect.value = '';
        AppState.currentTerm = null;
        AppState.currentPoliticianId = null;
        AppState.currentPolitician = null;
        AppState.timelinePage = 1;
        const input = document.getElementById('politicianInput');
        const clearBtn = document.getElementById('clearPoliticianBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.style.display = 'none';
        PoliticianSearch.clearSelection?.();
        render();
      });
    }
  }

  return { init, render, initEventListeners, retryInit };
})();

// ============================================================================
// BOOT
// ============================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    App.init();
    App.initEventListeners();
  });
} else {
  App.init();
  App.initEventListeners();
}