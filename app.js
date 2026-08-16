/* Philadelphia Time Machine
 *
 * A scrubbable 3D model of Philadelphia's historic core, 1650 -> 2026.
 *
 * Basemaps are real georeferenced historic maps and aerial photographs.
 * Buildings are the City's own LiDAR footprints, dated from assessment records,
 * revealed as the timeline passes their construction year.
 */

'use strict';

const AGOL = 'https://tiles.arcgis.com/tiles/fLeGjb7u4uXqeF9q/arcgis/rest/services';
const WARPER = 'https://mapwarper.net/maps/tile';

const MIN_YEAR = 1650;
const MAX_YEAR = 2026;
const GROW_YEARS = 2.5;   // how long a building takes to rise once it is built
const FADE_YEARS = 5;     // crossfade window between two historic basemaps

// Bring the next historic map online this many years early, at zero opacity,
// so its tiles are already decoded when the crossfade starts. Mapwarper sheets
// take about a second per tile; without the lead-in the new map dissolves in
// half-drawn, which is what made era changes look glitchy.
const PRELOAD_YEARS = 30;

// Ceiling on how often the extrusion heights are recomputed. Height is
// data-driven, so every update re-evaluates and re-uploads a vertex attribute
// for all 66,698 buildings. At 34 years/second the old per-quarter-year rule
// fired ~140 times a second; twelve looks the same and costs a tenth as much.
const HEIGHT_INTERVAL_MS = 80;

// Never render at full Retina density. 66,698 extruded solids at a 2x pixel
// ratio means filling four times the pixels for a difference you cannot see on
// a building edge, and it was the bulk of the GPU cost. This is the ceiling;
// the frame-rate watcher drops to 1x if even this is too much.
const MAX_QUALITY = Math.min(window.devicePixelRatio || 1, 1.5);

/* ── the eras ──────────────────────────────────────────────────────────────
 * Every entry with a `layer` is a genuine georeferenced document. `null`
 * means we have no survey map for that period and say so plainly.
 */
