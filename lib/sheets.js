import { getDivisionForDistrict } from '../config/divisions.js';

const SHEET_ID = '1aEENIqYTl2DVsagtSv1irp_Z3Mp1Kn2EcoV9OmD_oQ0';

// — CSV parser —
function parseCSV(text) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQ = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { current.push(cell.trim()); cell = ''; }
      else if (ch === '\r' && nx === '\n' || ch === '\n' || ch === '\r') {
        current.push(cell.trim()); rows.push(current); current = []; cell = '';
        if (ch === '\r' && nx === '\n') i++;
      } else { cell += ch; }
    }
  }
  if (cell || current.length) { current.push(cell.trim()); rows.push(current); }
  return rows;
}

function isGvizError(text) {
  return text.trim().startsWith('/*O_o*/') || text.trim().startsWith('google.visualization');
}

// — Column classification —
// Matches plain "S.No" AND compound headers like "Basic Data of PACS SNo"
const SNO_HEADER_RE = /s\.?\s*no\.?$|sr\.?\s*no\.?$|serial\s*(no\.?)?$|^#$/i;

const NAME_HEADER_RE = /^(district|division|location|block|name|zila)$/i;

function isSkippedHeader(h) {
  const t = (h || '').trim();
  return SNO_HEADER_RE.test(t) || NAME_HEADER_RE.test(t);
}

function parseNumeric(val) {
  if (!val) return NaN;
  return parseFloat(String(val).replace(/[₹,\s%]/g, ''));
}

function isNumericCell(val) {
  if (!val || val.trim() === '' || val.trim() === '-' || val.trim() === '—') return false;
  return !isNaN(parseNumeric(val));
}

// — Row classification —
// Scan ALL cells — column 0 may be a numeric S.No (e.g. "22") which would
// shadow the "State Total" text that sits in a later column.
function isTotalRow(cells) {
  return cells.some(c => {
    const v = (c || '').trim().toLowerCase();
    return v === 'state total' || v === 'grand total' ||
      (v === 'total') ||
      (v.includes('total') && !v.includes('membership') && !v.includes('employee') && !v.includes('sub'));
  });
}

function isDivisionRow(cells) {
  return cells.some(c => {
    const v = (c || '').trim().toLowerCase();
    return v.includes('division') && v.includes('total');
  });
}

// Find which column holds the district/entity name.
// Priority: exact "District" match → contains "district" → first non-SNo non-empty column.
function findNameColIdx(headers) {
  const nameKw = ['district', 'districts', 'name', 'location', 'block', 'zila'];
  // Exact match
  for (const kw of nameKw) {
    const idx = headers.findIndex(h => (h || '').trim().toLowerCase() === kw);
    if (idx >= 0) return idx;
  }
  // Contains keyword
  for (const kw of nameKw) {
    const idx = headers.findIndex(h => (h || '').trim().toLowerCase().includes(kw));
    if (idx >= 0) return idx;
  }
  // Fallback: first column that doesn't look like a serial-number column
  const snoRe = /s\.?\s*no\.?|serial|^#$/i;
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').trim();
    if (h && !snoRe.test(h)) return i;
  }
  return 0;
}

