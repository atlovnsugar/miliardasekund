/**
 * Voting Visualization App
 * FiveThirtyEight-style interactive charts for Czech Parliament voting data
 * Static site compatible - runs entirely in browser
 */

// ============================================================================
// CONFIG & STATE
// ============================================================================
const CONFIG = {
  DATA_BASE: '/apps/voting-app/data',
  COMPRESSED: false,
  CACHE_DURATION: 3600000, // 1 hour
  MAX_POLITICIANS_DISPLAY: 50,
  ANIMATION_DURATION: 400
};

const state = {
  index: null,
  registry: null,
  sessions: new Map(),
  filters: {
    dateFrom: null,
    dateTo: null,
    party: null,
    politician: null,
    term: null
  },
  attendanceSort: 'best',
  selectedPoliticians: [],
  selectedVote: null,
  cache: new Map()
};

// ============================================================================
// DATA LOADER (with caching)
// ============================================================================
class DataLoader {
  static async fetchJSON(url) {
    const cacheKey = url;
    const cached = state.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_DURATION) {
      return cached.data;
    }
    
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const contentEncoding = res.headers.get('Content-Encoding');
      const buffer = await res.arrayBuffer();
      
      let data;
      if (contentEncoding === 'gzip' || url.endsWith('.gz')) {
        // Decompress using pako
        const uncompressed = pako.inflate(new Uint8Array(buffer), { to: 'string' });
        data = JSON.parse(uncompressed);
      } else {
        // Normal JSON
        const text = new TextDecoder().decode(buffer);
        data = JSON.parse(text);
      }
      
      state.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (e) {
      console.error(`Failed to load ${url}:`, e);
      throw e;
    }
  }

  static async loadIndex() {
    const file = `${CONFIG.DATA_BASE}/index.json`;
    state.index = await this.fetchJSON(file);
    return state.index;
  }

  static async loadRegistry() {
    const file = `${CONFIG.DATA_BASE}/politicians/registry.json`;
    const data = await this.fetchJSON(file);
    state.registry = data.pol;
    return state.registry;
  }

  static async loadSession(sessionNum) {
    if (state.sessions.has(sessionNum)) {
      return state.sessions.get(sessionNum);
    }
    const file = `${CONFIG.DATA_BASE}/sessions/session_${sessionNum}.json${CONFIG.COMPRESSED ? '.gz' : ''}`;
    const data = await this.fetchJSON(file);
    state.sessions.set(sessionNum, data);
    return data;
  }

  static async loadVoteDetail(voteId) {
    // Find which session contains this vote
    const entry = state.index.entries.find(e => e.id === voteId);
    if (!entry) return null;
    
    const session = await this.loadSession(entry.s);
    return session.votes.find(v => v.id === voteId);
  }
}

// ============================================================================
// FILTERS & SEARCH
// ============================================================================
function applyFilters(votes) {
  return votes.filter(vote => {
    if (state.filters.dateFrom && vote.d < state.filters.dateFrom) return false;
    if (state.filters.dateTo && vote.d > state.filters.dateTo) return false;
    
    // Term filter
    if (state.filters.term && vote.term) {
      if (vote.term !== state.filters.term) return false;
    }
    
    if (state.filters.party) {
      const hasParty = vote.vl?.some(v => v.p === state.filters.party);
      if (!hasParty) return false;
    }
    
    if (state.filters.politician) {
      const query = state.filters.politician.toLowerCase().trim();
      const hasPolitician = vote.vl?.some(v => {
        const name = (v.n || '').toLowerCase();
        const regEntry = state.registry?.[v.i];
        const aliases = regEntry?.a || [];
        return name.includes(query) || aliases.some(a => a.toLowerCase().includes(query));
      });
      if (!hasPolitician) return false;
    }
    
    return true;
  });
}

function setupFilters() {
  document.getElementById('dateFrom').addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value || null;
    renderAll();
  });
  document.getElementById('dateTo').addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value || null;
    renderAll();
  });
  document.getElementById('partyFilter').addEventListener('change', (e) => {
    state.filters.party = e.target.value || null;
    renderAll();
  });

  let searchTimeout;
  document.getElementById('politicianSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.filters.politician = e.target.value.trim() || null;
      renderAll();
    }, 300);
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    state.filters = { 
      dateFrom: null, dateTo: null, 
      party: null, politician: null,
      term: null
    };
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    document.getElementById('partyFilter').value = '';
    document.getElementById('politicianSearch').value = '';
    document.getElementById('termFilter').value = '';
    renderAll();
  });
}