const ERAS = [
  {
    year: MIN_YEAR, kicker: 'Before the survey', title: 'Coaquannock',
    body: 'The Lenape called this neck of land between the Delaware and the Schuylkill ' +
          '"Coaquannock" — the grove of tall pines. Dense hardwood forest, tidal marsh ' +
          'along both rivers, and creeks that are now buried under the street grid.',
    layer: null,
    source: 'Reconstruction. No survey map of this site exists. Terrain is real ' +
            '(USGS/SRTM elevation); the woodland is an impression, not a document.'
  },
  {
    year: 1682, kicker: 'The plan', title: "Holme's Green Country Town",
    body: 'Thomas Holme surveys William Penn\'s city: a gridiron between two rivers with ' +
          'five open squares. It is one of the first planned cities in the colonies, and ' +
          'the grid you can still walk today.',
    layer: { type: 'warper', id: 68078 },
    source: 'Thomas Holme, <b>Portraiture of the City of Philadelphia</b>, 1682/1683. ' +
            'Georeferenced via Mapwarper.'
  },
  {
    year: 1776, kicker: 'Revolution', title: 'Capital of a New Republic',
    body: 'The largest city in British America and the seat of the Continental Congress. ' +
          'Building is still packed against the Delaware — the grid west of 7th Street is ' +
          'largely orchards and pasture.',
    layer: { type: 'warper', id: 101153 },
    source: '<b>Philadelphia, 1776.</b> Georeferenced via Mapwarper. Note the sheet only ' +
            'covers the built-up wards near the Delaware — that was the whole city.'
  },
  {
    year: 1796, kicker: 'The federal decade', title: 'Hills Surveys the Improved Parts',
    body: 'Philadelphia is the capital of the United States. John Hills maps the city and ' +
          'its environs, carefully distinguishing the "improved" built-up blocks from the ' +
          'open country still inside Penn\'s grid.',
    layer: { type: 'warper', id: 105577 },
    source: 'John Hills, <b>This plan of the city of Philadelphia and its environs</b>, ' +
            '1796. Library of Congress (g3824p.ct001369), georeferenced via Mapwarper.'
  },
  {
    year: 1814, kicker: 'Early republic', title: 'Filling the Grid',
    body: 'The city spreads west and north. Districts that are still legally separate — ' +
          'Northern Liberties, Southwark, Spring Garden — are thickening into continuous ' +
          'urban fabric.',
    layer: { type: 'warper', id: 32067 },
    source: '<b>Map of Philadelphia, 1814.</b> Georeferenced via Mapwarper.'
  },
  {
    year: 1843, kicker: 'Steam and rail', title: 'The Workshop of the World',
    body: 'Railroads arrive, mills line the creeks, and row housing marches outward block ' +
          'by block. Philadelphia is becoming the most diversified manufacturing city on ' +
          'the continent.',
    layer: { type: 'warper', id: 32098 },
    source: '<b>Map of Philadelphia, 1843.</b> Georeferenced via Mapwarper.'
  },
  {
    year: 1860, kicker: 'Consolidation', title: 'Hexamer & Locher',
    body: 'The 1854 Act of Consolidation swallowed the surrounding districts, making the ' +
          'city coextensive with the county overnight. This atlas records the result, ' +
          'building by building, in fire-insurance detail.',
    layer: { type: 'agol', id: 'HistoricHexamerLocherAtlas_1860' },
    source: '<b>Hexamer & Locher Atlas of Philadelphia, 1860.</b> Greater Philadelphia ' +
            'GeoHistory Network, hosted by the City of Philadelphia.'
  },
  {
    year: 1875, kicker: 'Centennial', title: 'Hopkins City Atlas',
    body: 'On the eve of the Centennial Exposition. Streetcar lines are pulling ' +
          'development past Broad Street, and the new City Hall is rising at Penn Square.',
    layer: { type: 'agol', id: 'HistoricGMHopkinsAtlas_1875' },
    source: '<b>G. M. Hopkins City Atlas of Philadelphia, 1875.</b> Greater Philadelphia ' +
            'GeoHistory Network, hosted by the City of Philadelphia.'
  },
  {
    year: 1895, kicker: 'Industrial peak', title: 'Bromley Atlas',
    body: 'A city of two million rooms in row houses. Textile mills in Kensington, ' +
          'locomotives at Baldwin, refineries on the rivers — and the densest ' +
          'working-class homeownership in America.',
    layer: { type: 'agol', id: 'HistoricBromleyAtlas_1895' },
    source: '<b>G. W. Bromley Atlas of the City of Philadelphia, 1895.</b> Greater ' +
            'Philadelphia GeoHistory Network, hosted by the City of Philadelphia.'
  },
  {
    year: 1910, kicker: 'High tide', title: 'Bromley, Twenty Years On',
    body: 'The Parkway is being cut diagonally through the grid toward Fairmount. ' +
          'Subway construction begins under Market Street. The row-house city reaches ' +
          'its greatest extent.',
    layer: { type: 'agol', id: 'HistoricBromleyAtlas_1910' },
    source: '<b>G. W. Bromley Atlas of the City of Philadelphia, 1910.</b> Greater ' +
            'Philadelphia GeoHistory Network, hosted by the City of Philadelphia.'
  },
  {
    year: 1928, kicker: 'From the air', title: 'The First Aerial Survey',
    body: 'The camera replaces the surveyor. The Benjamin Franklin Bridge is two years ' +
          'old, City Hall is still the tallest thing in town, and every roof in the core ' +
          'is photographed for the first time.',
    layer: { type: 'agol', id: 'CityImagery_1928_RPF' },
    source: '<b>Aerial photography, 1928</b> (Regional Planning Federation). ' +
            'City of Philadelphia.'
  },
  {
    year: 1942, kicker: 'Wartime', title: 'Land Use Survey',
    body: 'Philadelphia at full industrial mobilisation, colour-coded block by block: ' +
          'residential, commercial, industrial. The last moment before the freeways and ' +
          'the great clearances.',
    layer: { type: 'agol', id: 'HistoricLandUse_1942' },
    source: '<b>Land use survey, 1942.</b> Greater Philadelphia GeoHistory Network, ' +
            'hosted by the City of Philadelphia.'
  },
  {
    year: 1959, kicker: 'Renewal', title: 'Bulldozers and Expressways',
    body: 'Society Hill is being cleared and rebuilt, Independence Mall is carved out of ' +
          'three demolished blocks, and the Schuylkill Expressway opens. More of old ' +
          'Philadelphia is lost in twenty years than in the previous century.',
    layer: { type: 'agol', id: 'CityImagery_1959_DVRPC' },
    source: '<b>Aerial photography, 1959</b> (DVRPC). City of Philadelphia.'
  },
  {
    year: 1975, kicker: 'Deindustrialisation', title: 'After the Factories',
    body: 'The mills are closing. Population is falling from its 1950 peak of 2.07 ' +
          'million. Whole industrial districts empty out — and the vacant land they leave ' +
          'shapes the city for the next fifty years.',
    layer: { type: 'agol', id: 'CityImagery_1975_DVRPC' },
    source: '<b>Aerial photography, 1975</b> (DVRPC). City of Philadelphia.'
  },
  {
    year: 1996, kicker: 'Turning', title: 'Breaking the Gentlemen\'s Agreement',
    body: 'One Liberty Place broke the unwritten rule against building above William ' +
          'Penn\'s hat in 1987. A decade later the skyline is unrecognisable, and Center ' +
          'City is filling with residents again.',
    layer: { type: 'agol', id: 'CityImagery_1996_6in' },
    source: '<b>Aerial photography, 1996</b> (6-inch). City of Philadelphia.'
  },
  {
    year: 2025, kicker: 'Today', title: 'The City Now',
    body: 'Three-inch aerial imagery of the modern city. The Comcast Technology Center ' +
          'tops out at 342 metres — but underneath it, Holme\'s 1682 grid is still ' +
          'exactly where he drew it.',
    layer: { type: 'agol', id: 'CityImagery_2025_3in' },
    source: '<b>Aerial photography, 2025</b> (3-inch). City of Philadelphia.'
  }
];

