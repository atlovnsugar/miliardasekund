/**
 * Voting Visualization App v2.0
 * Modular, extensible, optimized for performance
 * 
 * Architecture:
 * - Config/State separation
 * - Service layer for data operations
 * - Component-based rendering
 * - Event-driven communication
 */

// ============================================================================
// CONFIGURATION
// ============================================================================
const Config = {
  DATA_BASE: './data',
  CACHE_DURATION: 3600000, // 1 hour
  MAX_CACHED_SESSIONS: 200,
  BATCH_SIZE: 6,
  LAZY_LOAD_MARGIN: '250px',
  ITEMS_PER_PAGE: 20,
  MAX_PAGES_VISIBLE: 5,
  RETRY: {
    MAX_ATTEMPTS: 3,
    BASE_DELAY: 400,
    BACKOFF: 2
  },
  TERM_RANGES: {
    '2025-2029': { from: '2025-10-01', to: '2029-09-30' },
    '2021-2025': { from: '2021-10-01', to: '2025-12-31' },
    '2017-2021': { from: '2017-10-01', to: '2021-09-30' },
    '2013-2017': { from: '2013-10-01', to: '2017-09-30' },
    '2010-2013': { from: '2010-06-01', to: '2013-09-30' },
    '2006-2010': { from: '2006-06-01', to: '2010-05-31' },
    '2002-2006': { from: '2002-06-01', to: '2006-05-31' },
    '1998-2002': { from: '1998-06-01', to: '2002-05-31' },
    '1996-1998': { from: '1996-06-01', to: '1998-05-31' },
  }
};

// ============================================================================
// APPLICATION STATE
// ============================================================================
const State = {
  // Data
  index: null,
  registry: null,
  sessionsIndex: null,
  
  // Cache
  sessionCache: new Map(),
  sessionAccessOrder: [],
  memoryCache: new Map(),
  
  // Filters
  currentTerm: null,
  currentPoliticianId: null,
  
  // Pagination
  timeline: { page: 1, totalPages: 1 },
  popup: { page: 1, totalPages: 1 },
  
  // UI
  isLoading: false,
  showPopupDetails: true,
  
  // Network
  activeRequests: new Map()
};

// ============================================================================
// UTILITIES
// ============================================================================
const Utils = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  
  debounce: (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },
  
  formatDate: (dateStr) => new Date(dateStr).toLocaleDateString('cs-CZ', { day:'numeric', month:'long', year:'numeric' }),
  formatMonth: (dateStr) => new Date(dateStr).toLocaleDateString('cs-CZ', { month:'long', year:'numeric' }),
  monthKey: (dateStr) => dateStr.substring(0,7),
  
  getVoteLabel: (vt) => ({A:'Ano',N:'Ne',Z:'Zdržel se','0':'Nepřihlášen',M:'Omluven'})[vt] || '?',
  getVoteClass: (vt) => ({A:'vote-yes',N:'vote-no',Z:'vote-abstain','0':'vote-absent',M:'vote-absent'})[vt] || '',
  
  getTermForDate: (dateStr) => {
    const d = new Date(dateStr);
    for (const [term, range] of Object.entries(Config.TERM_RANGES)) {
      if (d >= new Date(range.from) && d <= new Date(range.to)) return term;
    }
    return null;
  },
  
  filterByTerm: (entries, term) => {
    if (!term) return entries;
    const range = Config.TERM_RANGES[term];
    if (!range) return entries;
    return entries.filter(v => v.term === term || (v.d >= range.from && v.d <= range.to));
  },
  
  paginate: (arr, page, perPage) => {
    const start = (page - 1) * perPage;
    return arr.slice(start, start + perPage);
  },
  
  calcPages: (total, perPage) => Math.max(1, Math.ceil(total / perPage)),
  
  getPageRange: (curr, total, maxVis = Config.MAX_PAGES_VISIBLE) => {
    const half = Math.floor(maxVis / 2);
    let start = Math.max(1, curr - half);
    let end = Math.min(total, start + maxVis - 1);
    if (end - start + 1 < maxVis) start = Math.max(1, end - maxVis + 1);
    const pages = [];
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  },
  
  // Loading UI
  showLoader: (msg = 'Načítám...', progress = 0) => {
    State.isLoading = true;
    const el = document.getElementById('globalLoader');
    const msgEl = document.getElementById('loaderMessage');
    const barEl = document.getElementById('loaderProgress');
    if (el) el.classList.remove('hidden');
    if (msgEl) msgEl.textContent = msg;
    if (barEl) {
      barEl.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      barEl.classList.toggle('indeterminate', progress < 0);
    }
  },
  
  updateLoader: (progress, msg) => {
    const msgEl = document.getElementById('loaderMessage');
    const barEl = document.getElementById('loaderProgress');
    if (msgEl && msg) msgEl.textContent = msg;
    if (barEl) {
      barEl.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      barEl.classList.toggle('indeterminate', progress < 0);
    }
  },
  
  hideLoader: () => {
    State.isLoading = false;
    const el = document.getElementById('globalLoader');
    if (el) el.classList.add('hidden');
  },
  findVoterInList: (voterList, targetId) => {
    if (!voterList || !targetId) return null;
    const tid = String(targetId);
    return voterList.find(v => {
      // Zkontroluje všechny běžné varianty ID klíčů v datech PSP
      const vid = String(v.i ?? v.id ?? v.id_poslanec ?? v.poslanec_id ?? v.p_id);
      return vid === tid;
    });
  }
};

