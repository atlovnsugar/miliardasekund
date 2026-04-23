/**
 * Hlasování PSP ČR - Kompletní verze 3.5
 * Zahrnuje: Agregované statistiky, Srovnání s průměrem, Historii hlasování
 */

const Config = {
  DATA_BASE: './data/aggregated',
  DETAILS_BASE: './data/aggregated/details',
  REGISTRY_URL: './data/politicians/registry.json',
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
      State.stats = await res.json();
      State.currentTerm = term;
      return true;
    } catch (err) {
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
  }
};

const Components = {
  // Přehled stran s grafy
  renderPartyDashboard() {
      const container = document.getElementById('stats');
      container.innerHTML = `<h2 class="section-title">Statistiky aktivních stran v období</h2><div class="party-grid"></div>`;
      const grid = container.querySelector('.party-grid');

      // 1. Zjistíme, které strany jsou v tomto období aktivní (mají aspoň jednoho poslance v datech)
      const activePartyNames = [...new Set(Object.values(State.stats.politicians).map(p => p.party))];
      
      // 2. Vyfiltrujeme statistiky stran jen pro ty aktivní a seřadíme podle účasti
      const filteredParties = Object.values(State.stats.parties)
        .filter(party => activePartyNames.includes(party.name))
        .sort((a, b) => b.attendance - a.attendance);

      if (filteredParties.length === 0) {
        container.innerHTML = `<p class="empty-state">V tomto období nejsou k dispozici žádná data o stranách.</p>`;
        return;
      }

      filteredParties.forEach(party => {
        const card = document.createElement('div');
        card.className = 'stat-card party-card';
        // Vytvoření bezpečného ID pro HTML element (odstranění mezer a znaků)
        const safeId = party.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
        
        card.innerHTML = `
          <div class="party-header">
              <h3>${party.name}</h3>
              <span class="attendance-badge">${party.attendance}%</span>
          </div>
          <p class="small text-muted">Účast strany v tomto období</p>
          <div class="chart-container">
              <canvas id="chart-${safeId}"></canvas>
          </div>
          <button class="btn btn-outline w-full mt-2" onclick="UI.filterByParty('${party.name}')">Zobrazit poslance</button>
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
    let list = Object.values(State.stats.politicians);

    if (State.filters.party !== 'all') list = list.filter(p => p.party === State.filters.party);
    if (State.filters.search) {
      const s = State.filters.search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(s));
    }

    list.sort((a, b) => b.attendance - a.attendance);

    container.innerHTML = `
      <div class="table-header-actions">
          <h2 class="section-title">Seznam poslanců (${list.length})</h2>
          <div class="filters">
            <input type="text" id="pSearch" placeholder="Hledat jméno..." value="${State.filters.search}">
            <select id="pPartyFilter">
                <option value="all">Všechny strany</option>
                ${[...new Set(Object.values(State.stats.politicians).map(p => p.party))].sort().map(p => `
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
                        <td><strong>${p.name}</strong></td>
                        <td><span class="party-tag">${p.party}</span></td>
                        <td class="text-right">
                            <div class="progress-mini">
                                <div class="progress-bar" style="width: ${p.attendance}%"></div>
                                <span>${p.attendance}%</span>
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
    const partyAvg = State.stats.parties[p.party].attendance;
    const globalAvg = State.stats.global.attendance;

    const overlay = document.getElementById('voteOverlay');
    const content = document.getElementById('popupContent');
    overlay.classList.remove('hidden');
    content.innerHTML = `<div class="loader-inner">Načítám detail poslance...</div>`;

    // Načteme historii z externího souboru
    const history = await DataService.loadPoliticianHistory(pId);

    content.innerHTML = `
      <div class="detail-header">
          <div class="p-info">
              <h1>${p.name}</h1>
              <span class="party-large">${p.party}</span>
          </div>
          <div class="p-score">
              <span class="score-val">${p.attendance}%</span>
              <span class="score-label">Účast v období</span>
          </div>
      </div>

      <div class="comparison-section">
          <h3>Srovnání s průměrem</h3>
          <p class="text-muted mb-2">Jak si vede poslanec ve srovnání s ostatními (v %):</p>
          <div class="chart-main-container">
            <canvas id="comparisonChart"></canvas>
          </div>
      </div>

      <div class="history-section">
          <h3>Historie posledních hlasování</h3>
          <div class="table-wrapper">
              <table class="data-table small-table">
                  <thead>
                      <tr>
                          <th>Datum</th>
                          <th>Schůze/Hl.</th>
                          <th>Hlasoval</th>
                          <th>Výsledek</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${history.slice(0, 50).map(h => `
                          <tr>
                              <td>${h.d}</td>
                              <td>${h.s} / ${h.v}</td>
                              <td><span class="vote-h vote-${h.h}">${this.translateVote(h.h)}</span></td>
                              <td><span class="vote-res res-${h.res}">${h.res === 'accepted' ? 'Přijato' : 'Zamítnuto'}</span></td>
                          </tr>
                      `).join('')}
                  </tbody>
              </table>
              <p class="small text-muted mt-1">* Zobrazeno posledních 50 hlasování.</p>
          </div>
      </div>
    `;

    this.renderComparisonChart(p.name, p.attendance, p.party, partyAvg, globalAvg);
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
    await DataService.fetchRegistry();
    this.bindEvents();
    // Defaultně zkusíme načíst 9. období
    const termSelect = document.getElementById('termSelect');
    if (termSelect.value) {
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