/* Real, dated landmarks. Shown once the timeline reaches them. */
const LANDMARKS = [
  { y: 1732, t: 'Pennsylvania State House begun', s: 'Independence Hall', c: [-75.1500, 39.9489] },
  { y: 1751, t: 'Pennsylvania Hospital founded', s: 'first in the colonies', c: [-75.1560, 39.9436] },
  { y: 1776, t: 'Declaration of Independence adopted', s: '4 July', c: [-75.1500, 39.9489] },
  { y: 1790, t: 'Philadelphia becomes US capital', s: 'Congress Hall', c: [-75.1505, 39.9487] },
  { y: 1829, t: 'Eastern State Penitentiary opens', s: 'the radial plan', c: [-75.1725, 39.9683] },
  { y: 1876, t: 'Centennial Exposition', s: "America's first World's Fair", c: [-75.1900, 39.9790] },
  { y: 1901, t: 'City Hall completed', s: 'tallest habitable building on earth', c: [-75.1636, 39.9524] },
  { y: 1926, t: 'Benjamin Franklin Bridge opens', s: 'longest suspension span', c: [-75.1400, 39.9530] },
  { y: 1932, t: 'PSFS Building', s: 'first modern skyscraper in America', c: [-75.1610, 39.9515] },
  { y: 1987, t: 'One Liberty Place', s: "passes William Penn's hat", c: [-75.1680, 39.9535] },
  { y: 2018, t: 'Comcast Technology Center', s: '342 m — tallest in the city', c: [-75.1700, 39.9550] }
];

/* ── state ─────────────────────────────────────────────────────────────── */
const S = {
  year: 1682,
  playing: false,
  speed: 14,          // years per second
  showBuildings: true,
  terrain: false,
  orbit: false,
  histOpacity: 0.85,
  bldgOpacity: 0.92,
  colorMode: 'age',
  lastFiltered: -1,
  lastHeightAt: 0,
  lastHeightYear: -1,
  shownYear: -1,
  eraIndex: -1,
  eraVis: [],        // last visibility written per era layer
  eraOpa: [],        // last opacity written per era layer
  wildOn: null,
  quality: 1,        // render scale actually in use
  frameTimes: []
};

let map;
let hist = null;   // cumulative stats by year

const $ = (id) => document.getElementById(id);

/* ── style ─────────────────────────────────────────────────────────────── */
function eraSourceId(i) { return `era-${i}`; }

