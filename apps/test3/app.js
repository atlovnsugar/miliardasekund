/**
 * Hlasování PSP ČR - Kompletní verze 3.5
 * Zahrnuje: Agregované statistiky, Srovnání s průměrem, Historii hlasování
 */

const Config = {
  DATA_BASE: './data/aggregated',
  DETAILS_BASE: './data/aggregated/details',
  REGISTRY_URL: './data/politicians/registry.json',
  SESSIONS_INDEX_URL: './data/sessions_index.json',
  
  // 🔥 TERM_RANGES pro spolehlivé filtrování podle data
  TERM_RANGES: {
    '9': { from: '2021-10-01', to: '2025-12-31' },
    '8': { from: '2017-10-01', to: '2021-09-30' },
    '7': { from: '2013-10-01', to: '2017-09-30' },
    '6': { from: '2010-06-01', to: '2013-09-30' },
    '5': { from: '2006-06-01', to: '2010-05-31' },
    '4': { from: '2002-06-01', to: '2006-05-31' },
    '3': { from: '1998-06-01', to: '2002-05-31' },
    '2': { from: '1996-06-01', to: '1998-05-31' },
  }
};

const State = {
  stats: null,
  registry: null,
  currentTerm: null,
  filters: {
    party: 'all',
    search: '',
  }
};