// ============================================================================
// DATA SERVICE (Fetch, Cache, Retry)
// ============================================================================
const DataService = (() => {
  // NOVÉ: Mapování pro probíhající požadavky (brání duplicitnímu stahování)
 // Přidejte tuto proměnnou k ostatním v DataService (mimo fetchWithRetry)
  const pendingRequests = new Map();

  const fetchWithRetry = async (url, onProgress = null, attempt = 1) => {
    // 1. Kontrola paměťové cache
    const cached = State.memoryCache.get(url);
    if (cached && Date.now() - cached.ts < Config.CACHE_DURATION) {
      onProgress?.(100, 'Z cache');
      return cached.data;
    }
    
    // 2. REQUEST DEDUPLICATION (Sloučení stejných požadavků)
    if (pendingRequests.has(url)) {
      return pendingRequests.get(url);
    }

    const fetchPromise = (async () => {
      const controller = new AbortController();
      State.activeRequests.set(url, controller);
      
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        let data = url.endsWith('.gz') 
          ? JSON.parse(pako.inflate(new Uint8Array(await res.arrayBuffer()), {to:'string'}))
          : await res.json();
        
        State.memoryCache.set(url, { data, ts: Date.now() });
        return data;
      } catch (err) {
        if (err.name === 'AbortError') return null;
        if (attempt < Config.RETRY.MAX_ATTEMPTS) {
          const delay = Config.RETRY.BASE_DELAY * Math.pow(Config.RETRY.BACKOFF, attempt - 1);
          await Utils.sleep(delay);
          return fetchWithRetry(url, onProgress, attempt + 1);
        }
        throw err;
      } finally {
        State.activeRequests.delete(url);
        pendingRequests.delete(url); // Po dokončení uvolnit
      }
    })();

    pendingRequests.set(url, fetchPromise);
    return fetchPromise;
  };

  const updateLRU = (key) => {
    const idx = State.sessionAccessOrder.indexOf(key);
    if (idx > -1) State.sessionAccessOrder.splice(idx, 1);
    State.sessionAccessOrder.push(key);
  };

  const evictLRU = () => {
    if (State.sessionAccessOrder.length === 0) return;
    const oldest = State.sessionAccessOrder.shift();
    State.sessionCache.delete(oldest);
  };

  return {
    async loadIndex(onProgress) {
      onProgress?.(0, 'Načítám index...');
      const data = await fetchWithRetry(`${Config.DATA_BASE}/index.json`, onProgress);
      State.index = data;
      return data;
    },
    
    async loadSessionsIndex(onProgress) {
      onProgress?.(0, 'Načítám index session...');
      const data = await fetchWithRetry(`${Config.DATA_BASE}/sessions_index.json`, onProgress);
      State.sessionsIndex = data;
      return data;
    },
    
    async loadRegistry(onProgress) {
      onProgress?.(0, 'Načítám registry...');
      const data = await fetchWithRetry(`${Config.DATA_BASE}/politicians/registry.json`, onProgress);
      State.registry = data?.pol || data;
      return State.registry;
    },
    
    async loadSession(sessionId, onProgress) {
      const sid = String(sessionId);
      if (State.sessionCache.has(sid)) {
        updateLRU(sid);
        return State.sessionCache.get(sid);
      }
      
      const url = `${Config.DATA_BASE}/sessions/session_${sid}.json`;
      const data = await fetchWithRetry(url, onProgress);
      if (!data) return null;
      
      while (State.sessionCache.size >= Config.MAX_CACHED_SESSIONS) evictLRU();
      
      State.sessionCache.set(sid, data);
      updateLRU(sid);
      return data;
    },
    
    async loadSessionsBatched(ids, onProgress) {
      const unique = [...new Set(ids.filter(Boolean))];
      const total = unique.length;
      
      for (let i = 0; i < unique.length; i += Config.BATCH_SIZE) {
        const batch = unique.slice(i, i + Config.BATCH_SIZE);
        await Promise.all(batch.map((id, idx) => 
          this.loadSession(id, (p,m) => onProgress?.(Math.round((i+idx)/total*100), m))
        ));
        await Utils.sleep(0);
      }
    },
    
    getSessionsForTerm(term) {
      if (!State.sessionsIndex?.[term]) return [];
      return State.sessionsIndex[term];
    },
    
    getVoteDetail(voteId) {
      const entry = State.index?.entries?.find(e => e.id === voteId);
      if (!entry) return null;
      const session = State.sessionCache.get(String(entry.s));
      return session?.votes?.find(v => v.id === voteId || v.v === entry.v);
    },
    
    clearCache() {
      State.sessionCache.clear();
      State.sessionAccessOrder = [];
      State.memoryCache.clear();
      pendingRequests.clear(); // Vyčistit i čekající
      for (const ctrl of State.activeRequests.values()) ctrl.abort();
      State.activeRequests.clear();
    }
  };
})();

// ============================================================================
// FILTER SERVICE
// ============================================================================
const FilterService = {
  getVotesForTerm(term) {
    if (!State.index?.entries) return [];
    return Utils.filterByTerm(State.index.entries, term);
  },
  
  getPoliticianVotes(votes, politicianId) {
    if (!politicianId) return [];
    // Note: This requires loading session data - handled by component
    return votes; // Return base list, component enriches
  }
};