function buildStyle() {
  const sources = {
    base: {
      type: 'raster', tileSize: 256, maxzoom: 20,
      tiles: ['https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a>, &copy; OpenStreetMap contributors'
    },
    labels: {
      type: 'raster', tileSize: 256, maxzoom: 20,
      tiles: ['https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png']
    },
    dem: {
      type: 'raster-dem', tileSize: 256, maxzoom: 15, encoding: 'terrarium',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> / USGS'
    },
    water: {
      type: 'geojson', data: 'data/water.geojson',
      attribution: 'Hydrology &amp; historic streams: City of Philadelphia'
    }
  };

  const layers = [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0a09' } },
    { id: 'base', type: 'raster', source: 'base',
      paint: { 'raster-opacity': 0.9, 'raster-saturation': -0.25 } },
    // ── pre-survey era only ──────────────────────────────────────────────
    // The modern basemap is switched off entirely for this era: leaving the
    // 2020s street grid under a green wash is precisely the thing the era is
    // meant to show the absence of. What remains is real: terrain relief, the
    // two rivers, and the creeks the City records as since buried.
    { id: 'forest', type: 'background', layout: { visibility: 'none' },
      paint: { 'background-color': '#16301d' } },
    { id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.7, 'hillshade-shadow-color': '#04120a',
               'hillshade-highlight-color': '#5c8f63', 'hillshade-accent-color': '#0c2213' } },
    { id: 'wild-water', type: 'fill', source: 'water',
      filter: ['==', ['get', 'kind'], 'water'], layout: { visibility: 'none' },
      paint: { 'fill-color': '#12303f', 'fill-opacity': 0.95 } },
    { id: 'wild-streams', type: 'line', source: 'water',
      filter: ['==', ['get', 'kind'], 'stream'], layout: { visibility: 'none' },
      paint: {
        'line-color': '#2f6d7a',
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 1.8, 17, 5]
      } }
  ];

  // One raster layer per historic document, all hidden until needed.
  ERAS.forEach((era, i) => {
    if (!era.layer) return;
    const sid = eraSourceId(i);
    sources[sid] = era.layer.type === 'agol'
      ? { type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: [`${AGOL}/${era.layer.id}/MapServer/tile/{z}/{y}/{x}`],
          attribution: 'Historic maps: City of Philadelphia / Greater Philadelphia GeoHistory Network' }
      : { type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: [`${WARPER}/${era.layer.id}/{z}/{x}/{y}.png`],
          attribution: 'Historic maps: <a href="https://mapwarper.net">Mapwarper</a>' };

    layers.push({
      id: sid, type: 'raster', source: sid,
      layout: { visibility: 'none' },
      // The crossfade between eras is driven by raster-opacity below. Letting
      // MapLibre also fade each tile in as it arrives double-fades the sheet
      // and makes it shimmer during a transition.
      paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 }
    });
  });

  layers.push({ id: 'labels', type: 'raster', source: 'labels',
                paint: { 'raster-opacity': 0.42 } });

  return { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
           sources, layers };
}

/* ── building paint expressions ────────────────────────────────────────── */

/* Height rises from 0 over GROW_YEARS once the build year passes. */
function heightExpr(year) {
  return ['case',
    ['>', ['get', 'y'], year], 0,
    ['*', ['get', 'h'],
      ['min', 1, ['/', ['+', ['-', year, ['get', 'y']], 0.2], GROW_YEARS]]]
  ];
}

/* Colour depends only on the building, never on the timeline position.
 *
 * It used to flare newly-built blocks, which meant re-uploading a colour
 * attribute for every building on every tick — the single most expensive thing
 * the timeline did. Buildings still announce themselves by rising out of the
 * ground, and this now gets written once instead of a hundred times a second. */
function colorExpr(mode) {
  let base;
  if (mode === 'height') {
    base = ['interpolate', ['linear'], ['get', 'h'],
      3, '#3f4d58', 12, '#5d7286', 30, '#8fa2ac', 70, '#c2b79a', 150, '#e8c67d', 300, '#f6e2b0'];
  } else if (mode === 'plain') {
    base = '#9aa7b0';
  } else {
    base = ['interpolate', ['linear'], ['get', 'y'],
      1700, '#8c4a2f', 1800, '#b46a33', 1875, '#d69a4a', 1925, '#c8b48c',
      1960, '#8d99a6', 1990, '#6a8ba3', 2010, '#5aa3c4', 2026, '#7fd4e8'];
  }
  return base;
}

function applyColorMode() {
  if (!map || !map.getLayer('buildings')) return;
  try {
    map.setPaintProperty('buildings', 'fill-extrusion-color', colorExpr(S.colorMode));
  } catch (err) { /* style not ready yet */ }
}

