// Built by `npm run build` from the cached Socrata catalogs and views metadata.
const DATA_URL = 'data/datasets.json';

const NONE = '(none)';
const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Other'];
const FACETS = [
  { key: 'domain', label: 'Domain' },
  { key: 'owner', label: 'Data Owner' },
  { key: 'frequency', label: 'Frequency', order: FREQUENCIES },
  { key: 'category', label: 'Category' },
];

let rows = [];
let builtAt = '';
let sortKey = 'viewsLastMonth';
let sortDir = -1; // -1 desc, 1 asc
const filters = Object.fromEntries(FACETS.map(f => [f.key, ''])); // '' = all
let searchTerms = []; // lowercased words; a row must contain all of them
const selectedTags = new Set(); // a row must have at least one of them
// key -> threshold. Numeric keys: value >= N. Date keys: within the last N days.
const minFilters = {};
const DATE_KEYS = new Set(['createdAt', 'updatedAt']);
const DAY_MS = 24 * 60 * 60 * 1000;

async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
  const data = await res.json();
  builtAt = data.builtAt;
  return data.datasets.map(r => ({
    ...r,
    searchText: `${r.name} ${r.description}`.toLowerCase(),
    owner: facetValue(r.owner),
    frequency: normalizeFrequency(r.frequencyRaw),
    category: facetValue(r.category),
  }));
}

const facetValue = v => (v || '').trim() || NONE;

// Collapse free-text Metadata_Frequency into FREQUENCIES. Checked in order, so
// "updated daily. Lobbyist reporting is quarterly." is Daily. Sub-daily (hourly)
// counts as Daily; discontinued datasets and missing values are Other.
function normalizeFrequency(raw) {
  const s = (raw || '').toLowerCase();
  if (/no longer|historical/.test(s)) return 'Other';
  if (/\bdaily\b|hour|per day/.test(s)) return 'Daily';
  if (/\bweekly\b/.test(s)) return 'Weekly';
  if (/\bmonthly\b|each month/.test(s)) return 'Monthly';
  return 'Other';
}

const meetsMin = (r, key, n) =>
  DATE_KEYS.has(key) ? Date.parse(r[key]) >= Date.now() - n * DAY_MS : r[key] >= n;

// Rows matching search + all active filters, optionally ignoring one facet (for its own option counts).
const matches = (r, ignore) =>
  searchTerms.every(t => r.searchText.includes(t)) &&
  Object.entries(minFilters).every(([key, n]) => meetsMin(r, key, n)) &&
  (ignore === 'tags' || !selectedTags.size || r.tags.some(t => selectedTags.has(t))) &&
  FACETS.every(f => f.key === ignore || !filters[f.key] || r[f.key] === filters[f.key]);

document.getElementById('search').addEventListener('input', e => {
  searchTerms = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
  renderFilters();
  render();
});

document.getElementById('reset').addEventListener('click', () => {
  document.getElementById('search').value = '';
  searchTerms = [];
  for (const key in filters) filters[key] = '';
  document.querySelectorAll('input[data-min]').forEach(input => { input.value = ''; });
  for (const key in minFilters) delete minFilters[key];
  selectedTags.clear();
  document.getElementById('tag-search').value = '';
  document.getElementById('tags-panel').hidden = true;
  renderFilters();
  render();
});

const tagPicker = document.getElementById('tagpicker');
const tagsPanel = document.getElementById('tags-panel');
document.getElementById('tags-btn').addEventListener('click', () => {
  tagsPanel.hidden = !tagsPanel.hidden;
  if (!tagsPanel.hidden) document.getElementById('tag-search').focus();
});
document.addEventListener('click', e => { if (!tagPicker.contains(e.target)) tagsPanel.hidden = true; });
tagPicker.addEventListener('keydown', e => { if (e.key === 'Escape') tagsPanel.hidden = true; });
document.getElementById('tag-search').addEventListener('input', renderTagList);

// Tag options with counts among rows matching every other active filter. The tag
// selection itself is ignored, since adding a tag (OR) only ever widens the results.
function renderTagList() {
  const counts = new Map();
  for (const r of rows) {
    if (!matches(r, 'tags')) continue;
    for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  for (const t of selectedTags) if (!counts.has(t)) counts.set(t, 0);
  const query = document.getElementById('tag-search').value.trim().toLowerCase();
  const tags = [...counts.keys()]
    .filter(t => selectedTags.has(t) || t.includes(query))
    .sort((a, b) => selectedTags.has(b) - selectedTags.has(a) ||
      counts.get(b) - counts.get(a) || a.localeCompare(b));

  document.getElementById('tag-list').replaceChildren(...tags.map(t => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selectedTags.has(t);
    box.addEventListener('change', () => {
      if (box.checked) selectedTags.add(t); else selectedTags.delete(t);
      renderFilters();
      render();
    });
    const label = document.createElement('label');
    label.append(box, `${t} (${counts.get(t)})`);
    return label;
  }));

  document.getElementById('tags-btn').textContent =
    selectedTags.size ? [...selectedTags].join(', ') : 'All';
}