// — KPI extraction —
// Accepts tagged rows ({ cells, isTotal, isDivision }); uses STATE TOTAL values
// or sums district rows when no explicit total row exists.
function buildKPIs(headers, taggedRows, nameColIdx) {
  const totalRowObj = taggedRows.find(r => r.isTotal);
  const totalRow = totalRowObj ? totalRowObj.cells : null;
  const districtCells = taggedRows.filter(r => !r.isTotal && !r.isDivision).map(r => r.cells);

  const kpis = [];
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').trim();
    if (!h || isSkippedHeader(h) || i === nameColIdx) continue;

    let value;
    if (totalRow) {
      const raw = (totalRow[i] || '').trim();
      if (!isNumericCell(raw) && raw !== '') continue; // skip text state-total cells
      value = raw;
    } else {
      // Compute sum from district rows
      const nums = districtCells.map(r => parseNumeric(r[i])).filter(n => !isNaN(n));
      if (nums.length === 0) continue;
      const sum = nums.reduce((a, b) => a + b, 0);
      // Preserve format hint from header (₹ → currency, % → percentage)
      if (h.includes('₹') || h.toLowerCase().includes('amount') || h.toLowerCase().includes('crore')) {
        value = `₹${sum.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`;
      } else if (h.includes('%') || h.toLowerCase().includes('percentage') || h.toLowerCase().includes('recovery %')) {
        const avg = sum / nums.length;
        value = `${avg.toFixed(1)}%`;
      } else {
        value = sum.toLocaleString('en-IN');
      }
    }

    if (value && value !== '' && value !== '-' && value !== '—') {
      kpis.push({ label: h, value });
    }
  }
  return kpis;
}

// — Progress / performance detection —
// Returns { colIdx, colHeader } or null
function findProgressColumn(headers) {
  const priority = [
    h => /progress/i.test(h),
    h => /recovery\s*%/i.test(h),
    h => /%/.test(h) && /(achieved|achievement|target)/i.test(h),
    h => /%/.test(h),
  ];
  for (const test of priority) {
    const idx = headers.findIndex(h => test(h));
    if (idx >= 0) return { colIdx: idx, colHeader: headers[idx] };
  }
  return null;
}

function computeProgressStatus(rawValue, allValues) {
  if (!rawValue || rawValue.trim() === '' || rawValue.trim() === '-') return 'neutral';
  const num = parseNumeric(rawValue);
  if (isNaN(num)) {
    const v = rawValue.toLowerCase();
    if (v.includes('↑') || v.includes('increas') || v.includes('good') || v.includes('improve')) return 'good';
    if (v.includes('↓') || v.includes('decreas') || v.includes('poor') || v.includes('declin')) return 'bad';
    return 'neutral';
  }

  // Is it a % column? (values 0-100)
  const isPercent = rawValue.includes('%') || allValues.every(v => Math.abs(parseNumeric(v)) <= 100);
  if (isPercent) {
    if (num >= 60) return 'good';
    if (num >= 25) return 'moderate';
    return 'bad';
  }

  // It's a raw progress/change value
  if (num > 0) return 'good';
  if (num === 0) return 'neutral';
  return 'bad';
}

function buildProgressData(headers, rows, nameColIdx) {
  const prog = findProgressColumn(headers);
  if (!prog) return { progressColumn: null, progressData: [] };

  const districtRows = rows.filter(r => !r.isTotal && !r.isDivision);
  const allProgressValues = districtRows.map(r => r.cells[prog.colIdx] || '');

  const progressData = districtRows.map(r => {
    const rawVal = (r.cells[prog.colIdx] || '').trim();
    return {
      district: (r.cells[nameColIdx] || '').trim(),
      value: rawVal,
      status: computeProgressStatus(rawVal, allProgressValues),
      division: r.division,
    };
  });

  return { progressColumn: prog, progressData };
}

// — Master-sheet handling —
const MASTER_DIVISION_HEADERS = [
  'Division', 'Districts', 'Working PACS', 'Profit PACS', 'Profit %',
  'Advancement (₹ Cr)', 'Recovery (₹ Cr)', 'Recovery %',
  'Sanctioned PACS', 'Computerised %', 'HOC', 'Audit Paras', 'Tier',
];