function applyYear(force) {
  if (!map || !map.getLayer('buildings')) return;

  const now = performance.now();
  const yearInt = Math.floor(S.year);

  // A zero-height extrusion is still geometry: it writes depth and blacks out
  // whatever is behind it, so hiding a not-yet-built building needs a filter,
  // not a height of zero. Filters re-run tile layout, so they step in whole
  // years; the height expression carries the smooth growth in between.
  const needFilter = force || yearInt !== S.lastFiltered;
  const needHeight = force ||
    (now - S.lastHeightAt >= HEIGHT_INTERVAL_MS && S.year !== S.lastHeightYear);
  if (!needFilter && !needHeight) return;

  // Style mutations are illegal until the style itself has parsed. Don't gate
  // on isStyleLoaded() — that also waits for every source's tiles, which never
  // arrive while the tab is unrendered, and would freeze the timeline. Just
  // attempt it and let the next call retry.
  try {
    if (needHeight) {
      map.setPaintProperty('buildings', 'fill-extrusion-height', heightExpr(S.year));
      S.lastHeightAt = now;
      S.lastHeightYear = S.year;
    }
    if (needFilter) {
      map.setFilter('buildings', ['<=', ['get', 'y'], yearInt]);
      S.lastFiltered = yearInt;
    }
  } catch (err) { /* style not ready yet */ }
}

/* ── era handling ──────────────────────────────────────────────────────── */
function eraIndexFor(year) {
  let i = 0;
  for (let k = 0; k < ERAS.length; k++) if (year >= ERAS[k].year) i = k;
  return i;
}

function applyEraLayers() {
  if (!map) return;
  try {
    applyEraLayersUnsafe();
  } catch (err) { /* style not parsed yet; the next setYear retries */ }
}

function applyEraLayersUnsafe() {
  const i = eraIndexFor(S.year);
  const era = ERAS[i];
  const next = ERAS[i + 1];

  // The active document is fully opaque for most of its span, then dissolves
  // into the next one over the FADE_YEARS approaching that document's date.
  // (Fading *in* at the start year would leave an era invisible on its own
  // opening frame, which is exactly the year people scrub to.)
  let until = Infinity;
  let u = 0;
  if (next) {
    until = next.year - S.year;
    if (until < FADE_YEARS) u = Math.max(0, Math.min(1, 1 - until / FADE_YEARS));
  }
  // Switch the next sheet on early and transparent so it is fully decoded
  // before it starts to show. Tying visibility to opacity > 0 instead meant a
  // map began loading at the exact moment it began appearing.
  const preloadNext = !!next && until < PRELOAD_YEARS;

  ERAS.forEach((e, k) => {
    const id = eraSourceId(k);
    if (!e.layer || !map.getLayer(id)) return;

    let o = 0;
    let vis = 'none';
    if (k === i) { o = 1 - u; vis = 'visible'; }
    else if (k === i + 1 && preloadNext) { o = u; vis = 'visible'; }
    o *= S.histOpacity;

    // Only write what actually changed. Re-setting visibility drops a raster
    // layer's tiles and re-fetches them on the way back, which is a visible
    // flash; and every redundant paint write is work for nothing.
    if (S.eraVis[k] !== vis) {
      map.setLayoutProperty(id, 'visibility', vis);
      S.eraVis[k] = vis;
    }
    if (vis === 'visible' && Math.abs((S.eraOpa[k] ?? -1) - o) > 0.004) {
      map.setPaintProperty(id, 'raster-opacity', o);
      S.eraOpa[k] = o;
    }
  });

  // Pre-survey woodland treatment: swap the modern city out for terrain,
  // rivers and buried creeks.
  const wild = !era.layer;
  if (S.wildOn !== wild) {
    S.wildOn = wild;
    const wildOnly = wild ? 'visible' : 'none';
    ['forest', 'hillshade', 'wild-water', 'wild-streams'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wildOnly);
    });
    map.setLayoutProperty('base', 'visibility', wild ? 'none' : 'visible');
    map.setPaintProperty('labels', 'raster-opacity', wild ? 0 : 0.42);
  }

  if (i !== S.eraIndex) {
    S.eraIndex = i;
    renderEraCard(era);
  }
}

function renderEraCard(era) {
  const card = $('era-card');
  $('era-kicker').textContent = era.kicker;
  $('era-title').textContent = era.title;
  $('era-body').textContent = era.body;
  $('era-source').innerHTML = era.source;
  $('year-sub').textContent = era.kicker;
  card.classList.remove('swap');
  void card.offsetWidth;     // restart the animation
  card.classList.add('swap');
}