// ============================================================================
// CHARTS (D3.js)
// ============================================================================

// Participation chart - bar chart with annotations
function renderParticipationChart(votes) {
  const container = document.getElementById('participationChart');
  container.innerHTML = '';
  
  if (votes.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px">Žádná data pro vybrané filtry</p>';
    return;
  }

  const margin = {top: 20, right: 30, bottom: 50, left: 55};
  const width = container.clientWidth - margin.left - margin.right;
  const height = 300 - margin.top - margin.bottom;

  const svg = d3.select('#participationChart')
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', height + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Sample data for display
  const sampleSize = Math.min(votes.length, 150);
  const step = Math.floor(votes.length / sampleSize);
  const data = votes
    .filter((_, i) => i % step === 0)
    .slice(0, sampleSize)
    .map(v => ({
      date: new Date(v.d),
      present: v.pr || 0,
      required: v.req || 0,
      result: v.r,
      voteId: v.id,
      title: v.title || ''
    }));

  const x = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([0, width]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => Math.max(d.present, 200)) * 1.1])
    .range([height, 0]);

  // Grid
  svg.append('g')
    .attr('class', 'grid')
    .call(d3.axisLeft(y).ticks(4).tickSize(-width).tickFormat(''))
    .selectAll('line')
    .attr('stroke', 'rgba(255,255,255,0.05)')
    .attr('stroke-dasharray', '4,4');
  svg.select('.grid .domain').remove();

  // Axes
  svg.append('g')
    .attr('transform', `translate(0,${height})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat('%m/%y')))
    .selectAll('text')
    .style('fill', 'var(--text-secondary)')
    .style('font-size', '10px');

  svg.append('g')
    .call(d3.axisLeft(y).ticks(5))
    .selectAll('text')
    .style('fill', 'var(--text-secondary)')
    .style('font-size', '10px');

  // Line for required majority
  const reqLine = d3.line()
    .x(d => x(d.date))
    .y(d => y(d.required))
    .curve(d3.curveMonotoneX);
  
  svg.append('path')
    .datum(data.filter(d => d.required > 0))
    .attr('fill', 'none')
    .attr('stroke', 'var(--gold-2)')
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '6,4')
    .attr('opacity', 0.6)
    .attr('d', reqLine);

  // Bubble scatter plot
  svg.selectAll('.bubble')
    .data(data)
    .enter()
    .append('circle')
    .attr('class', 'bubble')
    .attr('cx', d => x(d.date))
    .attr('cy', d => y(d.present))
    .attr('r', 5)
    .attr('fill', d => d.result === 'accepted' ? 'var(--emerald-2)' : '#f87171')
    .attr('fill-opacity', 0.75)
    .attr('stroke', d => d.result === 'accepted' ? 'var(--emerald-1)' : '#dc2626')
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      d3.select(this).attr('r', 8).attr('fill-opacity', 1);
      showTooltip(event, `
        <strong>${d.date.toLocaleDateString('cs-CZ')}</strong><br>
        Přítomno: <strong>${d.present}</strong><br>
        Potřeba: <strong>${d.required}</strong><br>
        <span style="color:${d.result === 'accepted' ? 'var(--emerald-2)' : '#f87171'}">
          ${d.result === 'accepted' ? '✅ Přijato' : '❌ Zamítnuto'}
        </span>
      `);
    })
    .on('mouseout', function() {
      d3.select(this).attr('r', 5).attr('fill-opacity', 0.75);
      hideTooltip();
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      showVotePopup(d.voteId);
    });

  // Legend
  const legend = svg.append('g').attr('transform', `translate(0, ${height + 32})`);
  [[0, 'var(--emerald-2)', 'Přijato'], [80, '#f87171', 'Zamítnuto'], [170, 'var(--gold-2)', '-- Potřebná většina']].forEach(([xPos, color, label]) => {
    legend.append('circle').attr('cx', xPos + 6).attr('cy', 6).attr('r', 5).attr('fill', color).attr('opacity', 0.8);
    legend.append('text').attr('x', xPos + 16).attr('y', 10)
      .style('fill', 'var(--text-secondary)').style('font-size', '10px').text(label);
  });

  // Y-axis label
  svg.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('y', -45).attr('x', -height/2)
    .attr('text-anchor', 'middle')
    .style('fill', 'var(--text-muted)')
    .style('font-size', '10px')
    .text('Přítomno poslanců');
}

// Party breakdown - stacked bar
function renderPartyChart(votes) {
  const container = document.getElementById('partyChart');
  container.innerHTML = '';
  if (votes.length === 0) return;

  // Aggregate by party
  const partyData = {};
  votes.forEach(vote => {
    if (!vote.vl) return;
    vote.vl.forEach(v => {
      const party = v.p;
      if (!party) return;
      if (!partyData[party]) partyData[party] = { yes: 0, no: 0, abstain: 0, other: 0 };
      if (v.vt === 'A') partyData[party].yes++;
      else if (v.vt === 'N') partyData[party].no++;
      else if (v.vt === 'Z') partyData[party].abstain++;
      else partyData[party].other++;
    });
  });

  const data = Object.entries(partyData).map(([party, counts]) => ({
    party,
    ...counts,
    total: counts.yes + counts.no + counts.abstain + counts.other
  })).filter(d => d.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);

  const margin = {top: 10, right: 10, bottom: 30, left: 60};
  const width = container.clientWidth - margin.left - margin.right;
  const height = 250 - margin.top - margin.bottom;

  const svg = d3.select('#partyChart')
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', height + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand()
    .domain(data.map(d => d.party))
    .range([0, width])
    .padding(0.2);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.total) * 1.1])
    .range([height, 0]);

  // Axes
  svg.append('g')
    .attr('transform', `translate(0,${height})`)
    .call(d3.axisBottom(x))
    .selectAll('text')
    .style('fill', 'var(--text-secondary)')
    .style('font-size', '9px')
    .attr('transform', 'rotate(-45)')
    .style('text-anchor', 'end');

  svg.append('g')
    .call(d3.axisLeft(y).ticks(4))
    .selectAll('text')
    .style('fill', 'var(--text-secondary)')
    .style('font-size', '9px');

  // Stacked bars
  const stack = d3.stack().keys(['yes', 'no', 'abstain', 'other']);
  const series = stack(data);

  const color = d3.scaleOrdinal()
    .domain(['yes', 'no', 'abstain', 'other'])
    .range(['var(--emerald-2)', '#f87171', 'var(--gold-2)', 'var(--platinum-2)']);

  series.forEach(layer => {
    svg.selectAll(`.${layer.key}`)
      .data(layer)
      .enter()
      .append('rect')
      .attr('class', layer.key)
      .attr('x', d => x(d.data.party))
      .attr('y', d => y(d[1]))
      .attr('height', d => y(d[0]) - y(d[1]))
      .attr('width', x.bandwidth())
      .attr('fill', color(layer.key))
      .attr('rx', 2);
  });

  // Legend
  const legend = svg.append('g')
    .attr('transform', `translate(0, ${height + 20})`);
  
  ['yes', 'no', 'abstain', 'other'].forEach((key, i) => {
    legend.append('rect')
      .attr('x', i * 70)
      .attr('width', 12)
      .attr('height', 12)
      .attr('fill', color(key))
      .attr('rx', 3);
    legend.append('text')
      .attr('x', i * 70 + 18)
      .attr('y', 10)
      .style('fill', 'var(--text-secondary)')
      .style('font-size', '9px')
      .text({yes:'Ano', no:'Ne', abstain:'Zdržel', other:'Ostatní'}[key]);
  });
}

// Vote type distribution - donut chart
function renderVoteTypeChart(votes) {
  const container = document.getElementById('voteTypeChart');
  container.innerHTML = '';
  
  if (votes.length === 0) return;

  // Aggregate totals
  const totals = { A: 0, N: 0, Z: 0, '0': 0, M: 0 };
  votes.forEach(v => {
    Object.keys(totals).forEach(key => {
      totals[key] += v.tot?.[key] || 0;
    });
  });

  const data = [
    { key: 'A', label: 'Ano', value: totals['A'], color: 'var(--emerald-2)' },
    { key: 'N', label: 'Ne', value: totals['N'], color: '#f87171' },
    { key: 'Z', label: 'Zdržel', value: totals['Z'], color: 'var(--gold-2)' },
    { key: '0', label: 'Nepřihlášen', value: totals['0'], color: 'var(--platinum-2)' },
    { key: 'M', label: 'Omluven', value: totals['M'], color: 'var(--text-muted)' }
  ].filter(d => d.value > 0);

  if (data.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted)">Žádná data</p>';
    return;
  }

  const size = Math.min(250, container.clientWidth);
  const radius = size / 2 - 10;
  const innerRadius = radius * 0.6;

  const svg = d3.select('#voteTypeChart')
    .append('svg')
    .attr('width', size)
    .attr('height', size)
    .append('g')
    .attr('transform', `translate(${size/2}, ${size/2})`);

  const pie = d3.pie().value(d => d.value).sort(null);
  const arc = d3.arc().innerRadius(innerRadius).outerRadius(radius);

  const arcs = svg.selectAll('.arc')
    .data(pie(data))
    .enter()
    .append('g')
    .attr('class', 'arc');

  arcs.append('path')
    .attr('d', arc)
    .attr('fill', d => d.data.color)
    .attr('stroke', 'var(--bg-secondary)')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .on('mouseover', function(e, d) {
      d3.select(this).attr('opacity', 0.8);
      const pct = ((d.data.value / d3.sum(data, x => x.value)) * 100).toFixed(1);
      showTooltip(e, `${d.data.label}: ${d.data.value} (${pct}%)`);
    })
    .on('mouseout', function() {
      d3.select(this).attr('opacity', 1);
      hideTooltip();
    });

  // Center text
  const total = d3.sum(data, d => d.value);
  svg.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.5em')
    .style('fill', 'var(--text-primary)')
    .style('font-size', '1.2rem')
    .style('font-weight', '700')
    .text(total);
  svg.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '1.2em')
    .style('fill', 'var(--text-secondary)')
    .style('font-size', '0.8rem')
    .text('hlasů');
}

// ============================================================================
// TIMELINE & POLITICIAN CARDS
// ============================================================================

function renderTimelinePreview(votes) {
  const container = document.getElementById('timelinePreview');
  container.innerHTML = '';
  
  if (votes.length === 0) return;

  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  
  const track = document.createElement('div');
  track.className = 'timeline-track';
  timeline.appendChild(track);

  // Sample votes for preview
  const sample = votes.slice(0, 30);
  const minDate = new Date(sample[0].d);
  const maxDate = new Date(sample[sample.length - 1].d);
  const range = maxDate - minDate;

  sample.forEach(vote => {
    const bubble = document.createElement('div');
    const voteDate = new Date(vote.d);
    const position = ((voteDate - minDate) / range) * 90 + 5; // 5-95%
    
    // Determine dominant vote type for coloring
    const tot = vote.tot || {};
    const types = [
      { key: 'A', class: 'vote-yes' },
      { key: 'N', class: 'vote-no' },
      { key: 'Z', class: 'vote-abstain' }
    ];
    const dominant = types.reduce((a, b) => (tot[b.key] || 0) > (tot[a.key] || 0) ? b : a);
    
    bubble.className = `timeline-bubble ${dominant.class}`;
    bubble.style.left = `${position}%`;
    bubble.title = `${vote.d}: ${vote.r === 'accepted' ? 'Přijato' : 'Zamítnuto'}`;
    bubble.onclick = () => showVotePopup(vote.id);
    
    timeline.appendChild(bubble);
  });

  container.appendChild(timeline);
}

function renderPoliticiansList(votes) {
  const container = document.getElementById('politiciansList');
  container.innerHTML = '';

  // Aggregate politician stats from filtered votes
  const polStats = {};
  votes.forEach(vote => {
    vote.vl?.forEach(v => {
      const pid = v.i;
      if (!pid || !state.registry?.[pid]) return;
      
      if (!polStats[pid]) {
        polStats[pid] = {
          name: state.registry[pid].n,
          party: v.p,
          alias: state.registry[pid].a?.[0],
          votes: [],
          yes: 0, no: 0, abstain: 0
        };
      }
      polStats[pid].votes.push({ id: vote.id, date: vote.d, vt: v.vt });
      if (v.vt === 'A') polStats[pid].yes++;
      else if (v.vt === 'N') polStats[pid].no++;
      else if (v.vt === 'Z') polStats[pid].abstain++;
    });
  });

  const politicians = Object.values(polStats)
    .filter(p => p.votes.length >= 3) // min threshold
    .sort((a, b) => b.votes.length - a.votes.length)
    .slice(0, CONFIG.MAX_POLITICIANS_DISPLAY);

  if (politicians.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1">Žádní politici pro vybrané filtry</p>';
    return;
  }

  politicians.forEach(pol => {
    const total = pol.yes + pol.no + pol.abstain;
    const yesRatio = total > 0 ? Math.round((pol.yes / total) * 100) : 0;
    
    const card = document.createElement('div');
    card.className = 'politician-card';
    card.innerHTML = `
      <div class="politician-avatar">${pol.name.charAt(0)}</div>
      <div class="politician-info">
        <h4>${pol.name}</h4>
        <div class="party">${pol.party}</div>
        ${pol.alias ? `<div class="alias">dříve: ${pol.alias}</div>` : ''}
      </div>
      <div class="politician-stats">
        <div><span class="yes-ratio">${yesRatio}%</span> Ano</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">${pol.votes.length} hlasování</div>
      </div>
    `;
    
    card.onclick = () => {
      // Toggle selection for comparison
      const idx = state.selectedPoliticians.indexOf(pol);
      if (idx === -1) {
        if (state.selectedPoliticians.length >= 3) {
          alert('Lze porovnat maximálně 3 politiky najednou');
          return;
        }
        state.selectedPoliticians.push(pol);
        card.style.borderColor = 'var(--accent-1)';
        card.style.boxShadow = '0 0 0 2px var(--accent-1)';
      } else {
        state.selectedPoliticians.splice(idx, 1);
        card.style.borderColor = '';
        card.style.boxShadow = '';
      }
      renderComparison();
    };
    
    // Add timeline bubbles on hover
    card.onmouseenter = () => showPoliticianTimeline(pol, card);
    card.onmouseleave = () => hidePoliticianTimeline();
    
    container.appendChild(card);
  });
}

// Politician timeline tooltip
let timelineTooltip = null;
function showPoliticianTimeline(pol, anchor) {
  hidePoliticianTimeline();
  
  timelineTooltip = document.createElement('div');
  timelineTooltip.className = 'tooltip visible';
  timelineTooltip.style.maxWidth = '320px';
  
  const recent = pol.votes.slice(-15).reverse();
  const html = `
    <h4>${pol.name} - Poslední hlasování</h4>
    <div class="timeline" style="height:40px;margin:8px 0">
      <div class="timeline-track"></div>
      ${recent.map((v, i) => {
        const pos = (i / (recent.length - 1 || 1)) * 90 + 5;
        const cls = {A:'vote-yes', N:'vote-no', Z:'vote-abstain', '0':'vote-not-logged', M:'vote-excused'}[v.vt] || 'vote-not-logged';
        return `<div class="timeline-bubble ${cls}" style="left:${pos}%" title="${v.date}"></div>`;
      }).join('')}
    </div>
    <table>
      ${recent.slice(0, 5).map(v => `
        <tr>
          <td>${v.date}</td>
          <td class="${{A:'vote-yes', N:'vote-no', Z:'vote-abstain'}[v.vt] || ''}">
            ${{A:'✅ Ano', N:'❌ Ne', Z:'⚪ Zdržel', '0':'⚪ Nepřihlášen', M:'⚪ Omluven'}[v.vt] || '?'}
          </td>
        </tr>
      `).join('')}
    </table>
    <p style="margin-top:8px;font-size:0.75rem;color:var(--text-muted)">
      Klikni na politika pro přidání do porovnání
    </p>
  `;
  
  timelineTooltip.innerHTML = html;
  document.body.appendChild(timelineTooltip);
  
  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  positionTooltip(timelineTooltip, rect.right + 10, rect.top);
}

function hidePoliticianTimeline() {
  if (timelineTooltip) {
    timelineTooltip.remove();
    timelineTooltip = null;
  }
}

// ============================================================================
// COMPARISON VIEW
// ============================================================================
function renderComparison() {
  const section = document.getElementById('comparisonSection');
  const grid = document.getElementById('comparisonGrid');
  
  if (state.selectedPoliticians.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  section.style.display = 'block';
  grid.innerHTML = '';
  
  state.selectedPoliticians.forEach(pol => {
    const total = pol.yes + pol.no + pol.abstain;
    if (total === 0) return;
    
    const card = document.createElement('div');
    card.className = 'comparison-card';
    
    const yesPct = Math.round((pol.yes / total) * 100);
    const noPct = Math.round((pol.no / total) * 100);
    const abstainPct = 100 - yesPct - noPct;
    
    card.innerHTML = `
      <h4>${pol.name} <span style="color:var(--text-secondary);font-weight:400">(${pol.party})</span></h4>
      <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:8px">
        <span class="vote-yes">${pol.yes} Ano</span>
        <span class="vote-no">${pol.no} Ne</span>
        <span class="vote-abstain">${pol.abstain} Zdržel</span>
      </div>
      <div class="comparison-bar">
        <div class="comparison-segment yes" style="flex-grow:${yesPct}" title="${yesPct}%"></div>
        <div class="comparison-segment no" style="flex-grow:${noPct}" title="${noPct}%"></div>
        <div class="comparison-segment abstain" style="flex-grow:${abstainPct}" title="${abstainPct}%"></div>
      </div>
      <div style="margin-top:12px;font-size:0.8rem;color:var(--text-secondary)">
        Celkem hlasování: <strong>${pol.votes.length}</strong>
      </div>
      <button class="btn btn-secondary" style="margin-top:12px;width:100%" onclick="showPoliticianDetail('${pol.name}')">
        Zobrazit detail
      </button>
    `;
    
    grid.appendChild(card);
  });
}


function renderAttendanceLeaderboard(votes) {
  const container = document.getElementById('attendanceLeaderboard');
  if (!container) return;
  container.innerHTML = '';

  // Attendance aggregation
  const polAttendance = {};
  votes.forEach(vote => {
    vote.vl?.forEach(v => {
      const pid = v.i;
      if (!pid || !state.registry?.[pid]) return;
      if (!polAttendance[pid]) {
        polAttendance[pid] = {
          name: state.registry[pid].n,
          party: v.p || '?',
          total: 0, present: 0, excused: 0, absent: 0
        };
      }
      polAttendance[pid].total++;
      if (v.vt === 'A' || v.vt === 'N' || v.vt === 'Z') polAttendance[pid].present++;
      else if (v.vt === 'M') polAttendance[pid].excused++;
      else polAttendance[pid].absent++;
    });
  });

  const politicians = Object.values(polAttendance)
    .filter(p => p.total >= 10)
    .map(p => ({ ...p, rate: p.total > 0 ? p.present / p.total : 0 }));

  if (politicians.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">Nedostatek dat pro výpočet docházky</p>';
    return;
  }

  const sorted = [...politicians].sort((a, b) => 
    state.attendanceSort === 'worst' ? a.rate - b.rate : b.rate - a.rate
  ).slice(0, 30);

  sorted.forEach((pol, i) => {
    const pct = Math.round(pol.rate * 100);
    const barColor = pct >= 80 ? 'var(--emerald-2)' : pct >= 60 ? 'var(--gold-2)' : '#f87171';
    const isTop3 = i < 3;
    
    const row = document.createElement('div');
    row.className = 'attendance-row';
    row.innerHTML = `
      <div class="attendance-rank ${isTop3 ? 'top3' : ''}">${i + 1}</div>
      <div>
        <div style="font-weight:600;font-size:0.9rem">${pol.name}</div>
        <div style="font-size:0.75rem;color:var(--text-muted)">${pol.party}</div>
        <div class="attendance-bar-wrap" style="width:200px">
          <div class="attendance-bar-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
      </div>
      <div style="text-align:right;font-size:0.75rem;color:var(--text-muted)">
        ${pol.present}/${pol.total} hlasování
      </div>
      <div style="font-size:1.1rem;font-weight:700;color:${barColor};min-width:48px;text-align:right">
        ${pct}%
      </div>
    `;
    container.appendChild(row);
  });
}

// For inline onclick
window.setSortAttendance = function(dir) {
  state.attendanceSort = dir;
  document.getElementById('sortBest').classList.toggle('active-sort', dir === 'best');
  document.getElementById('sortWorst').classList.toggle('active-sort', dir === 'worst');
  renderAttendanceLeaderboard(applyFilters(state.index?.entries || []));
};

// ============================================================================
// VOTE DETAIL POPUP
// ============================================================================
async function showVotePopup(voteId) {
  const popup = document.getElementById('votePopup');
  const loading = document.getElementById('globalLoading');
  
  loading.classList.remove('hidden');
  popup.classList.remove('visible');
  
  try {
    const vote = await DataLoader.loadVoteDetail(voteId);
    if (!vote) throw new Error('Hlasování nenalezeno');
    
    // Header
    document.getElementById('popupTitle').textContent = 
      `Schůze ${vote._sess || '?'}, hlasování ${vote.v}`;
    
    // Meta
    document.getElementById('popupMeta').innerHTML = `
      <div class="meta-item">
        <span class="meta-label">Datum</span>
        <span class="meta-value">${vote.d} ${vote.t}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Výsledek</span>
        <span class="meta-value ${vote.r === 'accepted' ? 'vote-yes' : 'vote-no'}">
          ${vote.r === 'accepted' ? '✅ Přijato' : '❌ Zamítnuto'}
        </span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Přítomno</span>
        <span class="meta-value">${vote.pr || '?'}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Je třeba</span>
        <span class="meta-value">${vote.req || '?'}</span>
      </div>
    `;
    
    // Party breakdown chart
    const chartEl = document.getElementById('popupChart');
    chartEl.innerHTML = '';
    chartEl.style.height = 'auto';
    chartEl.style.minHeight = '0';
    chartEl.style.background = 'none';

    if (vote.par?.length > 0) {
      vote.par.forEach(party => {
        const c = party.c || {};
        const yes = c['A'] || 0, no = c['N'] || 0, abstain = c['Z'] || 0;
        const total = yes + no + abstain;
        if (total === 0) return;
        
        const row = document.createElement('div');
        row.style.cssText = 'margin:10px 0;';
        row.innerHTML = `
          <div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:6px">
            <strong style="color:var(--text-primary)">${party.n}</strong>
            <span style="color:var(--text-secondary)">
              <span style="color:var(--emerald-2)">${yes}✓</span>
              <span style="color:#f87171;margin:0 6px">${no}✗</span>
              <span style="color:var(--gold-2)">${abstain}∅</span>
            </span>
          </div>
          <div style="display:flex;height:18px;border-radius:9px;overflow:hidden;background:rgba(255,255,255,0.05)">
            ${yes > 0 ? `<div style="flex:${yes};background:var(--emerald-2);opacity:0.8;min-width:2px" title="Ano: ${yes}"></div>` : ''}
            ${no > 0 ? `<div style="flex:${no};background:#f87171;opacity:0.8;min-width:2px" title="Ne: ${no}"></div>` : ''}
            ${abstain > 0 ? `<div style="flex:${abstain};background:var(--gold-2);opacity:0.8;min-width:2px" title="Zdržel: ${abstain}"></div>` : ''}
          </div>
        `;
        chartEl.appendChild(row);
      });
    } else {
      chartEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:8px 0">Data o stranách nejsou k dispozici</p>';
    }
    
    // Politicians list
    const listEl = document.getElementById('popupList');
    listEl.innerHTML = '';
    
    if (vote.vl?.length > 0) {
      // Group by vote type for collapsible sections
      const byType = { A: [], N: [], Z: [], '0': [], M: [] };
      vote.vl.forEach(v => {
        if (byType[v.vt]) byType[v.vt].push(v);
      });
      
      const typeLabels = { A: 'Ano', N: 'Ne', Z: 'Zdržel se', '0': 'Nepřihlášen', M: 'Omluven' };
      
      Object.entries(byType).forEach(([type, voters]) => {
        if (voters.length === 0) return;
        
        const section = document.createElement('details');
        section.open = type === 'A' || type === 'N'; // Expand yes/no by default
        section.style.margin = '8px 0';
        
        section.innerHTML = `
          <summary style="cursor:pointer;font-weight:600;color:${{A:'var(--emerald-2)',N:'#f87171',Z:'var(--gold-2)'}[type] || 'var(--text-secondary)'}">
            ${typeLabels[type]} (${voters.length})
          </summary>
          <div style="margin-top:8px;padding-left:16px;border-left:2px solid var(--border-color)">
            ${voters.slice(0, 20).map(v => `
              <div class="vote-list-item">
                <span class="name">${v.n}</span>
                <span class="party">${v.p}</span>
              </div>
            `).join('')}
            ${voters.length > 20 ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px">...a dalších ${voters.length - 20}</div>` : ''}
          </div>
        `;
        listEl.appendChild(section);
      });
    }
    
    // Show popup
    popup.classList.add('visible');
    
  } catch (e) {
    console.error(e);
    document.getElementById('popupTitle').textContent = 'Chyba';
    document.getElementById('popupMeta').innerHTML = `<p style="color:#f87171">Nepodařilo se načíst detail: ${e.message}</p>`;
    popup.classList.add('visible');
  } finally {
    loading.classList.add('hidden');
  }
}

function hideVotePopup() {
  document.getElementById('votePopup').classList.remove('visible');
  state.selectedVote = null;
}

// ============================================================================
// TOOLTIPS
// ============================================================================
let tooltip = null;

function showTooltip(event, content) {
  hideTooltip();
  
  tooltip = document.createElement('div');
  tooltip.className = 'tooltip visible';
  tooltip.innerHTML = content;
  document.body.appendChild(tooltip);
  
  // Wait for render then position
  requestAnimationFrame(() => {
    if (!tooltip) return;
    const rect = tooltip.getBoundingClientRect();
    const pad = 12;
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    
    if (left + rect.width + pad > window.innerWidth) left = event.clientX - rect.width - pad;
    if (top + rect.height + pad > window.innerHeight) top = event.clientY - rect.height - pad;
    
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });
}

function hideTooltip() {
  if (tooltip) {
    tooltip.classList.remove('visible');
    setTimeout(() => tooltip?.remove(), 150);
    tooltip = null;
  }
}

function positionTooltip(el, x, y) {
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  el.style.display = 'block';
  
  const rect = el.getBoundingClientRect();
  const padding = 12;
  
  let left = x + padding;
  let top = y + padding;
  
  if (left + rect.width + padding > window.innerWidth) {
    left = x - rect.width - padding;
  }
  
  if (top + rect.height + padding > window.innerHeight) {
    top = y - rect.height - padding;
  }
  
  left = Math.max(padding, Math.min(left, window.innerWidth - rect.width - padding));
  top = Math.max(padding, Math.min(top, window.innerHeight - rect.height - padding));
  
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// ============================================================================
// MAIN RENDER LOOP
// ============================================================================
async function renderAll() {
  if (!state.index) return;
  let votes = applyFilters(state.index.entries);
  
  renderParticipationChart(votes);
  renderPartyChart(votes);
  renderVoteTypeChart(votes);
  renderTimelinePreview(votes);
  renderPoliticiansList(votes);
  renderComparison();
  renderAttendanceLeaderboard(votes);
}

// ============================================================================
// INIT
// ============================================================================
async function init() {
  // Setup UI events first
  setupFilters();
  
  document.getElementById('closePopup').onclick = hideVotePopup;
  document.getElementById('clearComparison').onclick = () => {
    state.selectedPoliticians = [];
    renderComparison();
    document.querySelectorAll('.politician-card').forEach(card => {
      card.style.borderColor = '';
      card.style.boxShadow = '';
    });
  };
  
  document.getElementById('termFilter').addEventListener('change', (e) => {
    state.filters.term = e.target.value || null;
    renderAll();
  });
  
  document.getElementById('votePopup').onclick = (e) => {
    if (e.target.id === 'votePopup') hideVotePopup();
  };
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideVotePopup();
      hideTooltip();
      hidePoliticianTimeline();
    }
  });

  // Load data after UI is set up
  try {
    await Promise.all([
      DataLoader.loadIndex(),
      DataLoader.loadRegistry()
    ]);

    // Populate filters based on loaded data
    const termSet = new Set();
    (state.index?.entries || []).forEach(e => {
      if (e.term) {
        termSet.add(e.term);
      } else if (e.d) {
        const year = parseInt(e.d.substring(0, 4));
        if (year >= 2021) termSet.add('2021-2025');
        else if (year >= 2017) termSet.add('2017-2021');
        else if (year >= 2013) termSet.add('2013-2017');
        else if (year >= 2010) termSet.add('2010-2013');
      }
    });

    const termSelect = document.getElementById('termFilter');
    while (termSelect.options.length > 1) termSelect.remove(1);
    
    [...termSet].sort().reverse().forEach(term => {
      const opt = document.createElement('option');
      opt.value = term;
      opt.textContent = `Volební období ${term}`;
      termSelect.appendChild(opt);
    });

    // Set default term if available
    if (termSet.size > 0) {
      const defaultTerm = [...termSet].sort().pop();
      termSelect.value = defaultTerm;
      state.filters.term = defaultTerm;
    }

    // Populate party filter
    const partySet = new Set();
    Object.values(state.registry || {}).forEach(p => { if (p.p) partySet.add(p.p); });

    const partySelect = document.getElementById('partyFilter');
    while (partySelect.options.length > 1) partySelect.remove(1);
    [...partySet].sort().forEach(party => {
      const opt = document.createElement('option');
      opt.value = party;
      opt.textContent = party;
      partySelect.appendChild(opt);
    });

    // Render all components after data is loaded
    renderAll();

  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('politiciansList').innerHTML =
      `<p style="color:#f87171;grid-column:1/-1">Chyba při načítání dat: ${e.message}<br>
      <button class="btn btn-secondary" onclick="location.reload()">Zkusit znovu</button></p>`;
  }
}

// Start when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose for inline onclick handlers
window.showVotePopup = showVotePopup;
window.showPoliticianDetail = async (name) => {
  state.filters.politician = name;
  document.getElementById('politicianSearch').value = name;
  renderAll();
  document.getElementById('politiciansList')?.scrollIntoView({ behavior: 'smooth' });
};