// ============================================================================
// COMPONENT: Timeline
// ============================================================================
const TimelineComponent = (() => {
  const container = document.getElementById('timelineTrack');
  const countEl = document.getElementById('voteCount');
  const emptyEl = document.getElementById('timelineEmpty');
  const paginationEl = document.getElementById('timelinePagination');
  
  let observer;
  
  const initObserver = (onItemVisible) => {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      entries.forEach(async (entry) => {
        if (entry.isIntersecting) {
          const item = entry.target;
          if (item._vote && !item._loaded && !item._loading) {
            item._loading = true;
            
            try {
              const session = await DataService.loadSession(item._vote.s);
              const voteDetail = session?.votes?.find(v => v.id === item._vote.id || v.v === item._vote.v);
              const polVote = Utils.findVoterInList(voteDetail?.vl, item._politicianId);
              
              // Získání dat pro aktualizaci
              const vt = polVote?.vt;
              const dotClass = Utils.getVoteClass(vt);
              const label = Utils.getVoteLabel(vt);
              
              // CÍLENÁ AKTUALIZACE DOMU (žádné outerHTML)
              const dot = item.querySelector('.timeline-dot');
              const badge = item.querySelector('.timeline-badge');
              
              if (dot) {
                dot.className = `timeline-dot ${dotClass}`;
              }
              if (badge) {
                badge.className = `timeline-badge ${dotClass}`;
                badge.textContent = label;
              }
              
              item.classList.remove('loading');
              item._loaded = true;
            } catch (e) {
              console.error("Chyba načítání:", e);
            }
          }
          observer.unobserve(item);
        }
      });
    }, { rootMargin: Config.LAZY_LOAD_MARGIN });
  };
  
const createItem = (vote, politicianId, loaded = false, voteType = null) => {
    const item = document.createElement('div');
    item.className = `timeline-item${loaded ? '' : ' loading'}`;
    item._vote = vote;
    item._politicianId = politicianId;
    item._loaded = loaded;
    item._loading = false;
    
    // Logika pro určení třídy a textu:
    // Pokud máme voteType (hlas politika), použijeme ho. 
    // Pokud ne, ale jsme "loaded", použijeme celkový výsledek hlasování (vote.r).
    const dotClass = voteType 
        ? Utils.getVoteClass(voteType) 
        : (vote.r === 'accepted' ? 'vote-yes' : 'vote-no');
        
    const badgeText = voteType 
        ? Utils.getVoteLabel(voteType) 
        : (vote.r === 'accepted' ? 'Přijato' : 'Zamítnuto');
        
    const badgeClass = voteType 
        ? Utils.getVoteClass(voteType) 
        : (vote.r === 'accepted' ? 'vote-yes' : 'vote-no');
    
    item.innerHTML = `
      <div class="timeline-dot ${loaded ? dotClass : 'loading'}"></div>
      <div class="timeline-item-content">
        <div class="timeline-item-left">
          <span class="timeline-date">${Utils.formatDate(vote.d)}</span>
          <span class="timeline-session">Schůze ${vote.s}, hlasování ${vote.v}</span>
        </div>
        <div class="timeline-item-right">
          <span class="timeline-badge ${loaded ? badgeClass : 'loading'}">
            ${loaded ? badgeText : 'Načítám...'}
          </span>
        </div>
      </div>
    `;
    
    item.onclick = () => window.showVotePopup?.(vote.id);
    return item;
};
  
  const renderPagination = (currentPage, totalPages, onPageChange) => {
    if (!paginationEl) return;
    if (totalPages <= 1) { paginationEl.innerHTML = ''; return; }
    
    const pages = Utils.getPageRange(currentPage, totalPages);
    paginationEl.innerHTML = `
      <div class="pagination-wrapper">
        <button class="pagination-btn ${currentPage===1?'disabled':''}" data-action="prev" ${currentPage===1?'disabled':''}>←</button>
        ${pages.map(p => `<button class="pagination-page ${p===currentPage?'active':''}" data-page="${p}">${p}</button>`).join('')}
        ${pages[0]>1?'<span class="pagination-ellipsis">...</span>':''}
        ${pages[pages.length-1]<totalPages?'<span class="pagination-ellipsis">...</span>':''}
        <button class="pagination-btn ${currentPage===totalPages?'disabled':''}" data-action="next" ${currentPage===totalPages?'disabled':''}>→</button>
      </div>
    `;
    
    paginationEl.querySelector('[data-action="prev"]')?.addEventListener('click', (e) => {
      e.preventDefault(); if (currentPage > 1) onPageChange(currentPage - 1);
    });
    paginationEl.querySelector('[data-action="next"]')?.addEventListener('click', (e) => {
      e.preventDefault(); if (currentPage < totalPages) onPageChange(currentPage + 1);
    });
    paginationEl.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); onPageChange(parseInt(btn.dataset.page));
      });
    });
  };
  
  const render = async (votes, politicianId, page = 1) => {
    if (!container) return;
    initObserver();
    
    if (!votes?.length) {
      container.innerHTML = '';
      emptyEl?.classList.remove('hidden');
      countEl && (countEl.textContent = '0 hlasování');
      paginationEl && (paginationEl.innerHTML = '');
      return;
    }
    
    emptyEl?.classList.add('hidden');
    
    // Filter and paginate
    const filtered = Utils.filterByTerm(votes, State.currentTerm);
    const totalPages = Utils.calcPages(filtered.length, Config.ITEMS_PER_PAGE);
    State.timeline = { page: Math.min(page, totalPages), totalPages };
    
    const pageVotes = Utils.paginate(filtered, State.timeline.page, Config.ITEMS_PER_PAGE);
    
    countEl && (countEl.textContent = `${filtered.length} hlasování (str. ${State.timeline.page}/${totalPages})`);
    
// ... (předchozí kód v renderu)

    // Render items
    container.innerHTML = '';
    pageVotes.slice().reverse().forEach(vote => {
      // OPRAVA: Pokud není vybrán politik, považujeme položku za načtenou (máme data z indexu)
      const isLoaded = !politicianId; 
      
      const item = createItem(vote, politicianId, isLoaded);
      container.appendChild(item);
      
      // Pozorujeme pouze ty položky, které ještě potřebují dotáhnout data (detaily politika)
      if (!isLoaded) {
        observer.observe(item);
      }
    });
    
    renderPagination(State.timeline.page, totalPages, (newPage) => render(votes, politicianId, newPage));
  };
  
  return { render, destroy: () => observer?.disconnect() };
})();