/* ── stats ─────────────────────────────────────────────────────────────── */
function updateStats() {
  if (!hist) return;
  const i = Math.max(0, Math.min(hist.cumulative.length - 1, Math.round(S.year) - hist.minYear));
  $('stat-buildings').textContent = hist.cumulative[i].toLocaleString();

  let dec = 0;
  for (let k = Math.max(0, i - 9); k <= i; k++) dec += hist.built[k];
  $('stat-new').textContent = dec.toLocaleString();

  const h = hist.tallest[i];
  $('stat-tall').textContent = h > 0
    ? `${Math.round(h)} m` + (hist.tallestName[i] ? ` · ${hist.tallestName[i].slice(0, 22)}` : '')
    : '—';
}

/* ── timeline ──────────────────────────────────────────────────────────── */
function drawTicks() {
  const box = $('ticks');
  box.innerHTML = '';
  const span = MAX_YEAR - MIN_YEAR;
  ERAS.forEach((e) => {
    if (e.year <= MIN_YEAR) return;
    const d = document.createElement('div');
    d.className = 'tick major';
    d.style.left = ((e.year - MIN_YEAR) / span * 100) + '%';
    d.title = `${e.year} — ${e.title}`;
    box.appendChild(d);
  });
  LANDMARKS.forEach((l) => {
    const d = document.createElement('div');
    d.className = 'tick';
    d.style.left = ((l.y - MIN_YEAR) / span * 100) + '%';
    d.title = `${l.y} — ${l.t}`;
    box.appendChild(d);
  });
}

function setYear(y, fromSlider) {
  S.year = Math.max(MIN_YEAR, Math.min(MAX_YEAR, y));

  // The readouts only ever show a whole year, so touching them 60 times a
  // second to display the same number is pure layout thrash.
  const shown = Math.round(S.year);
  if (shown !== S.shownYear) {
    S.shownYear = shown;
    $('year').textContent = shown;
    if (!fromSlider) $('slider').value = shown;
    updateStats();
  }

  applyYear(false);
  applyEraLayers();
}

const PLAY_ICON = 'M8 5v14l11-7z';
const PAUSE_ICON = 'M6 5h4v14H6zm8 0h4v14h-4z';

function setPlaying(on) {
  S.playing = on;
  $('play-icon').firstElementChild.setAttribute('d', on ? PAUSE_ICON : PLAY_ICON);
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) startLoop(); else stopLoopIfIdle();
}

/* The dated landmarks are no longer drawn on the map. They were glowing orange
 * markers, and MapLibre reprojects every marker's DOM position on every single
 * frame — eleven of them made the map more expensive to render and cluttered
 * the view. They survive as tick marks under the timeline, where hovering a
 * mark still names the event. */

/* ── sources list ──────────────────────────────────────────────────────── */
function renderSources() {
  $('src-list').innerHTML = ERAS.map((e) => `
    <div class="src-row">
      <div class="src-yr">${e.layer ? e.year : 'pre-1682'}</div>
      <div class="src-t"><span class="src-title">${e.title}</span>${e.source}</div>
    </div>`).join('');
}

/* ── data load ─────────────────────────────────────────────────────────── */

/* Wait until MapLibre has fetched, parsed and tiled the building source.
 * The geometry never touches the main thread: handing MapLibre a URL lets it
 * do all of that inside its worker. (Fetching and JSON.parsing 22 MB here
 * instead froze the page for ~15 s before anything appeared.) */
/* Poll a condition instead of waiting on a MapLibre event.
 *
 * The events here are genuinely racy: styledata fires while isStyleLoaded() is
 * still false and then may never fire again, which hangs a listener attached a
 * moment too late. Polling costs nothing at 60 ms and cannot miss an edge.
 * The timeout guarantees the splash screen always goes away. */
function waitFor(predicate, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (predicate()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate() || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 60);
  });
}

function whenSourceReady(id, timeoutMs = 25000) {
  return waitFor(() => !!map.getSource(id) && map.isSourceLoaded(id), timeoutMs);
}

/* Run `fn` until it completes without throwing. Used for style mutations,
 * which are only legal in windows we cannot reliably predict. */