document.querySelectorAll('input[data-min]').forEach(input => {
  input.addEventListener('input', () => {
    const n = input.valueAsNumber;
    if (Number.isNaN(n)) delete minFilters[input.dataset.min];
    else minFilters[input.dataset.min] = n;
    renderFilters();
    render();
  });
});

function renderFilters() {
  renderTagList();
  const container = document.getElementById('filters');
  container.replaceChildren(...FACETS.map(f => {
    const counts = new Map();
    let total = 0;
    for (const r of rows) {
      if (!matches(r, f.key)) continue;
      counts.set(r[f.key], (counts.get(r[f.key]) || 0) + 1);
      total++;
    }
    if (filters[f.key] && !counts.has(filters[f.key])) counts.set(filters[f.key], 0);
    const values = [...counts.keys()].sort(f.order
      ? (a, b) => f.order.indexOf(a) - f.order.indexOf(b)
      : (a, b) => a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b));

    const select = document.createElement('select');
    select.append(new Option(`All (${total})`, ''),
      ...values.map(v => new Option(`${v} (${counts.get(v)})`, v)));
    select.value = filters[f.key];
    select.addEventListener('change', () => {
      filters[f.key] = select.value;
      renderFilters();
      render();
    });

    const label = document.createElement('label');
    label.append(f.label, select);
    return label;
  }));
}

const fmtDate = s => s ? s.slice(0, 10) : '';
const fmtNum = n => n == null ? '—' : n.toLocaleString();
const EXCERPT_LEN = 240;
const expanded = new Set(); // links of rows showing their full description; survives re-renders

function renderDescription(el, r) {
  if (r.description.length <= EXCERPT_LEN) {
    el.textContent = r.description;
    return;
  }
  const open = expanded.has(r.link);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'more';
  toggle.textContent = open ? 'Less' : 'More';
  toggle.addEventListener('click', () => {
    if (open) expanded.delete(r.link); else expanded.add(r.link);
    renderDescription(el, r);
  });
  el.replaceChildren(
    open ? `${r.description} ` : `${r.description.slice(0, EXCERPT_LEN)}… `, toggle);
}

function render() {
  const filtered = rows.filter(r => matches(r));
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${fmtNum(filtered.length)} of ${fmtNum(rows.length)} datasets`;
  const fetched = document.createElement('span');
  fetched.className = 'fetched';
  fetched.textContent = `Data built ${fmtDate(builtAt)}`;
  document.getElementById('status').replaceChildren(count, fetched);

  const sorted = filtered.sort((a, b) =>
    (a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0) * sortDir);

  const tbody = document.querySelector('tbody');
  tbody.replaceChildren(...sorted.map(r => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'name';
    const a = document.createElement('a');
    a.href = r.link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.name;
    const desc = document.createElement('div');
    desc.className = 'desc';
    renderDescription(desc, r);
    nameTd.append(a, desc);
    if (r.rowLabel) {
      const label = document.createElement('div');
      label.className = 'freq';
      label.textContent = `Each row is a ${r.rowLabel}`;
      nameTd.append(label);
    }
    if (r.frequencyRaw) {
      const freq = document.createElement('div');
      freq.className = 'freq';
      freq.textContent = `Updated: ${r.frequencyRaw}`;
      nameTd.append(freq);
    }

    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      return td;
    };
    const domainTd = cell('', 'domain');
    const dot = document.createElement('span');
    dot.className = `dot ${r.domain.toLowerCase().replace(/\s+/g, '-')}`;
    domainTd.append(dot, r.domain);

    tr.append(
      nameTd,
      domainTd,
      cell(fmtNum(r.numRows), 'num'),
      cell(fmtNum(r.numColumns), 'num'),
      cell(fmtNum(r.viewsLastMonth), 'num'),
      cell(fmtNum(r.viewsTotal), 'num'),
      cell(fmtNum(r.downloads), 'num'),
      cell(fmtDate(r.createdAt), 'date'),
      cell(fmtDate(r.updatedAt), 'date'),
    );
    return tr;
  }));

  document.querySelectorAll('th.sortable').forEach(th => {
    const label = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = th.dataset.key === sortKey ? `${label} ${sortDir < 0 ? '▼' : '▲'}` : label;
    th.classList.toggle('sorted', th.dataset.key === sortKey);
  });

  highlightActiveControls();
}

// Mark every filter control that differs from its default.
function highlightActiveControls() {
  document.getElementById('search').classList.toggle('active', searchTerms.length > 0);
  document.querySelectorAll('#filters select').forEach(s => s.classList.toggle('active', s.value !== ''));
  document.getElementById('tags-btn').classList.toggle('active', selectedTags.size > 0);
  document.querySelectorAll('input[data-min]').forEach(input =>
    input.classList.toggle('active', input.dataset.min in minFilters));
}

document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    if (sortKey === th.dataset.key) sortDir = -sortDir;
    else { sortKey = th.dataset.key; sortDir = -1; }
    render();
  });
});

loadData()
  .then(data => {
    rows = data;
    renderFilters();
    render();
  })
  .catch(err => {
    document.getElementById('status').textContent = `Failed to load: ${err.message}`;
  });
