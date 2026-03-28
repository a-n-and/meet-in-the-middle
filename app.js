'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const COLORS = ['#58a6ff','#f78166','#56d364','#d2a8ff','#ffa657','#79c0ff'];
const LABELS = ['A','B','C','D','E','F'];
const MAX_PEOPLE = 6;
const MIN_PEOPLE = 2;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM     = 'https://router.project-osrm.org/route/v1/driving';
const OVERPASS  = 'https://overpass-api.de/api/interpreter';

// ── State ──────────────────────────────────────────────────────────────────
let nextId = 0;
const people = [];          // { id, label, color, address, coords, marker }
let suggestionMarkers = [];
let routeLines = [];
let centroidMarker = null;
let activeCardIdx = -1;
let scoredPOIs = [];        // final ranked results

// ── DOM refs ───────────────────────────────────────────────────────────────
const peopleList     = document.getElementById('people-list');
const addBtn         = document.getElementById('add-person-btn');
const findBtn        = document.getElementById('find-btn');
const findBtnText    = document.getElementById('find-btn-text');
const findBtnSpinner = document.getElementById('find-btn-spinner');
const progressBar    = document.getElementById('progress-bar');
const errorBanner    = document.getElementById('error-banner');
const errorText      = document.getElementById('error-text');
const resultsSection = document.getElementById('results-section');
const resultsList    = document.getElementById('results-list');
const mapHint        = document.getElementById('map-overlay-hint');

// Progress step elements
const steps = {
  geocode: document.getElementById('step-geocode'),
  places:  document.getElementById('step-places'),
  routes:  document.getElementById('step-routes'),
  score:   document.getElementById('step-score'),
};

// ── Map init ───────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, attributionControl: true });
map.setView([20, 0], 2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

// ── Person card helpers ────────────────────────────────────────────────────
function personColor(idx) { return COLORS[idx % COLORS.length]; }
function personLabel(idx) { return LABELS[idx % LABELS.length]; }

function createPersonCard(person) {
  const div = document.createElement('div');
  div.className = 'person-card';
  div.dataset.id = person.id;
  div.style.setProperty('--person-color', person.color);

  div.innerHTML = `
    <div class="person-dot" style="background:${person.color}">${person.label}</div>
    <div class="person-input-wrap">
      <div class="person-label">Person ${person.label}</div>
      <input class="person-input" type="text" placeholder="City, address, or landmark…"
             autocomplete="off" spellcheck="false" value="${escHtml(person.address)}" />
      <div class="person-error"></div>
    </div>
    <button class="person-remove-btn" title="Remove" aria-label="Remove person ${person.label}">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </button>`;

  const input = div.querySelector('.person-input');
  input.addEventListener('input', () => {
    person.address = input.value.trim();
    clearPersonError(div);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') findBtn.click();
  });

  const removeBtn = div.querySelector('.person-remove-btn');
  removeBtn.addEventListener('click', () => removePerson(person.id));

  return div;
}

function addPerson(address = '') {
  if (people.length >= MAX_PEOPLE) return;
  const idx = people.length;
  const person = { id: nextId++, label: personLabel(idx), color: personColor(idx), address, coords: null, marker: null };
  people.push(person);
  const card = createPersonCard(person);
  peopleList.appendChild(card);
  syncPersonUI();
  if (!address) card.querySelector('.person-input').focus();
  return person;
}

function removePerson(id) {
  if (people.length <= MIN_PEOPLE) return;
  const idx = people.findIndex(p => p.id === id);
  if (idx === -1) return;
  const person = people[idx];
  if (person.marker) map.removeLayer(person.marker);
  people.splice(idx, 1);
  // Re-assign colors/labels
  people.forEach((p, i) => {
    p.label = personLabel(i);
    p.color = personColor(i);
  });
  rebuildPeopleCards();
  syncPersonUI();
}

function rebuildPeopleCards() {
  peopleList.innerHTML = '';
  people.forEach(p => peopleList.appendChild(createPersonCard(p)));
}

function syncPersonUI() {
  addBtn.disabled = people.length >= MAX_PEOPLE;
  document.querySelectorAll('.person-remove-btn').forEach(btn => {
    btn.style.visibility = people.length <= MIN_PEOPLE ? 'hidden' : 'visible';
  });
}

function setPersonError(personId, msg) {
  const card = peopleList.querySelector(`[data-id="${personId}"]`);
  if (!card) return;
  card.classList.add('has-error');
  card.querySelector('.person-error').textContent = msg;
}

function clearPersonError(card) {
  card.classList.remove('has-error');
  card.querySelector('.person-error').textContent = '';
}

function clearAllPersonErrors() {
  document.querySelectorAll('.person-card').forEach(clearPersonError);
}

// ── Utility ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function mean(arr)     { return arr.reduce((a,b) => a+b, 0) / arr.length; }
function variance(arr) { const m = mean(arr); return mean(arr.map(x => (x-m)**2)); }

function fmtMin(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}
function fmtKm(m) {
  if (m == null) return '';
  return m >= 1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ── Geocoding ──────────────────────────────────────────────────────────────
async function geocodeOne(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'MeetInTheMiddle/1.0' } });
  if (!resp.ok) throw new Error(`Geocoding server error: ${resp.status}`);
  const data = await resp.json();
  if (!data.length) throw new Error(`Could not find "${address}". Try a more specific address.`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

async function geocodeAll() {
  const coords = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p.address) { setPersonError(p.id, 'Please enter a location.'); throw new Error('validation'); }
    try {
      const c = await geocodeOne(p.address);
      p.coords = c;
      coords.push(c);
      placePersonMarker(p);
    } catch (e) {
      if (e.message === 'validation') throw e;
      setPersonError(p.id, e.message);
      throw new Error('validation');
    }
    if (i < people.length - 1) await sleep(1100); // Nominatim rate limit
  }
  return coords;
}