async function retryUntil(fn) {
  // No deadline. MapLibre finishes loading a style inside an animation frame,
  // and a background tab gets no animation frames at all — so in a background
  // tab this legitimately cannot succeed until the user looks at it. Giving up
  // would leave them with a permanently broken map on return.
  for (;;) {
    try {
      fn();
      return true;
    } catch (err) { /* not legal yet */ }
    map.triggerRepaint();
    await new Promise((r) => setTimeout(r, 120));
  }
}

/* ── boot ──────────────────────────────────────────────────────────────── */
async function main() {
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: [-75.1520, 39.9500],
    zoom: 14.4,
    pitch: 58,
    bearing: -20,
    maxPitch: 80,
    antialias: true,
    pixelRatio: MAX_QUALITY,
    // Nothing here is animated by the map itself, and the default 300 ms
    // cross-tile fade is what makes a historic sheet shimmer as tiles land.
    fadeDuration: 0,
    attributionControl: { compact: true }
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  // The container can settle to its real size after the map is constructed
  // (panel layout, window resize). Without this the canvas stays at whatever
  // size it saw first and only part of the viewport is ever painted.
  new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));

  try {
    const res = await fetch('data/stats.json');
    if (!res.ok) throw new Error(`stats.json: HTTP ${res.status}`);
    hist = await res.json();
  } catch (err) {
    $('loader-msg').textContent =
      'Could not load data — run  python3 build/fetch_data.py';
    console.error(err);
    return;
  }

  $('loader-fill').style.width = '45%';
  $('loader-msg').textContent = `Placing ${hist.total.toLocaleString()} buildings…`;

  // Adding the buildings layer needs a loaded style, but "loaded" is a moving
  // target: MapLibre finalises style load during a render pass, and any source
  // that finishes in an async gap flips it dirty again (addSource then throws
  // "Style is not done loading"). Rather than assume one clean window exists,
  // keep trying until it takes. In a normal browser this succeeds first go.
  await retryUntil(() => {
    // Idempotent: a retry happens after addSource has already succeeded and
    // only addLayer threw, and re-adding a source is itself an error.
    if (!map.getSource('buildings')) {
      map.addSource('buildings', {
        type: 'geojson',
        data: 'data/buildings.geojson',
        // Keep the tile pyramid shallow and the buffers small: this is one big
        // static layer, and the defaults spend a lot of worker time on detail
        // that never shows at these zooms.
        maxzoom: 16,
        buffer: 32,
        tolerance: 0.5
      });
    }
    if (map.getLayer('buildings')) return;
    map.addLayer({
      id: 'buildings',
      type: 'fill-extrusion',
      source: 'buildings',
      paint: {
        'fill-extrusion-color': colorExpr(S.colorMode),
        'fill-extrusion-height': heightExpr(S.year),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': S.bldgOpacity,
        'fill-extrusion-vertical-gradient': true
      }
    }, 'labels');
  });

  drawTicks();
  renderSources();
  setYear(1682);
  applyYear(true);
  wireUI();

  await whenSourceReady('buildings');

  // setYear above may have been skipped by the style guards while the source
  // was loading, leaving no era layer switched on. Keep nudging until the
  // opening year has actually been applied, then stop.
  S.eraIndex = -1;
  const heal = setInterval(() => {
    if (S.eraIndex !== -1) return clearInterval(heal);
    setYear(S.year);
    applyYear(true);
  }, 200);
  setTimeout(() => clearInterval(heal), 20000);

  $('loader-fill').style.width = '100%';
  $('loader-msg').textContent = 'Ready';
  setTimeout(() => $('loader').classList.add('done'), 300);
}

/* ── animation loop ────────────────────────────────────────────────────── */

/* The loop only runs while something is actually moving.
 *
 * It used to call requestAnimationFrame unconditionally, so the page woke up
 * sixty times a second forever — burning CPU on a map that was sitting still.
 * Now a paused, unorbited map costs nothing. */
let last = performance.now();
let rafId = null;

function startLoop() {
  if (rafId !== null) return;
  last = performance.now();
  S.frameTimes.length = 0;
  rafId = requestAnimationFrame(tick);
}

/* Drop the queued frame the moment nothing needs animating, rather than
 * letting it fire once more to discover that for itself. */