function parseMasterSheet(allRows) {
  const headerRow = allRows[0];
  const kpiValueRow = allRows[1] || [];

  // KPIs: non-empty, non-title cells from first value row
  const kpis = [];
  for (let i = 0; i < headerRow.length && kpis.length < 6; i++) {
    const h = (headerRow[i] || '').trim();
    const v = (kpiValueRow[i] || '').trim();
    if (!h || !v || v === '-') continue;
    // Clean up overly long header (extract last cap phrase)
    const m = h.match(/([A-Z][A-Z\s&₹()\-/]+[A-Z\d])$/);
    const label = (m && m[1].trim().length >= 3) ? m[1].trim() : h.slice(-38).replace(/^\W+/, '');
    kpis.push({ label, value: v });
  }

  // Division summary rows
  const divSectionIdx = allRows.findIndex(r =>
    r.some(c => c.toLowerCase().includes('administrative division'))
  );
  let rows = [];
  if (divSectionIdx >= 0) {
    for (let i = divSectionIdx + 2; i < allRows.length; i++) {
      const r = allRows[i];
      const first = (r[1] || r[0] || '').trim();
      if (!first) break;
      if (first.toUpperCase() === first && first.length > 20 && !first.includes('Division') && !first.includes('TOTAL')) break;
      if (first.includes('Division') || first.includes('TOTAL')) {
        const cells = [first, ...r.slice(2, 2 + MASTER_DIVISION_HEADERS.length - 1)];
        // isDivision = false so DataTable doesn't filter these rows out;
        // they're division summaries but should still render as table rows.
        rows.push({ cells, isTotal: isTotalRow(r), isDivision: false, division: getDivisionForDistrict(first) || null });
      }
    }
  }

  const headers = MASTER_DIVISION_HEADERS.slice(0, rows[0]?.cells.length || MASTER_DIVISION_HEADERS.length);
  const divisions = [...new Set(rows.map(r => r.division).filter(Boolean))];

  return {
    headers, rows, kpis, divisions,
    progressColumn: null, progressData: [],
    isMasterSheet: true,
    lastFetched: new Date().toISOString(),
  };
}