// ── Markers ────────────────────────────────────────────────────────────────
function personDivIcon(color, label) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:32px;height:32px;border-radius:50%;
      background:${color};border:3px solid rgba(255,255,255,0.9);
      display:flex;align-items:center;justify-content:center;
      color:rgba(0,0,0,0.75);font-weight:800;font-size:13px;
      box-shadow:0 3px 12px rgba(0,0,0,0.5);
      font-family:'Segoe UI',sans-serif;">${label}</div>`,
    iconSize: [32,32],
    iconAnchor: [16,16],
    popupAnchor: [0,-18],
  });
}

function poiDivIcon(rank, active) {
  const bg = active ? '#58a6ff' : '#1e2630';
  const border = active ? '#79c0ff' : 'rgba(255,255,255,0.25)';
  return L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;border-radius:50%;
      background:${bg};border:2.5px solid ${border};
      display:flex;align-items:center;justify-content:center;
      color:${active?'#0d1117':'#e6edf3'};font-weight:800;font-size:11px;
      box-shadow:0 2px 10px rgba(0,0,0,0.5);
      font-family:'Segoe UI',sans-serif;">${rank}</div>`,
    iconSize: [28,28],
    iconAnchor: [14,14],
    popupAnchor: [0,-16],
  });
}

function placePersonMarker(person) {
  if (person.marker) map.removeLayer(person.marker);
  person.marker = L.marker([person.coords.lat, person.coords.lng], { icon: personDivIcon(person.color, person.label) })
    .bindPopup(`<strong style="color:${person.color}">Person ${person.label}</strong><br>${person.coords.display.split(',').slice(0,3).join(', ')}`)
    .addTo(map);
}

// ── Centroid ───────────────────────────────────────────────────────────────
function calcCentroid(coords) {
  return {
    lat: mean(coords.map(c => c.lat)),
    lng: mean(coords.map(c => c.lng)),
  };
}

function placeCentroidMarker(centroid) {
  if (centroidMarker) map.removeLayer(centroidMarker);
  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:14px;height:14px;border-radius:50%;
      background:rgba(255,255,255,0.15);border:2px dashed rgba(255,255,255,0.4);
      box-shadow:0 0 0 3px rgba(255,255,255,0.07);"></div>`,
    iconSize: [14,14], iconAnchor: [7,7],
  });
  centroidMarker = L.marker([centroid.lat, centroid.lng], { icon, zIndexOffset: -10 })
    .bindPopup('<em style="color:#8b949e">Geographic midpoint</em>')
    .addTo(map);
}