// ============================================================================
// COMPONENT: Stats
// ============================================================================
// ============================================================================
// COMPONENT: Stats
// ============================================================================
const StatsComponent = (() => {
  const panel = document.getElementById('statsPanel');

  const render = async (votes, politicianId) => {
    if (!panel) return;
    if (!politicianId) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    const pol = State.registry?.[politicianId];
    document.getElementById('statsPoliticianName').textContent = pol?.n || 'Neznámý';
    document.getElementById('statsPoliticianParty').textContent = pol?.p || '';

    Utils.updateLoader(10, 'Analyzuji hlasy pro statistiky...');

    // 🔧 FIX 1: Získání všech schůzí a dočasné navýšení cache limitu, 
    // aby se během výpočtu žádné schůze neeviktovaly
    const sessionsNeeded = [...new Set(votes.map(v => v.s).filter(Boolean))];
    const originalLimit = Config.MAX_CACHED_SESSIONS;
    Config.MAX_CACHED_SESSIONS = Math.max(originalLimit, sessionsNeeded.length);

    await DataService.loadSessionsBatched(sessionsNeeded, (progress, msg) =>
      Utils.updateLoader(10 + progress * 0.8, msg)
    );
    Config.MAX_CACHED_SESSIONS = originalLimit; // Obnovíme původní limit

    let presentCount = 0, totalCount = votes.length, matchCount = 0;
    let yesCount = 0, noCount = 0, abstainCount = 0, absentCount = 0;

for (const voteSummary of votes) {
  const sessionId = String(voteSummary.s); // 🔑 Normalizace na String
  const voteId = voteSummary.id;
  const voteNum = voteSummary.v;

  const session = State.sessionCache.get(sessionId);
  // 🔑 Robustnější hledání konkrétního hlasování
  const detailedVote = session?.votes?.find(v => v.id === voteId || v.v === voteNum);

  if (!detailedVote) { 
    // Pokud hlasování v datech schůze chybí, je to technická chyba, ne nutně absence
    continue; 
  }

  const polVoteEntry = Utils.findVoterInList(detailedVote.vl, politicianId);

  if (polVoteEntry) {
    const voteType = polVoteEntry.vt;
    const voteResult = detailedVote.r;

    // A=Ano, N=Ne, Z=Zdržel se
    if (['A', 'N', 'Z'].includes(voteType)) {
      presentCount++;
      if (voteType === 'A') yesCount++;
      if (voteType === 'N') noCount++;
      if (voteType === 'Z') abstainCount++;

      if ((voteType === 'A' && voteResult === 'accepted') ||
          (voteType === 'N' && voteResult === 'rejected')) {
        matchCount++;
      }
    } else {
      absentCount++; // '0' = Nepřihlášen, 'M' = Omluven
    }
  } else {
    // Poslanec v seznamu hlasujících vůbec není
    absentCount++;
  }
}

    Utils.updateLoader(95, 'Generuji statistiky...');

    const attendanceRate = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
    const matchRate = presentCount > 0 ? Math.round((matchCount / presentCount) * 100) : 0;

    // UI Updates
    const attendanceEl = document.getElementById('statAttendance');
    if (attendanceEl) {
      attendanceEl.textContent = `${attendanceRate}%`;
      attendanceEl.style.color = attendanceRate >= 80 ? 'var(--success)' : attendanceRate >= 60 ? 'var(--warning)' : 'var(--danger)';
    }
    const attendanceDetailEl = document.getElementById('statAttendanceDetail');
    if (attendanceDetailEl) attendanceDetailEl.textContent = `${presentCount} přítomno z ${totalCount} (absence: ${absentCount})`;
    const attendanceFillEl = document.getElementById('attendanceFill');
    if (attendanceFillEl) {
      attendanceFillEl.style.width = `${attendanceRate}%`;
      attendanceFillEl.style.background = attendanceEl.style.color;
    }

    renderDistribution(presentCount, yesCount, noCount, abstainCount);
    renderMatchRate(matchRate, presentCount);
    await renderHistory(votes, politicianId); // 🔧 FIX 3: await pro async historii
  };

  const renderDistribution = (totalPresent, yes, no, abstain) => {
    const chart = document.getElementById('voteDistributionChart');
    if (!chart) return;
    if (totalPresent > 0) {
      const yesPct = Math.round((yes / totalPresent) * 100);
      const noPct = Math.round((no / totalPresent) * 100);
      const abstainPct = Math.round((abstain / totalPresent) * 100);
      chart.innerHTML = `
        <div class="comparison-segment yes" style="flex:${yes}; background:var(--success);" title="Ano: ${yes} (${yesPct}%)">${yesPct > 10 ? yesPct + '%' : ''}</div>
        <div class="comparison-segment no" style="flex:${no}; background:var(--danger);" title="Ne: ${no} (${noPct}%)">${noPct > 10 ? noPct + '%' : ''}</div>
        <div class="comparison-segment abstain" style="flex:${abstain}; background:var(--warning);" title="Zdržel se: ${abstain} (${abstainPct}%)">${abstainPct > 10 ? abstainPct + '%' : ''}</div>
      `;
    } else {
      chart.innerHTML = '<div class="comparison-segment empty" style="flex:1; background:var(--surface-2);">Žádné přítomné hlasy</div>';
    }
  };

  const renderMatchRate = (matchPercentage, totalPresentVotes) => {
    const matchEl = document.getElementById('statMatchRate');
    if (!matchEl) return;
    matchEl.textContent = `${matchPercentage}%`;
    matchEl.style.color = matchPercentage >= 90 ? 'var(--success)' : matchPercentage >= 75 ? 'var(--warning)' : 'var(--danger)';
    const matchDetailEl = document.getElementById('statMatchRateDetail');
    if (matchDetailEl) matchDetailEl.textContent = `Shoda v ${Math.round((matchPercentage/100)*totalPresentVotes)} z ${totalPresentVotes} přítomných hlasování`;
  };

  const renderHistory = async (votes, politicianId) => { // 🔧 FIX 3: Async funkce
    const tbody = document.getElementById('votingHistoryBody');
    if (!tbody) return;
    const historyEntries = [];

    const sessionsNeeded = new Set(votes.map(v => v.s).filter(Boolean));
    for (const sid of sessionsNeeded) {
      // 🔧 FIX 4: Načtení on-demand. Pokud je schůze v cache, vrátí okamžitě. 
      // Pokud byla eviktována, stáhne ji znovu. Eliminuje falešné absence.
      const session = await DataService.loadSession(sid); 
      if (!session?.votes) continue;

    session.votes.forEach(sv => {
    const pv = Utils.findVoterInList(sv.vl, politicianId); // Použití sjednocené funkce
    historyEntries.push({
        ...sv,
        polVote: pv ? pv.vt : null,
        polParty: pv ? pv.p : null
    });
    });
    }

    const sorted = [...historyEntries].sort((a, b) => b.d.localeCompare(a.d));
    tbody.innerHTML = sorted.slice(0, 50).map(v => {
      let voteClass = 'vote-absent';
      let voteText = 'Absent';
      if (v.polVote === 'A') { voteClass = 'vote-yes'; voteText = 'Ano'; }
      if (v.polVote === 'N') { voteClass = 'vote-no'; voteText = 'Ne'; }
      if (v.polVote === 'Z') { voteClass = 'vote-abstain'; voteText = 'Zdržel se'; }

      let matchIndicator = '';
      if (v.polVote && ['A', 'N'].includes(v.polVote)) {
        const isMatch = (v.polVote === 'A' && v.r === 'accepted') || (v.polVote === 'N' && v.r === 'rejected');
        matchIndicator = isMatch ? ' ✅' : ' ❌';
      }

      return `<tr>
        <td>${Utils.formatDate(v.d)}</td>
        <td>${v.s}.${v.v}</td>
        <td class="${v.r === 'accepted' ? 'vote-yes' : 'vote-no'}">${v.r === 'accepted' ? '✅ Přijato' : '❌ Zamítnuto'}</td>
        <td class="${voteClass}">${voteText}${matchIndicator}</td>
      </tr>`;
    }).join('');
  };

  return { render };
})();