// — Generic flat-table parser —
function parseGenericTable(allRows) {
  if (allRows.length === 0) {
    return { headers: [], rows: [], kpis: [], divisions: [], progressColumn: null, progressData: [], lastFetched: new Date().toISOString() };
  }

  // Normalize headers: collapse embedded newlines / carriage returns to a space
  let headers = allRows[0].map(h => (h || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
  let dataStartIdx = 1;

  // Two-level header detection (Case A): GSheet has a dedicated sub-header row.
  // Row 0 holds section names with empty slots; Row 1 holds the sub-headers.
  if (allRows.length > 1) {
    const subRow = allRows[1].map(h => (h || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
    const subHasTextInEmptySlots = subRow.some((c, i) => c && !headers[i]);
    const subNonEmpty = subRow.filter(c => c).length;
    if (subHasTextInEmptySlots && subNonEmpty >= 2) {
      let lastSection = '';
      headers = headers.map((h, i) => {
        if (h) lastSection = h;
        const sub = subRow[i];
        if (sub) return (lastSection ? lastSection + ' ' : '') + sub;
        return h || lastSection;
      });
      dataStartIdx = 2;
    }
  }

  // Two-level header detection (Case B): GSheet exports as a single header row where
  // the FIRST cell of each section group includes "SECTION Sub" (e.g. "ADVANCEMENT (IN Cr.) Overdue")
  // and subsequent cells in that group only have the sub-keyword ("Fresh", "Total").
  // Fill-forward the section prefix so all columns become "SECTION Sub".
  // Example: ["ADVANCEMENT (IN Cr.) Overdue","Fresh","Total","RECOVERY... Overdue","Fresh","Total","PERCENTAGE Overdue","Fresh","Total"]
  //       → all "Fresh"/"Total" get the section prefix of the preceding "SECTION Sub" cell.
  {
    const subKws = ['overdue', 'fresh', 'total', 'balance', 'outstanding'];
    const endsWithSub = h => subKws.some(k => h.toLowerCase().trimEnd().endsWith(' ' + k));
    const isSubOnly   = h => subKws.includes(h.toLowerCase().trim());
    const hasMixed = headers.some(h => endsWithSub(h)) && headers.some(h => isSubOnly(h));
    if (hasMixed) {
      let lastSection = '';
      headers = headers.map(h => {
        if (endsWithSub(h)) {
          // Extract section = everything before the trailing sub-keyword
          const hl = h.toLowerCase();
          const match = subKws.find(k => hl.trimEnd().endsWith(' ' + k));
          if (match) lastSection = h.slice(0, h.toLowerCase().lastIndexOf(' ' + match)).trim();
          return h; // keep first cell as-is (already has full name)
        }
        if (isSubOnly(h) && lastSection) return lastSection + ' ' + h;
        return h;
      });
    }
  }

  const nameColIdx = findNameColIdx(headers);
  const rawDataRows = allRows.slice(dataStartIdx);

  // Tag each raw row — detect total/division rows first so KPIs use correct data.
  const rows = rawDataRows.map(cells => {
    const nameVal = (cells[nameColIdx] || cells[0] || '').trim();
    const isDiv = isDivisionRow(cells) || (nameVal.toLowerCase().includes('division') && nameVal.toLowerCase().includes('total'));

    // Explicit "total" keyword OR implicit: BOTH the name and S.No cells are empty
    // but numeric values exist elsewhere — these are unlabelled summary/total rows
    // that many Google Sheets produce (no "State Total" text, just numbers).
    const nameEmpty = !(cells[nameColIdx] || '').trim();
    const snoEmpty  = nameColIdx === 0 ? nameEmpty : !(cells[0] || '').trim();
    const isTot = isTotalRow(cells) || (nameEmpty && snoEmpty && cells.some(c => isNumericCell(c)));

    return {
      cells,
      isTotal: isTot,
      isDivision: isDiv,
      division: isTot ? null : (isDiv ? null : (getDivisionForDistrict(nameVal) || null)),
    };
  });

  // buildKPIs now receives tagged rows so it can find the total row correctly.
  const kpis = buildKPIs(headers, rows, nameColIdx);
  const { progressColumn, progressData } = buildProgressData(headers, rows, nameColIdx);
  const divisions = [...new Set(rows.map(r => r.division).filter(Boolean))];

  return { headers, rows, kpis, divisions, progressColumn, progressData, lastFetched: new Date().toISOString() };
}

// — Server-side in-memory cache (survives dev hot-reload refreshes) —
const _cache = {};
const CACHE_TTL_MS = 90_000; // 90 seconds — fast refresh in dev, revalidate:60 in prod

// — Public API —
export async function fetchSheetData(tabName) {
  // Serve from cache if still fresh (avoids 30s hang on every dev refresh)
  const cached = _cache[tabName];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;

  let text;
  try {
    // 12-second hard timeout so the page never hangs indefinitely
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    // Return cached stale data if available, otherwise an error shell
    if (cached) return cached.data;
    return { error: err.message, headers: [], rows: [], kpis: [], divisions: [], progressColumn: null, progressData: [], lastFetched: new Date().toISOString() };
  }

  if (isGvizError(text)) {
    return { error: 'Tab not found or access denied', headers: [], rows: [], kpis: [], divisions: [], progressColumn: null, progressData: [], lastFetched: new Date().toISOString() };
  }

  const allRows = parseCSV(text).filter(row => row.some(c => c !== ''));
  if (!allRows.length) {
    return { headers: [], rows: [], kpis: [], divisions: [], progressColumn: null, progressData: [], lastFetched: new Date().toISOString() };
  }

  // Detect master summary sheet by its very long header cell
  const firstHeader = (allRows[0][1] || allRows[0][0] || '').trim();
  const result = (firstHeader.length > 60 && /cooperative/i.test(firstHeader))
    ? parseMasterSheet(allRows)
    : parseGenericTable(allRows);

  _cache[tabName] = { data: result, ts: Date.now() };
  return result;
}