// ── Overpass ───────────────────────────────────────────────────────────────
function buildOverpassQuery(lat, lng, radius) {
  return `[out:json][timeout:25];
(
  node["amenity"~"^(restaurant|cafe|pub|bar|fast_food|food_court|ice_cream|bakery|biergarten)$"]["name"](around:${radius},${lat},${lng});
  node["leisure"~"^(park|garden|playground)$"]["name"](around:${radius},${lat},${lng});
  way["leisure"~"^(park|garden)$"]["name"](around:${radius},${lat},${lng});
  relation["leisure"="park"]["name"](around:${radius},${lat},${lng});
);
out center 40;`;
}

async function queryOverpass(lat, lng, radius = 2000) {
  const query = buildOverpassQuery(lat, lng, radius);
  const resp = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!resp.ok) throw new Error(`Overpass API error: ${resp.status}`);
  const data = await resp.json();
  return parseOverpassResults(data);
}

function parseOverpassResults(data) {
  return data.elements.map(el => ({
    id: el.id,
    name: el.tags?.name || '',
    type: el.tags?.amenity || el.tags?.leisure || 'place',
    lat: el.lat ?? el.center?.lat,
    lng: el.lon ?? el.center?.lon,
  })).filter(p => p.lat && p.lng && p.name);
}

async function findPOIs(centroid) {
  let pois = await queryOverpass(centroid.lat, centroid.lng, 2000);
  if (pois.length < 5) {
    pois = await queryOverpass(centroid.lat, centroid.lng, 4000);
  }
  if (pois.length < 3) {
    pois = await queryOverpass(centroid.lat, centroid.lng, 8000);
  }
  if (pois.length === 0) throw new Error('No meeting places found nearby. Try locations in more urban areas.');
  return pois;
}