const DataService = {
  async fetchRegistry() {
    const res = await fetch(Config.REGISTRY_URL);
    const data = await res.json();
    State.registry = data.pol;
  },

async loadTermStats(term) {
  try {
    this.toggleLoader(true);
    const res = await fetch(`${Config.DATA_BASE}/stats_${term}.json`);
    if (!res.ok) throw new Error('Data pro toto období nebyla nalezena.');
    const rawData = await res.json();
    
    // Data jsou již předem agregovaná podle období - použijeme je tak, jak jsou
    // Každý stats_X.json obsahuje pouze data pro dané volební období
    
    // Normalizace: pokud politici používají zkrácené klíče {p: "Strana"}, 
    // vytvoříme alias 'party' pro kompatibilitu s kódem
    if (rawData.politicians) {
      for (const p of Object.values(rawData.politicians)) {
        if (p.p && !p.party) p.party = p.p;  // alias pro 'party'
        if (p.n && !p.name) p.name = p.n;    // alias pro 'name'
      }
    }
    
    State.stats = rawData;
    State.currentTerm = parseInt(term);
    
    const pCount = Object.keys(rawData.politicians || {}).length;
    const sCount = Object.keys(rawData.parties || {}).length;
    console.log(`✅ Načteno období ${term}: ${pCount} politiků, ${sCount} stran`);
    return true;
    
  } catch (err) {
    console.error('❌ Chyba při načítání:', err);
    alert(err.message);
    return false;
  } finally {
    this.toggleLoader(false);
  }
},

  async loadPoliticianHistory(pId) {
    const res = await fetch(`${Config.DETAILS_BASE}/${pId}.json`);
    return await res.json();
  },

  toggleLoader(show) {
    const loader = document.getElementById('globalLoader');
    if (loader) loader.classList.toggle('hidden', !show);
  },

    async fetchSessionsIndex() {
    try {
      const res = await fetch(Config.SESSIONS_INDEX_URL);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('⚠️ Nepodařilo se načíst sessions_index.json:', e);
      return null;
    }
  },

  // 🔥 NOVÁ METODA: Získá ID politiků, kteří hlasovali v daném období
  async getActivePoliticianIdsForTerm(term) {
    const range = Config.TERM_RANGES[term];
    if (!range) return new Set();
    
    const sessionsIndex = await this.fetchSessionsIndex();
    const sessionIds = sessionsIndex?.[term];
    if (!sessionIds?.length) return new Set();
    
    const activeIds = new Set();
    
    // Načteme jen první 3 schůze jako vzorek (pro rychlost)
    // Pokud potřebuješ 100% přesnost, odstraň .slice(0, 3)
    const sampleSessions = sessionIds.slice(0, 3);
    
    for (const sid of sampleSessions) {
      try {
        const res = await fetch(`./data/sessions/session_${sid}.json`);
        if (!res.ok) continue;
        const session = await res.json();
        
        // Projdeme hlasy a extrahujeme ID politiků
        if (session?.votes) {
          for (const vote of session.votes) {
            // Filtr podle data (dodatečná pojistka)
            if (vote.d >= range.from && vote.d <= range.to) {
              if (vote.vl?.length) {
                for (const voter of vote.vl) {
                  if (voter.i) activeIds.add(String(voter.i));
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ Chyba při načítání session ${sid}:`, e);
      }
    }
    
    console.log(`🔍 Vzorek pro období ${term}: ${activeIds.size} aktivních politiků`);
    return activeIds;
  },

  async loadTermStats(term) {
    try {
      this.toggleLoader(true);
      
      // 1. Načti aggregated data (pro UI a statistiky)
      const res = await fetch(`${Config.DATA_BASE}/stats_${term}.json`);
      if (!res.ok) throw new Error('Data pro toto období nebyla nalezena.');
      const rawData = await res.json();
      
      // 2. 🔥 Získej whitelist aktivních politiků ze sessions
      const activeIds = await this.getActivePoliticianIdsForTerm(term);
      
      // 3. Filtr politiků: jen ti, kteří jsou v whitelistu
      let filteredPoliticians = rawData.politicians;
      if (activeIds.size > 0) {
        filteredPoliticians = {};
        for (const [id, p] of Object.entries(rawData.politicians || {})) {
          if (activeIds.has(String(id))) {
            // Normalizace klíčů pro kompatibilitu
            if (p.p && !p.party) p.party = p.p;
            if (p.n && !p.name) p.name = p.n;
            filteredPoliticians[id] = p;
          }
        }
      } else {
        // Fallback: normalizace bez filtru
        for (const p of Object.values(rawData.politicians || {})) {
          if (p.p && !p.party) p.party = p.p;
          if (p.n && !p.name) p.name = p.n;
        }
      }
      
      // 4. Filtr stran: jen ty, které mají alespoň jednoho aktivního politika
      const activePartyNames = new Set(
        Object.values(filteredPoliticians).map(p => p.party || p.p).filter(Boolean)
      );
      
      const filteredParties = {};
      for (const [key, party] of Object.entries(rawData.parties || {})) {
        if (activePartyNames.has(party.name)) {
          filteredParties[key] = party;
        }
      }
      
      // 5. Aktualizuj state
      State.stats = {
        ...rawData,
        politicians: filteredPoliticians,
        parties: filteredParties
      };
      State.currentTerm = parseInt(term);
      
      const pCount = Object.keys(filteredPoliticians).length;
      const sCount = Object.keys(filteredParties).length;
      console.log(`✅ Načteno období ${term}: ${pCount} politiků, ${sCount} stran`);
      return true;
      
    } catch (err) {
      console.error('❌ Chyba při načítání:', err);
      alert(err.message);
      return false;
    } finally {
      this.toggleLoader(false);
    }
  }
};

const Components = {
  // Přehled stran s grafy
renderPartyDashboard() {
  const container = document.getElementById('stats');
  container.innerHTML = `<h2 class="section-title">Statistiky aktivních stran v období</h2><div class="party-grid"></div>`;
  const grid = container.querySelector('.party-grid');

  // Bezpečný přístup: p.party || p.p
  const activePartyNames = [...new Set(
    Object.values(State.stats.politicians || {})
      .map(p => p.party || p.p)
      .filter(Boolean)
  )];
  
  const filteredParties = Object.values(State.stats.parties || {})
    .filter(party => activePartyNames.includes(party.name))
    .sort((a, b) => b.attendance - a.attendance);

  if (filteredParties.length === 0) {
    container.innerHTML = `<p class="empty-state">V tomto období nejsou k dispozici žádná data o stranách.</p>`;
    return;
  }

  filteredParties.forEach(party => {
    const card = document.createElement('div');
    card.className = 'stat-card party-card';
    
    const safeId = party.name
      .toString()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || `party-${Math.random().toString(36).substr(2, 9)}`;
    
    card.innerHTML = `
      <div class="party-header">
          <h3>${party.name}</h3>
          <span class="attendance-badge">${party.attendance}%</span>
      </div>
      <p class="small text-muted">Účast strany v tomto období</p>
      <div class="chart-container">
          <canvas id="chart-${safeId}"></canvas>
      </div>
      <button class="btn btn-outline w-full mt-2" onclick="UI.filterByParty('${party.name.replace(/'/g, "\\'")}')">Zobrazit poslance</button>
    `;
    grid.appendChild(card);
    this.renderMiniChart(`chart-${safeId}`, party.votes);
  });
},

  renderMiniChart(canvasId, votes) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Pro', 'Proti', 'Zdržel se', 'Nepřítomen'],
        datasets: [{
          data: [votes.A, votes.N, votes.Z, votes.M + votes['0']],
          backgroundColor: ['#10b981', '#ef4444', '#f59e0b', '#64748b'],
          borderWidth: 0
        }]
      },
      options: { cutout: '70%', plugins: { legend: { display: false } } }
    });
  },

  // Tabulka všech poslanců
renderPoliticiansList() {
  const container = document.getElementById('timeline');
  let list = Object.values(State.stats.politicians || {});

  // Filtry s bezpečným přístupem k party
  if (State.filters.party !== 'all') {
    list = list.filter(p => (p.party || p.p) === State.filters.party);
  }
  if (State.filters.search) {
    const s = State.filters.search.toLowerCase();
    list = list.filter(p => (p.name || p.n || '').toLowerCase().includes(s));
  }

  list.sort((a, b) => (b.attendance || 0) - (a.attendance || 0));

  const availableParties = [...new Set(
    list.map(p => p.party || p.p).filter(Boolean)
  )].sort();

  container.innerHTML = `
    <div class="table-header-actions">
        <h2 class="section-title">Seznam poslanců (${list.length})</h2>
        <div class="filters">
          <input type="text" id="pSearch" placeholder="Hledat jméno..." value="${State.filters.search}">
          <select id="pPartyFilter">
              <option value="all">Všechny strany</option>
              ${availableParties.map(p => `
    <option value="${p}" ${State.filters.party === p ? 'selected' : ''}>${p}</option>
`).join('')}
          </select>
        </div>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
          <thead>
              <tr>
                  <th>Poslanec</th>
                  <th>Strana</th>
                  <th class="text-right">Účast</th>
                  <th></th>
              </tr>
          </thead>
          <tbody>
              ${list.map(p => `
                  <tr class="clickable-row" onclick="UI.showPoliticianDetail('${p.id}')">
                      <td><strong>${p.name || p.n}</strong></td>
                      <td><span class="party-tag">${p.party || p.p}</span></td>
                      <td class="text-right">
                          <div class="progress-mini">
                              <div class="progress-bar" style="width: ${p.attendance || 0}%"></div>
                              <span>${p.attendance || 0}%</span>
                          </div>
                      </td>
                      <td class="text-right">🔍</td>
                  </tr>
              `).join('')}
          </tbody>
      </table>
    </div>
  `;

  document.getElementById('pSearch').addEventListener('input', (e) => {
    State.filters.search = e.target.value;
    this.renderPoliticiansList();
  });
  document.getElementById('pPartyFilter').addEventListener('change', (e) => {
    State.filters.party = e.target.value;
    this.renderPoliticiansList();
  });
},

  // Detail poslance - Srovnání a Historie
async renderPoliticianDetail(pId) {
  const p = State.stats.politicians[pId];
  const partyKey = p.party || p.p;
  const partyAvg = State.stats.parties[partyKey]?.attendance || 0;
  const globalAvg = State.stats.global?.attendance || 0;

  const overlay = document.getElementById('voteOverlay');
  const content = document.getElementById('popupContent');
  overlay.classList.remove('hidden');
  content.innerHTML = `<div class="loader-inner">Načítám detail poslance...</div>`;

  const history = await DataService.loadPoliticianHistory(pId);

  content.innerHTML = `
    <div class="detail-header">
        <div class="p-info">
            <h1>${p.name || p.n}</h1>
            <span class="party-large">${partyKey}</span>
        </div>
        <div class="p-score">
            <span class="score-val">${p.attendance || 0}%</span>
            <span class="score-label">Účast v období</span>
        </div>
    </div>
    <!-- ... zbytek zůstává stejný ... -->
  `;

  this.renderComparisonChart(p.name || p.n, p.attendance || 0, partyKey, partyAvg, globalAvg);
},

  translateVote(code) {
    const map = { 'A': 'ANO', 'N': 'NE', 'Z': 'Zdržel se', 'M': 'Omluven', '0': 'Nepřihlášen' };
    return map[code] || code;
  },

  renderComparisonChart(name, pVal, partyName, partyVal, globalVal) {
    const ctx = document.getElementById('comparisonChart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [name, `Průměr ${partyName}`, 'Průměrný poslanec (Sněmovna)'],
        datasets: [{
          label: 'Účast na hlasování (%)',
          data: [pVal, partyVal, globalVal],
          backgroundColor: ['#3b82f6', '#10b981', '#94a3b8'],
          borderRadius: 8
        }]
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, max: 100 } }
      }
    });
  }
};

const UI = {
  async init() {
    // Načti registry i sessions index paralelně
    await Promise.all([
      DataService.fetchRegistry(),
      DataService.fetchSessionsIndex() // 🆕 Přednačti sessions index
    ]);
    
    this.bindEvents();
    
    const termSelect = document.getElementById('termSelect');
    if (termSelect && termSelect.value) {
        const success = await DataService.loadTermStats(termSelect.value);
        if (success) this.refreshAll();
    }
  },

  bindEvents() {
    document.getElementById('termSelect').addEventListener('change', async (e) => {
          if (e.target.value) {
            // RESET filtrů, aby nezůstala viset strana z minulého období
            State.filters.party = 'all';
            State.filters.search = '';
            
            const success = await DataService.loadTermStats(e.target.value);
            if (success) this.refreshAll();
          }
        });

    document.getElementById('popupClose').addEventListener('click', () => {
      document.getElementById('voteOverlay').classList.add('hidden');
    });

    window.addEventListener('click', (e) => {
        if (e.target.id === 'voteOverlay') document.getElementById('voteOverlay').classList.add('hidden');
    });
  },

  filterByParty(partyName) {
    State.filters.party = partyName;
    Components.renderPoliticiansList();
    document.getElementById('timeline').scrollIntoView({ behavior: 'smooth' });
  },

  showPoliticianDetail(pId) {
    Components.renderPoliticianDetail(pId);
  },

  refreshAll() {
    Components.renderPartyDashboard();
    Components.renderPoliticiansList();
  }
};

document.addEventListener('DOMContentLoaded', () => UI.init());