function stopLoopIfIdle() {
  if (S.playing || S.orbit || rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (S.playing) {
    let y = S.year + S.speed * dt;
    if (y >= MAX_YEAR) { y = MAX_YEAR; setPlaying(false); }
    setYear(y);
  }
  if (S.orbit) map.setBearing(map.getBearing() + 4 * dt);

  watchFrameRate(dt);

  rafId = (S.playing || S.orbit) ? requestAnimationFrame(tick) : null;
}

/* If the machine cannot hold a smooth rate while animating, render at fewer
 * device pixels. On a Retina display this is the largest single lever there
 * is: dropping from 2x to 1x quarters the pixels the extrusions have to fill. */
function watchFrameRate(dt) {
  const t = S.frameTimes;
  t.push(dt);
  if (t.length < 45) return;

  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  t.length = 0;

  if (avg > 1 / 34 && S.quality > 1) setQuality(1);
  else if (avg < 1 / 55 && S.quality < MAX_QUALITY) setQuality(MAX_QUALITY);
}

function setQuality(q) {
  if (q === S.quality || !map.setPixelRatio) return;
  S.quality = q;
  map.setPixelRatio(q);
}

/* ── UI wiring ─────────────────────────────────────────────────────────── */
function wireUI() {
  $('play').addEventListener('click', () => {
    if (!S.playing && S.year >= MAX_YEAR) setYear(MIN_YEAR);
    setPlaying(!S.playing);
  });

  $('slider').addEventListener('input', (e) => {
    setPlaying(false);
    setYear(Number(e.target.value), true);
  });

  $('speed-sel').addEventListener('change', (e) => { S.speed = Number(e.target.value); });

  $('btn-3d').addEventListener('click', (e) => {
    S.showBuildings = !S.showBuildings;
    map.setLayoutProperty('buildings', 'visibility', S.showBuildings ? 'visible' : 'none');
    e.currentTarget.classList.toggle('on', S.showBuildings);
  });

  $('btn-terrain').addEventListener('click', (e) => {
    S.terrain = !S.terrain;
    map.setTerrain(S.terrain ? { source: 'dem', exaggeration: 2.4 } : null);
    e.currentTarget.classList.toggle('on', S.terrain);
  });

  $('btn-spin').addEventListener('click', (e) => {
    S.orbit = !S.orbit;
    e.currentTarget.classList.toggle('on', S.orbit);
    if (S.orbit) startLoop(); else stopLoopIfIdle();
  });

  $('btn-panels').addEventListener('click', (e) => {
    $('panels').classList.toggle('hidden');
    e.currentTarget.classList.toggle('on', !$('panels').classList.contains('hidden'));
  });

  $('btn-info').addEventListener('click', () => $('info').classList.remove('hidden'));
  $('info-close').addEventListener('click', () => $('info').classList.add('hidden'));
  $('info').addEventListener('click', (e) => {
    if (e.target === $('info')) $('info').classList.add('hidden');
  });

  $('opa-hist').addEventListener('input', (e) => {
    S.histOpacity = Number(e.target.value) / 100;
    applyEraLayers();
  });

  $('opa-bldg').addEventListener('input', (e) => {
    S.bldgOpacity = Number(e.target.value) / 100;
    map.setPaintProperty('buildings', 'fill-extrusion-opacity', S.bldgOpacity);
  });

  $('color-mode').addEventListener('change', (e) => {
    S.colorMode = e.target.value;
    applyColorMode();
  });

  // Click a building for its record.
  map.on('click', 'buildings', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    if (p.y > S.year) return;   // not built yet at this point on the timeline
    const est = p.e ? ' <span style="opacity:.7">(estimated)</span>' : '';
    new maplibregl.Popup({ offset: 8, closeButton: false })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="pop-n">${p.n || 'Building'}</div>` +
        `<div class="pop-m">Built <em>${p.y}</em>${est}<br>${p.h.toFixed(1)} m tall</div>`)
      .addTo(map);
  });
  map.on('mouseenter', 'buildings', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'buildings', () => { map.getCanvas().style.cursor = ''; });

  // Keyboard: space to play, arrows to step a year.
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
    if (e.code === 'ArrowLeft') { setPlaying(false); setYear(Math.round(S.year) - 1); }
    if (e.code === 'ArrowRight') { setPlaying(false); setYear(Math.round(S.year) + 1); }
  });

  $('btn-3d').classList.add('on');
}

main().catch((err) => {
  console.error(err);
  $('loader-msg').textContent = 'Something went wrong — see the browser console.';
});