// ── OSRM Routing ───────────────────────────────────────────────────────────
async function routeOnce(from, to) {
  try {
    const url = `${OSRM}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    return { duration: data.routes[0].duration, distance: data.routes[0].distance };
  } catch { return null; }
}

async function routePeopleToPOI(poi) {
  return Promise.all(people.map(p => routeOnce(p.coords, poi)));
}

// ── Scoring ────────────────────────────────────────────────────────────────
function straightLineDists(poi) {
  return people.map(p => haversineKm(p.coords.lat, p.coords.lng, poi.lat, poi.lng) * 1000);
}

function scorePOI(routingResults, poi) {
  const valid = routingResults.filter(r => r !== null);
  let durations, distances, estimated = false;

  if (valid.length >= 2) {
    durations  = routingResults.map(r => r ? r.duration : null);
    distances  = routingResults.map(r => r ? r.distance : null);
  } else {
    // fall back to straight-line
    estimated = true;
    const dists = straightLineDists(poi);
    // assume ~40 km/h average
    durations  = dists.map(d => (d / 1000 / 40) * 3600);
    distances  = dists;
  }

  const validDur = durations.filter(d => d != null);
  const avgDur   = mean(validDur);
  const cv       = avgDur > 0 ? Math.sqrt(variance(validDur)) / avgDur : 0;
  const avgPen   = Math.min(avgDur / 1800, 1);
  const fairPen  = Math.min(cv, 1);
  const score    = Math.max(0, 1 - (0.6 * fairPen + 0.4 * avgPen));

  return { score, durations, distances, avgDurMin: avgDur/60, estimated };
}

// ── Route lines on map ─────────────────────────────────────────────────────
function drawRouteLines(poi) {
  clearRouteLines();
  people.forEach((p, i) => {
    const line = L.polyline(
      [[p.coords.lat, p.coords.lng], [poi.lat, poi.lng]],
      { color: p.color, weight: 2.5, opacity: 0.7, dashArray: '8 5' }
    ).addTo(map);
    routeLines.push(line);
  });
}

function clearRouteLines() {
  routeLines.forEach(l => map.removeLayer(l));
  routeLines = [];
}

// ── Progress UI ────────────────────────────────────────────────────────────
function setStep(key) {
  Object.entries(steps).forEach(([k, el]) => {
    const keys = Object.keys(steps);
    const keyIdx   = keys.indexOf(key);
    const thisIdx  = keys.indexOf(k);
    el.classList.toggle('done',   thisIdx < keyIdx);
    el.classList.toggle('active', thisIdx === keyIdx);
    el.classList.remove(thisIdx > keyIdx ? 'done' : '');
  });
}

function showProgress() {
  progressBar.hidden = false;
  Object.values(steps).forEach(el => el.classList.remove('done','active'));
}

function hideProgress() {
  progressBar.hidden = true;
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.hidden = true;
}

// ── Suggestion cards ───────────────────────────────────────────────────────
function scoreColor(score) {
  if (score >= 0.7) return '#3fb950';
  if (score >= 0.4) return '#d29922';
  return '#f85149';
}

function buildSuggestionCard(poi, rank, animated) {
  const pct = Math.round(poi.scoring.score * 100);
  const color = scoreColor(poi.scoring.score);

  const div = document.createElement('div');
  div.className = 'suggestion-card';
  if (animated) div.style.animationDelay = `${(rank-1) * 0.06}s`;

  const rankClass = rank <= 3 ? `rank-${rank}` : '';

  let personRowsHtml = people.map((p, i) => {
    const dur  = poi.scoring.durations[i];
    const dist = poi.scoring.distances[i];
    const shortAddr = p.address.split(',')[0];
    return `
      <div class="person-row">
        <div class="person-row-dot" style="background:${p.color}"></div>
        <div class="person-row-name" title="${escHtml(p.address)}">${escHtml(shortAddr)}</div>
        <div class="person-row-time">${fmtMin(dur)}</div>
        <div class="person-row-dist">${dist ? fmtKm(dist) : ''}</div>
      </div>`;
  }).join('');

  div.innerHTML = `
    <div class="card-top">
      <div class="rank-badge ${rankClass}">${rank}</div>
      <div class="card-name" title="${escHtml(poi.name)}">${escHtml(poi.name)}</div>
      <div class="type-chip">${escHtml(poi.type.replace(/_/g,' '))}</div>
    </div>
    <div class="fairness-row">
      <div class="fairness-label">Fairness</div>
      <div class="fairness-bar-bg">
        <div class="fairness-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="fairness-score-val" style="color:${color}">${pct}%</div>
    </div>
    <div class="person-rows">${personRowsHtml}</div>
    ${poi.scoring.estimated ? '<div style="font-size:0.68rem;color:var(--text-muted);margin-top:6px;">⚠ Estimated (road routing unavailable)</div>' : ''}
  `;

  div.addEventListener('mouseenter', () => activateCard(rank - 1));
  div.addEventListener('mouseleave', () => deactivateCard());
  div.addEventListener('click',      () => activateCard(rank - 1, true));

  return div;
}

function activateCard(idx, panMap = false) {
  activeCardIdx = idx;
  const poi = scoredPOIs[idx];
  if (!poi) return;

  // Update card styles
  document.querySelectorAll('.suggestion-card').forEach((c, i) => {
    c.classList.toggle('active', i === idx);
  });

  // Update marker icons
  suggestionMarkers.forEach((m, i) => m.setIcon(poiDivIcon(i+1, i === idx)));

  // Draw route lines
  drawRouteLines(poi);

  if (panMap) {
    const bounds = L.latLngBounds(
      people.map(p => [p.coords.lat, p.coords.lng]).concat([[poi.lat, poi.lng]])
    );
    map.fitBounds(bounds, { padding: [40, 40] });
    suggestionMarkers[idx]?.openPopup();
  }
}

function deactivateCard() {
  activeCardIdx = -1;
  document.querySelectorAll('.suggestion-card').forEach(c => c.classList.remove('active'));
  suggestionMarkers.forEach((m, i) => m.setIcon(poiDivIcon(i+1, false)));
  clearRouteLines();
}

function clearSuggestionMarkers() {
  suggestionMarkers.forEach(m => map.removeLayer(m));
  suggestionMarkers = [];
}

function renderResults(pois) {
  resultsList.innerHTML = '';
  clearSuggestionMarkers();

  pois.forEach((poi, i) => {
    const rank = i + 1;
    const card = buildSuggestionCard(poi, rank, true);
    resultsList.appendChild(card);

    const marker = L.marker([poi.lat, poi.lng], { icon: poiDivIcon(rank, false) })
      .bindPopup(`<strong>#${rank} — ${poi.name}</strong><br>${poi.type.replace(/_/g,' ')} &nbsp;·&nbsp; Fairness: ${Math.round(poi.scoring.score*100)}%`)
      .addTo(map);

    marker.on('click', () => activateCard(i, false));
    suggestionMarkers.push(marker);
  });

  resultsSection.hidden = false;
}