// ============================================================================
// COMPONENT: Vote Popup
// ============================================================================
const PopupComponent = (() => {
  const overlay = document.getElementById('voteOverlay');
  const content = document.getElementById('popupContent');
  const paginationEl = document.getElementById('popupPagination');
  
  const renderPagination = (currentPage, totalPages, voters, onPageChange) => {
    if (!paginationEl || totalPages <= 1) { if(paginationEl) paginationEl.innerHTML=''; return; }
    
    const pages = Utils.getPageRange(currentPage, totalPages);
    paginationEl.innerHTML = `
      <div class="pagination-wrapper">
        <button class="pagination-btn ${currentPage===1?'disabled':''}" data-action="prev">←</button>
        ${pages.map(p=>`<button class="pagination-page ${p===currentPage?'active':''}" data-page="${p}">${p}</button>`).join('')}
        ${pages[0]>1?'<span class="pagination-ellipsis">...</span>':''}
        ${pages[pages.length-1]<totalPages?'<span class="pagination-ellipsis">...</span>':''}
        <button class="pagination-btn ${currentPage===totalPages?'disabled':''}" data-action="next">→</button>
        <span style="margin-left:8px;font-size:0.85rem;color:var(--text-muted)">${currentPage}/${totalPages}</span>
      </div>
    `;
    
    paginationEl.querySelector('[data-action="prev"]')?.addEventListener('click',e=>{e.preventDefault();if(currentPage>1)onPageChange(currentPage-1,voters)});
    paginationEl.querySelector('[data-action="next"]')?.addEventListener('click',e=>{e.preventDefault();if(currentPage<totalPages)onPageChange(currentPage+1,voters)});
    paginationEl.querySelectorAll('[data-page]').forEach(btn=>{
      btn.addEventListener('click',e=>{e.preventDefault();onPageChange(parseInt(btn.dataset.page),voters)});
    });
  };
  
// Uvnitř objektu PopupComponent
const renderVoters = (vote, page = 1) => {
  if (!vote?.vl?.length) return '<p>Žádná data.</p>';

  // Seskupení hlasujících podle typu hlasu
  const votersByType = {};
  vote.vl.forEach(voter => {
    const voteType = voter.vt; // Např. 'A', 'N', 'Z', '0', 'M'
    if (!votersByType[voteType]) {
      votersByType[voteType] = [];
    }
    votersByType[voteType].push(voter);
  });

  const labels = { A: 'Ano', N: 'Ne', Z: 'Zdržel se', '0': 'Nepřihlášen', M: 'Omluven' };
  const colors = { A: 'var(--vote-yes)', N: 'var(--vote-no)', Z: 'var(--vote-abstain)', '0': 'var(--vote-absent)', M: 'var(--vote-absent)' };

  // Generování HTML pro každou kategorii jako rozbalovací detail
  const detailsHtml = Object.entries(votersByType)
    .map(([type, voters]) => {
      const label = labels[type] || 'Neznámý';
      const color = colors[type];
      // Seřazení poslanců v kategorii podle jména pro lepší přehlednost
      const sortedVoters = voters.sort((a, b) => a.n.localeCompare(b.n, 'cs')); // Použití českého řazení

      return `
        <details>
          <summary style="cursor: pointer; padding: 8px; border-radius: var(--radius); background: var(--surface-1); margin-bottom: 4px;">
            <span style="color: ${color}; font-weight: 500;">${label}</span>
            <span style="background: var(--surface-2); padding: 2px 8px; border-radius: 12px; font-size: 0.85rem; margin-left: 8px;">
              ${sortedVoters.length}
            </span>
          </summary>
          <div class="popup-voter-list">
            ${sortedVoters.map(v => `<div class="popup-voter-item"><span class="pvi-name">${v.n}</span> <span class="pvi-party">${v.p}</span></div>`).join('')}
          </div>
        </details>
      `;
    })
    .join('');

  // Stránkování je nyní zbytečné, protože rozbalení kategorií může obsahovat libovolné množství poslanců.
  // Ponecháme zde informaci o celkovém počtu hlasujících, pokud je to žádoucí.
  const totalVoters = vote.vl.length;

  return `
    <div class="popup-voters">
      ${detailsHtml}
      <p style="text-align: center; color: var(--text-muted); font-size: 0.8rem; margin-top: 8px;">Celkem hlasujících: ${totalVoters}</p>
    </div>
  `;
};
  
// Uvnitř funkce renderContent uvnitř PopupComponent
const renderContent = (vote) => {
  if (!content) return;

  const parties = vote.par?.length ? `
    <div class="popup-parties">
      <h4>Rozdělení podle stran</h4>
      ${vote.par.map(p => {
        const c = p.c || {}, yes = c.A || 0, no = c.N || 0, abs = c.Z || 0, tot = yes + no + abs;
        if (!tot) return '';
        return `<div class="popup-party-row">
          <div class="popup-party-name">${p.n}</div>
          <div class="popup-party-bar">
            ${yes > 0 ? `<div class="popup-party-segment" style="flex:${yes};background:var(--success);opacity:0.9" title="Ano: ${yes}"></div>` : ''}
            ${no > 0 ? `<div class="popup-party-segment" style="flex:${no};background:var(--danger);opacity:0.9" title="Ne: ${no}"></div>` : ''}
            ${abs > 0 ? `<div class="popup-party-segment" style="flex:${abs};background:var(--warning);opacity:0.9" title="Zdržel: ${abs}"></div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  // Nyní získáme obsah seznamu poslanců bez stránkování
  const votersSectionHtml = renderVoters(vote); // Voláme upravenou funkci, nepředáváme stránku

  const detailsOpen = State.showPopupDetails ? '' : 'style="display:none"';
  const icon = State.showPopupDetails ? '▼' : '▶';

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px">
      <h3 style="margin:0">Schůze ${vote.s||'?'}, hlasování ${vote.v}</h3>
    </div>
    <div class="popup-meta">
      <div class="popup-meta-item"> <span class="pml">Datum</span> <span class="pmv">${Utils.formatDate(vote.d)}</span> </div>
      <div class="popup-meta-item"> <span class="pml">Výsledek</span> <span class="pmv ${vote.r==='accepted'?'vote-yes':'vote-no'}">${vote.r==='accepted'?'✅ Přijato':'❌ Zamítnuto'}</span> </div>
      <div class="popup-meta-item"> <span class="pml">Přítomno</span> <span class="pmv">${vote.pr || Object.values(vote.tot||{}).reduce((a,b)=>a+b,0) || '?'}</span> </div>
    </div>
    ${parties}
    <div style="margin-top:20px">
      <button id="toggleDetails" class="btn btn-secondary" style="width:100%;display:flex;justify-content:space-between;align-items:center">
        <span>Seznam politiků</span> <span id="toggleIcon">${icon}</span>
      </button>
      <div id="votersSection" ${detailsOpen}>${votersSectionHtml}</div> <!-- Vložíme přímo HTML -->
    </div>
  `;

  // Obsluha tlačítka pro přepnutí viditelnosti celé sekce
  content.querySelector('#toggleDetails')?.addEventListener('click', () => {
    State.showPopupDetails = !State.showPopupDetails;
    const sec = content.querySelector('#votersSection');
    const icon = content.querySelector('#toggleIcon');
    if (sec) sec.style.display = State.showPopupDetails ? '' : 'none';
    if (icon) icon.textContent = State.showPopupDetails ? '▼' : '▶';
  });

  // Stránkování pro seznam poslanců už není potřeba v tomto místě,
  // protože renderVoters generuje kompletní obsah včetně rozbalovacích prvků.
  // Pokud by sis přál stránkování i uvnitř jednotlivých kategorií, bylo by to složitější.
};
  
  const show = async (voteId) => {
    if (!overlay || !content) return;
    
    Utils.showLoader('Načítám detail...', 0);
    content.innerHTML = '<div style="padding:20px;text-align:center">Načítám...</div>';
    overlay.classList.remove('hidden');
    
    try {
      const vote = await (async () => {
        const entry = State.index?.entries?.find(e => e.id === voteId);
        if (!entry) return null;
        return await DataService.loadSession(entry.s, (p,m)=>Utils.updateLoader(p*0.8, m));
      })().then(session => session?.votes?.find(v => v.id === voteId));
      
      Utils.hideLoader();
      
      if (!vote) {
        content.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Nepodařilo se načíst.<br><button class="btn btn-primary" onclick="showVotePopup('${voteId}')">Zkusit znovu</button></div>`;
        return;
      }
      
      renderContent(vote);
      
    } catch (err) {
      Utils.hideLoader();
      console.error(err);
      content.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Chyba: ${err.message}<br><button class="btn btn-primary" onclick="showVotePopup('${voteId}')">Zkusit znovu</button></div>`;
    }
  };
  
  const hide = () => {
    overlay?.classList.add('hidden');
    Utils.hideLoader();
  };
  
  const init = () => {
    document.getElementById('popupClose')?.addEventListener('click', hide);
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.showVotePopup = show;
  };
  
  return { init, show, hide };
})();

// ============================================================================
// COMPONENT: Politician Search
// ============================================================================
// ============================================================================
// COMPONENT: Politician Search
// ============================================================================
const SearchComponent = (() => {
  const input = document.getElementById('politicianInput');
  const dropdown = document.getElementById('politicianDropdown');
  const clearBtn = document.getElementById('clearPoliticianBtn');

  // Pomocná proměnná pro sledování umístění dropdownu
  let dropdownIsInBody = false;

  const showDropdown = (items) => {
    if (!dropdown) return;

    // Pokud je dropdown stále ve svém původním rodiči, přesuň ho do body
    if (!dropdownIsInBody) {
      document.body.appendChild(dropdown);
      // Nastavíme mu potřebné styly pro absolutní pozicování
      // POZN.: Tyto styly jsou ideální mít i v CSS jako základní, JS je jen upravuje dynamicky
      dropdown.style.position = 'absolute';
      dropdown.style.zIndex = '1000'; // Zajistí, že bude nad ostatními prvky
      dropdownIsInBody = true;
    }

    // Vyprázdníme obsah
    dropdown.innerHTML = '';

    // Pokud nejsou žádné položky, skryjeme dropdown a vrátíme
    if (!items.length) {
      dropdown.classList.add('hidden');
      return;
    }

    // Vykreslení položek
    items.slice(0, 15).forEach(([pid, pol]) => {
      const div = document.createElement('div');
      div.className = 'dropdown-item';
      div.innerHTML = `<span class="pi-name">${pol.n}</span><span class="pi-party">${pol.p}</span>`;
      div.onclick = () => select(pid, pol.n);
      dropdown.appendChild(div);
    });

    // Zobrazíme dropdown
    dropdown.classList.remove('hidden');

    // Aktualizuj pozici
    updateDropdownPosition();
  };

  // Pomocná funkce pro aktualizaci pozice dropdownu podle vstupního pole
  const updateDropdownPosition = () => {
    if (!input || !dropdown) return;

    const inputRect = input.getBoundingClientRect();
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    // Vypočítej absolutní pozici pod vstupním polem
    dropdown.style.left = inputRect.left + scrollLeft + 'px';
    // Umísti těsně pod dolní okraj pole
    dropdown.style.top = inputRect.bottom + scrollTop + 'px';
    // Nastav šířku podle vstupního pole
    dropdown.style.width = inputRect.width + 'px';
    // Zajisti, aby se dropdown nezobrazoval mimo pravý okraj okna
    const maxRight = window.innerWidth + scrollLeft;
    const dropdownRight = parseInt(dropdown.style.left) + dropdown.offsetWidth;
    if (dropdownRight > maxRight) {
        dropdown.style.left = maxRight - dropdown.offsetWidth + 'px';
    }
  };

  const select = (pid, name) => {
    State.currentPoliticianId = pid;
    input.value = name;
    dropdown?.classList.add('hidden'); // Skryje dropdown po výběru
    if (clearBtn) clearBtn.style.display = 'inline-flex';
    App.render();
  };

  const clear = () => {
    State.currentPoliticianId = null;
    input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    App.render();
  };

  const init = () => {
    if (!input) return;

    // Původní listener pro zadávání textu
    input.addEventListener('input', Utils.debounce(() => {
      const q = input.value.toLowerCase().trim();
      if (!q || !State.registry) { dropdown?.classList.add('hidden'); return; }

      const matches = Object.entries(State.registry)
        .filter(([_,pol]) => pol.n?.toLowerCase().includes(q) || pol.a?.some(a=>a.toLowerCase().includes(q)))
        .sort((a,b)=>a[1].n.localeCompare(b[1].n));
      showDropdown(matches);
    }, 200));

    // Upravený listener pro focus
    input.addEventListener('focus', () => {
      // Znovu aktualizuj pozici při focusu, může se změnit viewport
      updateDropdownPosition();
      // Zobrazí dropdown znovu, pokud byl předtím otevřený
      if (input.value && dropdown?.innerHTML.trim() !== '') { // Zkontroluj, jestli má obsah
          dropdown.classList.remove('hidden');
      }
    });

    // Původní listener pro klik mimo pole
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.politician-search-wrapper') && !e.target.closest('#politicianDropdown')) {
        dropdown?.classList.add('hidden');
      }
    });

    // --- NOVÉ LISTENERY PRO POSUNUTÍ POZICE ---
    // Přidej listenery pro aktualizaci pozice
    window.addEventListener('scroll', updateDropdownPosition, true); // Použij 'capture' pro lepší zachycení
    window.addEventListener('resize', updateDropdownPosition);

    clearBtn?.addEventListener('click', clear);
  };

  // Je důležité vracet i nově vytvořenou funkci, pokud bys ji chtěl použít mimo komponentu v budoucnu,
  // ale v tomto případě je `updateDropdownPosition` interní pomocná funkce.
  // Vracíme tedy jen init a clear, jako předtím.
  return { init, clear };
})();