// ── Main orchestration ─────────────────────────────────────────────────────
async function runSearch() {
  clearAllPersonErrors();
  hideError();
  resultsSection.hidden = true;
  clearSuggestionMarkers();
  clearRouteLines();
  if (centroidMarker) { map.removeLayer(centroidMarker); centroidMarker = null; }
  mapHint.classList.add('hidden');
  scoredPOIs = [];

  // Validate
  const anyEmpty = people.some(p => !p.address);
  if (anyEmpty) {
    people.forEach(p => { if (!p.address) setPersonError(p.id, 'Please enter a location.'); });
    return;
  }

  // UI: loading state
  findBtn.disabled = true;
  findBtnText.hidden = true;
  findBtnSpinner.hidden = false;
  showProgress();

  try {
    // Step 1: Geocode
    setStep('geocode');
    const coords = await geocodeAll();

    // Check extreme distances (warn if > 2000 km apart)
    for (let i = 0; i < coords.length - 1; i++) {
      for (let j = i+1; j < coords.length; j++) {
        if (haversineKm(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng) > 2000) {
          showError('Warning: Locations are very far apart. Meeting spot suggestions may not be practical.');
        }
      }
    }

    // Step 2: Centroid + Places
    setStep('places');
    const centroid = calcCentroid(coords);
    placeCentroidMarker(centroid);

    const pois = await findPOIs(centroid);

    // Pre-filter by geometric fairness (discard if max/min straight-line ratio > 3)
    const filtered = pois.filter(poi => {
      const dists = people.map(p => haversineKm(p.coords.lat, p.coords.lng, poi.lat, poi.lng));
      const ratio = Math.max(...dists) / (Math.min(...dists) || 0.001);
      return ratio <= 4;
    });

    const candidates = (filtered.length >= 5 ? filtered : pois).slice(0, 15);

    // Step 3: Routes
    setStep('routes');
    const routed = [];
    for (let i = 0; i < candidates.length; i++) {
      const poi = candidates[i];
      const results = await routePeopleToPOI(poi);
      const scoring = scorePOI(results, poi);
      routed.push({ ...poi, scoring });
      if (i < candidates.length - 1) await sleep(200);
    }

    // Step 4: Score & rank
    setStep('score');
    await sleep(300); // brief visual hold so user sees this step
    scoredPOIs = routed.sort((a, b) => b.scoring.score - a.scoring.score).slice(0, 5);

    // Fit map to all people
    const allLatLng = people.map(p => [p.coords.lat, p.coords.lng]);
    map.fitBounds(L.latLngBounds(allLatLng), { padding: [60, 60] });

    renderResults(scoredPOIs);

  } catch (e) {
    if (e.message !== 'validation') showError(e.message || 'Something went wrong. Please try again.');
  } finally {
    findBtn.disabled = false;
    findBtnText.hidden = false;
    findBtnSpinner.hidden = true;
    hideProgress();
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
addBtn.addEventListener('click', () => addPerson());
findBtn.addEventListener('click', runSearch);

// Start with 2 people
addPerson();
addPerson();