// ============================================================================
// MAIN APP CONTROLLER
// ============================================================================
const App = (() => {
  const termSelect = document.getElementById('termFilter');
  const errorEl = document.getElementById('errorState');
  const errorMsg = document.getElementById('errorMessage');
  
  const init = async () => {
    try {
      Utils.showLoader('Inicializuji...', 0);
      
      // Load core data
      await Promise.all([
        DataService.loadIndex(p => Utils.updateLoader(p*0.4, 'Načítám index...')),
        DataService.loadSessionsIndex(p => Utils.updateLoader(40+p*0.2, 'Načítám session index...')),
        DataService.loadRegistry(p => Utils.updateLoader(60+p*0.2, 'Načítám registry...'))
      ]);
      
      // Populate term filter
      if (termSelect && State.index?.entries) {
        const terms = [...new Set(State.index.entries.map(v => Utils.getTermForDate(v.d)).filter(Boolean))].sort().reverse();
        termSelect.innerHTML = '<option value="">— Vyberte období —</option>' + 
          terms.map(t => `<option value="${t}">Volební období ${t}</option>`).join('');
        if (terms[0]) { State.currentTerm = terms[0]; termSelect.value = terms[0]; }
      }
      
      Utils.updateLoader(95, 'Spouštím...');
      
      // Init components
      SearchComponent.init();
      PopupComponent.init();
      render();
      
      Utils.updateLoader(100, 'Hotovo');
      setTimeout(Utils.hideLoader, 300);
      
    } catch (err) {
      console.error('Init failed:', err);
      Utils.hideLoader();
      if (errorEl) {
        errorEl.classList.remove('hidden');
        if (errorMsg) errorMsg.textContent = err.message;
      }
    }
  };
  
  const render = () => {
    TimelineComponent.destroy();
    
    if (!State.currentTerm) {
      TimelineComponent.render([], null);
      StatsComponent.render([], null);
      return;
    }
    
    const votes = FilterService.getVotesForTerm(State.currentTerm);
    
    TimelineComponent.render(votes, State.currentPoliticianId, State.timeline.page);
    StatsComponent.render(votes, State.currentPoliticianId);
  };
  
  const initEvents = () => {
    termSelect?.addEventListener('change', Utils.debounce(() => {
      State.currentTerm = termSelect.value || null;
      State.timeline.page = 1;
      render();
    }, 250));
    
    document.getElementById('resetAllBtn')?.addEventListener('click', () => {
      if (termSelect) termSelect.value = '';
      State.currentTerm = null;
      State.currentPoliticianId = null;
      State.timeline.page = 1;
      SearchComponent.clear();
      render();
    });
    
    document.getElementById('retryInitBtn')?.addEventListener('click', async () => {
      DataService.clearCache();
      errorEl?.classList.add('hidden');
      await init();
    });
  };
  
  return { init, render, initEvents };
})();

// ============================================================================
// BOOT
// ============================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { App.init(); App.initEvents(); });
} else {
  App.init();
  App.initEvents();
}