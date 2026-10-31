import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Head from 'next/head';
import { fetchSheetData } from '../lib/sheets';
import { REPORTS, REPORT_GROUPS } from '../config/reports';
import { DIVISIONS, DIVISION_NAMES, getDivisionForDistrict } from '../config/divisions';
import { supabase } from '../lib/supabase';

const DEFAULT_REPORT = REPORTS[1];
const REFRESH_MS = 5 * 60 * 1000;

const CARD_COLORS = [
  '#2876c7', '#159b9a', '#d48a20', '#8056c9', '#0ea86a', '#3d93e5',
  '#e05c5c', '#4e9f55', '#d45f9e', '#6b7fde', '#e07c3a', '#2aad8f',
  '#c74f4f', '#5b7faa', '#b55ca8', '#4a9473',
];

// — Helpers
function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function parseNumeric(val) {
  if (!val) return NaN;
  return parseFloat(String(val).replace(/[₹,\s%]/g, ''));
}

function getDivisionOf(name) {
  if (!name) return null;
  const s = name.toLowerCase().trim();
  for (const [div, dists] of Object.entries(DIVISIONS)) {
    for (const d of dists) {
      if (s.includes(d.toLowerCase()) || d.toLowerCase().includes(s)) return div;
    }
  }
  return null;
}

const SNO_RE = /s\.?\s*no\.?$|sr\.?\s*no\.?$|serial\s*(no\.?)?$/i;

function isSnoCols(headers) {
  if (!headers) return new Set();
  return new Set(headers.reduce((acc, h, i) => {
    if (SNO_RE.test((h || '').trim())) acc.push(i);
    return acc;
  }, []));
}

function computeDivisionRows(districtRows, headers, nameColIdx) {
  const groups = {};
  for (const div of DIVISION_NAMES) groups[div] = [];
  for (const row of districtRows) {
    const div = row.division || getDivisionOf(row.cells[0] || row.cells[1] || '');
    if (div && groups[div]) groups[div].push(row.cells);
  }
  return DIVISION_NAMES.map(div => {
    const dRows = groups[div];
    if (!dRows.length) return null;
    const agg = headers.map((_, i) => {
      if (i === nameColIdx) return `${div} Division`;
      if (SNO_RE.test((headers[i] || '').trim())) return '';
      const nums = dRows.map(r => parseNumeric(r[i])).filter(n => !isNaN(n));
      if (!nums.length) return '';
      const sum = nums.reduce((a, b) => a + b, 0);
      const sample = (dRows[0][i] || '').trim();
      if (sample.includes('%')) return `${(sum / nums.length).toFixed(1)}%`;
      if (sample.includes('₹')) return `₹${sum.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`;
      return sum.toLocaleString('en-IN');
    });
    return { cells: agg, isTotal: false, isDivision: true, division: div };
  }).filter(Boolean);
}

function downloadCSV(headers, rows, filename) {
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(','), ...rows.map(r => r.cells.map(esc).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// — Excel comparison helpers

// Parse one sheet's raw rows into { data, totals, hdrsLower, count } or null
function parseSheetData(sheetRows) {
  if (!sheetRows || sheetRows.length < 2) return null;

  // Step 1: Skip leading title/merged-cell rows (< 3 non-empty cells).
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(5, sheetRows.length - 1); r++) {
    const nonEmpty = sheetRows[r].filter(c => String(c || '').trim() !== '').length;
    if (nonEmpty >= 3) { headerRowIdx = r; break; }
    headerRowIdx = r + 1;
  }

  let hdrsRaw = sheetRows[headerRowIdx].map(h => String(h || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
  let dataStartIdx = headerRowIdx + 1;

  // Step 2: Detect two-level headers (section header row + sub-header row).
  // Pattern: sub-header row has text in columns where the section row is empty (merged cells).
  // e.g. Row1: ["","District","ADVANCEMENT (IN Cr.)","","","RECOVERY...","","","PERCENTAGE","",""]
  //      Row2: ["","","Overdue","Fresh","Total","Overdue","Fresh","Total","Overdue","Fresh","Total"]
  // → combine into: "advancement (in cr.) overdue", "advancement (in cr.) fresh", etc.
  const subRow = sheetRows[headerRowIdx + 1];
  if (subRow) {
    const subHasTextInEmptySlots = subRow.some((c, i) =>
      String(c || '').trim() && !hdrsRaw[i]
    );
    const subNonEmpty = subRow.filter(c => String(c || '').trim()).length;
    if (subHasTextInEmptySlots && subNonEmpty >= 2) {
      let lastSection = '';
      hdrsRaw = hdrsRaw.map((h, i) => {
        if (h) lastSection = h;
        const sub = String(subRow[i] || '').trim();
        if (sub) return (lastSection ? lastSection + ' ' : '') + sub;
        return h || lastSection;
      });
      dataStartIdx = headerRowIdx + 2; // skip both header rows
    }
  }

  const hdrsLower = hdrsRaw.map(h => h.toLowerCase());
  const dataRows = sheetRows.slice(dataStartIdx);
  if (!dataRows.length) return null;

  // Step 3: Find the district name column.
  let nameIdx = hdrsLower.findIndex(h => /district/i.test(h));
  if (nameIdx < 0) nameIdx = hdrsLower.findIndex(h => ['name','block','zila','location'].includes(h));
  // Fallback: first column whose sample data values are predominantly TEXT
  if (nameIdx < 0) {
    const sample = dataRows.slice(0, 5);
    for (let col = 0; col < hdrsLower.length; col++) {
      const vals = sample.map(r => String(r[col] || '').trim()).filter(v => v);
      if (!vals.length) continue;
      const numCount = vals.filter(v => !isNaN(parseFloat(v.replace(/[₹,\s%]/g, '')))).length;
      if (numCount < vals.length / 2) { nameIdx = col; break; }
    }
  }
  if (nameIdx < 0) nameIdx = 0;
  // Words that appear in header/sub-header rows — skip them as district names
  const HEADER_SKIP_RE = /^(sr\.?\s*no\.?|s\.?\s*no\.?|district|districts|name|block|location|zila|division|total|grand\s*total|state\s*total)$/i;

  const distData = {};
  let excelTotalRow = null; // capture the Excel's own state-total row if present

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rawName = String(row[nameIdx] || '').trim();
    const key = rawName.toLowerCase();

    // Detect total/grand-total row by scanning ALL cells (name col is often blank for total rows)
    if (!excelTotalRow) {
      const isTotalRow = row.some(cell => {
        const v = String(cell || '').trim();
        return v && /^(total|grand\s*total|state\s*total|state total|grand total)$/i.test(v);
      });
      if (isTotalRow) { excelTotalRow = row; continue; }
    }

    if (!key || HEADER_SKIP_RE.test(rawName) || /total|grand|state\s*total/i.test(rawName)) continue;
    distData[key] = {};
    hdrsLower.forEach((h, j) => {
      if (j === nameIdx || !h) return;
      // Skip serial-number columns — they're row indices, not data
      if (/^(sno|sr\.?\s*no\.?|s\.?\s*no\.?|serial|#)$/i.test(h)) return;
      const n = parseFloat(String(row[j] || '').replace(/[₹,\s%]/g, ''));
      // Store 0 for blank cells — so rows with empty Excel cells (e.g. district hasn't
      // received approval yet) still show • 0 instead of no arrow at all.
      distData[key][h] = isNaN(n) ? 0 : n;
    });
  }

  const count = Object.keys(distData).length;
  if (count === 0) return null;

  // Build totals from district rows first (sum; average decimal-% columns)
  const totals = {};
  const colCounts = {};
  const colAllDecimal = {};
  Object.values(distData).forEach(dr => Object.entries(dr).forEach(([h, v]) => {
    totals[h] = (totals[h] || 0) + v;
    colCounts[h] = (colCounts[h] || 0) + 1;
    if (v > 1) colAllDecimal[h] = false;
    else if (colAllDecimal[h] === undefined) colAllDecimal[h] = true;
  }));
  Object.keys(totals).forEach(h => {
    if (colAllDecimal[h] && colCounts[h] > 0) totals[h] = totals[h] / colCounts[h];
  });

  // If the Excel sheet has its own state-total row, prefer those values directly —
  // they match the GSheet state-total row exactly (weighted %, not simple average).
  if (excelTotalRow) {
    hdrsLower.forEach((h, j) => {
      if (j === nameIdx || !h) return;
      const n = parseFloat(String(excelTotalRow[j] || '').replace(/[₹,\s%]/g, ''));
      if (!isNaN(n)) totals[h] = n;
    });
  }

  return { data: distData, totals, hdrsLower, count };
}

// Find which Excel sheet best matches the given report name.
// Returns the sheet with the MOST significant word overlap (not just the first match)
// to avoid e.g. "PACS as CSC" accidentally matching "Computerisation of PACS" via the word "PACS".
function findMatchingSheet(sheets, reportName) {
  if (!sheets) return null;
  const sheetNames = Object.keys(sheets);
  if (!sheetNames.length) return null;
  const rL = reportName.toLowerCase();

  // 1. Exact (case-insensitive)
  const exact = sheetNames.find(s => s.toLowerCase() === rL);
  if (exact) return exact;

  // 2. Best substring/word-overlap match — score every sheet and pick highest
  const rWords = rL.split(/\W+/).filter(w => w.length >= 3);
  let bestSheet = null, bestScore = 0;
  for (const s of sheetNames) {
    const sL = s.toLowerCase();
    const sWords = sL.split(/\W+/).filter(w => w.length >= 3);
    // Count matched words weighted by length (longer words = stronger signal)
    const matchedWeight = rWords.reduce((acc, w) => acc + (sWords.includes(w) ? w.length : 0), 0);
    // Substring containment bonus: only when the ratio is ≥ 55% (avoids "pacs" ⊂ any PACS sheet)
    let subBonus = 0;
    if (sL.includes(rL) || rL.includes(sL)) {
      const ratio = Math.min(sL.length, rL.length) / Math.max(sL.length, rL.length);
      if (ratio >= 0.55) subBonus = 50;
    }
    const score = matchedWeight + subBonus;
    if (score > bestScore) { bestScore = score; bestSheet = s; }
  }
  // Require at least one significant word match (≥ 3 chars) to avoid bogus matches
  if (bestScore >= 3) return bestSheet;

  // 3. Only one sheet → use it as a last resort
  if (sheetNames.length === 1) return sheetNames[0];
  return null;
}

// Levenshtein edit distance (for close spelling variants like Bathinda/Bhatinda)
function _editDist(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 999;
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function fuzzyMatchExcel(compareData, distName) {
  if (!compareData || !distName) return null;
  const s = distName.toLowerCase().trim().replace(/\s+/g, ' ');

  // 1. Exact
  if (compareData[s] !== undefined) return compareData[s];

  // 2. Contains (one is substring of other)
  for (const key of Object.keys(compareData)) {
    if (s.includes(key) || key.includes(s)) return compareData[key];
  }

  // 3. Word-overlap: any significant word (≥4 chars) shared between names
  const sWords = new Set(s.split(/[\s,.-]+/).filter(w => w.length >= 4));
  for (const key of Object.keys(compareData)) {
    const kWords = key.split(/[\s,.-]+/).filter(w => w.length >= 4);
    if (kWords.some(w => sWords.has(w))) return compareData[key];
  }

  // 4. Normalize: strip honorifics/common prefixes then contains-match
  const norm = str => str.replace(/\b(sri|shri|sh|new|old|dist\.?|district)\b/gi, '').replace(/\s+/g, ' ').trim();
  const sNorm = norm(s);
  for (const key of Object.keys(compareData)) {
    const kNorm = norm(key);
    if (sNorm === kNorm || sNorm.includes(kNorm) || kNorm.includes(sNorm)) return compareData[key];
  }

  // 5. Edit distance ≤ 2 (handles Bathinda/Bhatinda, Firozpur/Ferozepur etc.)
  const maxDist = Math.max(2, Math.floor(s.length * 0.15));
  for (const key of Object.keys(compareData)) {
    if (_editDist(s, key) <= maxDist) return compareData[key];
  }

  return null;
}

// — Diff formatting
function formatDiff(abs) {
  if (abs >= 10000) return abs.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (abs >= 1) return abs % 1 < 0.005 ? Math.round(abs).toLocaleString('en-IN') : abs.toFixed(2);
  return abs.toFixed(2);
}

// Column lookup: exact match first, then suffix/prefix substring with ≥40% length ratio.
// The ratio guard prevents short generic keys ("no. of pacs", ratio 0.26) from matching
// long specific names, while still matching section-prefix mismatches like:
//   GSheet "access/deficit from last year" (30)
//   Excel  "percentage access/deficit from last year" (39) → ratio 0.77 ✓
function fuzzyLookup(map, key) {
  if (!map) return undefined;
  if (map[key] !== undefined) return map[key];
  let bestVal = undefined, bestLen = 0;
  for (const [k, v] of Object.entries(map)) {
    if (k.includes(key) || key.includes(k)) {
      const shorter = Math.min(k.length, key.length);
      const longer = Math.max(k.length, key.length);
      if (shorter / longer >= 0.4 && shorter > bestLen) { bestVal = v; bestLen = shorter; }
    }
  }
  return bestVal;
}

// — KPI grid — compact, all columns, with Excel comparison
function KPIGrid({ kpis, loading, compareTotals }) {
  const items = loading
    ? Array(8).fill({ label: '—', value: '—' })
    : kpis.length
      ? kpis
      : Array(4).fill({ label: 'No data', value: '—' });

  const numCols = Math.ceil(items.length / 2);
  return (
    <section className="kpi-grid" style={{ gridTemplateColumns: `repeat(${numCols}, 1fr)` }}>
      {items.map((k, i) => {
        // Compare current KPI value with Excel column total
        const currNum = parseNumeric(k.value);
        const lookupKey = (k.label || '').trim().toLowerCase();
        const excelNum = compareTotals
          ? fuzzyLookup(compareTotals, lookupKey)
          : undefined;
        const hasDiff = compareTotals && !isNaN(currNum) && excelNum !== undefined;
        // Normalize: Excel % columns sometimes stored as decimals (0.59) vs GSheet 0-100 scale (59.28).
        // Use strict < 1 (not <= 1) so a count of exactly 1 is never misread as 100% decimal.
        const normExcelNum = (hasDiff && currNum > 1.5 && excelNum > 0 && excelNum < 1) ? excelNum * 100 : excelNum;
        const diff = hasDiff ? currNum - normExcelNum : 0;

        return (
          <article
            key={i}
            className={`kpi-card ${loading ? 'kpi-loading' : ''}`}
            style={{ borderLeftColor: CARD_COLORS[i % CARD_COLORS.length] }}
          >
            <div className="kpi-card-label" title={k.label}>{k.label}</div>
            <div className="kpi-card-value">{k.value}</div>
            {hasDiff && Math.abs(diff) > 0.05 ? (
              <div className={`kpi-card-diff ${diff > 0 ? 'diff-up' : 'diff-dn'}`}>
                {diff > 0 ? '↑' : '↓'} {formatDiff(Math.abs(diff))}
              </div>
            ) : hasDiff ? (
              <div className="kpi-card-diff diff-eq">• 0</div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

// — Client-side name-column detector (mirrors server findNameColIdx)
const CLIENT_SNO_RE = /s\.?\s*no\.?$|sr\.?\s*no\.?$|serial\s*(no\.?)?$|^#$/i;
function clientFindNameColIdx(headers) {
  const kws = ['district','districts','name','location','block','zila'];
  for (const kw of kws) {
    const i = headers.findIndex(h => (h || '').trim().toLowerCase() === kw);
    if (i >= 0) return i;
  }
  for (const kw of kws) {
    const i = headers.findIndex(h => (h || '').trim().toLowerCase().includes(kw));
    if (i >= 0) return i;
  }
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').trim();
    if (h && !CLIENT_SNO_RE.test(h)) return i;
  }
  return 0;
}

// — Performance card — compact + configurable
function clientClassify(rawValue, critBelow, goodAbove) {
  const n = parseFloat(String(rawValue || '').replace(/[₹,\s]/g, ''));
  if (isNaN(n)) return 'neutral';
  if (n >= goodAbove) return 'good';
  if (n >= critBelow) return 'moderate';
  return 'bad';
}

function PerformanceCard({
  progressData, progressColumn, loading,
  perfCfg, isAdmin, onOpenCfg,
}) {
  if (loading) return null;
  if (!progressData?.length) return null;

  const { critBelow, goodAbove } = perfCfg;

  const groups = { bad: [], moderate: [], good: [] };
  for (const item of (progressData || [])) {
    const status = clientClassify(item.value, critBelow, goodAbove);
    if (status in groups) groups[status].push(item);
  }

  const metricName = progressColumn?.colHeader || 'Key Metric';

  return (
    <section className="perf-card">
      <div className="perf-card-head">
        <span className="perf-card-icon">📊</span>
        <span className="perf-metric-name">{metricName}</span>
        <div className="perf-threshold-badges">
          <span className="pthr pthr-bad">Critical &lt;{critBelow}</span>
          <span className="pthr pthr-mod">Moderate {critBelow}–{goodAbove}</span>
          <span className="pthr pthr-good">Good &gt;{goodAbove}</span>
        </div>
        {isAdmin && (
          <button className="perf-cfg-btn" onClick={onOpenCfg}>
            ⚙ Configure
          </button>
        )}
      </div>

      <div className="perf-rows">
        {!progressData?.length ? (
          <p style={{ color: '#a2b5c7', fontSize: 13, margin: '8px 0 4px' }}>
            No performance data available for this report.
          </p>
        ) : (
          [
            { key: 'bad', label: 'Critical', cls: 'bad', emoji: '🔴' },
            { key: 'moderate', label: 'Moderate', cls: 'mod', emoji: '🟡' },
            { key: 'good', label: 'On Track', cls: 'good', emoji: '🟢' },
          ].map(({ key, label, cls, emoji }) =>
            groups[key].length > 0 && (
              <div key={key} className={`perf-row perf-row-${cls}`}>
                <span className="perf-row-label">
                  {emoji} {label} <span className="perf-row-count">({groups[key].length})</span>
                </span>
                <div className="perf-chips">
                  {groups[key].map((item, i) => (
                    <span key={i} className={`perf-chip perf-chip-${cls}`}>
                      {item.district}
                      {item.value && <em>{item.value}</em>}
                    </span>
                  ))}
                </div>
              </div>
            )
          )
        )}
      </div>
    </section>
  );
}

// — Filter bar
function FilterBar({ viewMode, onViewMode, divFilter, onDivFilter, onCSV, hasData, isMasterSheet,
                     compareFiles, activeCompare, onCompareSelect, onCompareUpload, compareLoading,
                     isAdmin }) {
  const fileRef = useRef(null);
  return (
    <div className="filter-bar">
      <div className="filter-left">
        {!isMasterSheet && (
          <>
            <div className="view-toggle">
              <button className={viewMode === 'district' ? 'active' : ''} onClick={() => onViewMode('district')}>
                📍 District
              </button>
              <button className={viewMode === 'division' ? 'active' : ''} onClick={() => onViewMode('division')}>
                🗺️ Division
              </button>
            </div>
            {viewMode === 'district' && (
              <select className="div-select" value={divFilter} onChange={e => onDivFilter(e.target.value)}>
                <option value="all">All Divisions</option>
                {DIVISION_NAMES.map(d => <option key={d} value={d}>{d} Division</option>)}
              </select>
            )}
          </>
        )}
      </div>

      <div className="filter-right">
        <div className="compare-group">
          {/* Admin: file list dropdown + upload new button */}
          {isAdmin && (
            <>
              {compareFiles.length > 0 && (
                <select
                  className="div-select cmp-select"
                  value={activeCompare}
                  onChange={e => onCompareSelect(e.target.value)}
                  title="Select which Excel file to compare against"
                >
                  <option value="">— No comparison —</option>
                  {compareFiles.map(f => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              )}
              <button className="btn" onClick={() => fileRef.current.click()} disabled={compareLoading}
                title="Upload a new Excel file for comparison">
                {compareLoading ? '⟳ Loading…' : '📂 Upload Excel'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={onCompareUpload}
                multiple
              />
            </>
          )}
          {/* Non-admin: read-only pill showing which file is active */}
          {!isAdmin && compareFiles.length > 0 && (
            <span className="cmp-loaded-label" title={compareFiles.find(f => f.name === activeCompare)?.name || compareFiles[0]?.name}>
              📄 {activeCompare || compareFiles[0]?.name}
            </span>
          )}
        </div>
        <button className="btn" disabled={!hasData} onClick={onCSV}>⬇ CSV</button>
      </div>
    </div>
  );
}

// — Progress cell coloring
function progressCls(row, progressColIdx, perfCfg) {
  if (progressColIdx < 0 || row.isTotal) return '';
  const raw = (row.cells[progressColIdx] || '').trim();
  const num = parseNumeric(raw);
  if (isNaN(num)) {
    const v = raw.toLowerCase();
    if (v.includes('↑') || v.includes('good')) return 'prog-good';
    if (v.includes('↓') || v.includes('poor')) return 'prog-bad';
    return '';
  }
  const { critBelow, goodAbove } = perfCfg;
  const isPercent = raw.includes('%') || (num >= 0 && num <= 100);
  if (isPercent) {
    if (num >= goodAbove) return 'prog-good';
    if (num >= critBelow) return 'prog-mod';
    return 'prog-bad';
  }
  if (num > 0) return 'prog-good';
  if (num === 0) return 'prog-mod';
  return 'prog-bad';
}

// — Data table
const DIVISION_COLORS = { Ferozepur: '#e4a03b', Jalandhar: '#159b9a', Patiala: '#8156d9' };

function DataTable({ headers, rows, loading, viewMode, divFilter, progressColumn,
                     isMasterSheet, compareData, compareDataByDivision, perfCfg, error }) {
  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <span>Fetching latest data from Google Sheets…</span>
      </div>
    );
  }
  if (!headers?.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📭</div>
        <h4>{error ? 'Google Sheet configuration issue' : 'Data not available'}</h4>
        <p>{error || 'This report tab may not exist in the Google Sheet, or the tab name in <code>config/reports.js</code> doesn&apos;t match exactly.'}</p>
      </div>
    );
  }

  const progIdx = progressColumn?.colIdx ?? -1;
  // Hide S.No columns AND columns with empty/whitespace-only headers (trailing GSheet columns)
  const hiddenCols = isSnoCols(headers);
  headers.forEach((h, i) => { if (!h || !h.trim()) hiddenCols.add(i); });
  const visColCount = headers.filter((_, i) => !hiddenCols.has(i)).length;

  let nameColDisplayIdx = 0;
  for (let i = 0; i < headers.length; i++) {
    if (!hiddenCols.has(i)) { nameColDisplayIdx = i; break; }
  }

  let renderRows = [];
  if (isMasterSheet) {
    rows.forEach(r => renderRows.push({ type: 'row', data: r }));
  } else if (viewMode === 'division') {
    const districtRows = rows.filter(r => !r.isTotal && !r.isDivision);
    const divRows = computeDivisionRows(districtRows, headers, nameColDisplayIdx);
    const totalRow = rows.find(r => r.isTotal);
    [...divRows, ...(totalRow ? [totalRow] : [])].forEach(r => renderRows.push({ type: 'row', data: r }));
  } else {
    const districtRows = rows.filter(r => !r.isTotal && !r.isDivision);
    const filtered = divFilter === 'all'
      ? districtRows
      : districtRows.filter(r => {
          const div = r.division || getDivisionOf(r.cells[0] || r.cells[1] || '');
          return div === divFilter;
        });
    const totalRow = rows.find(r => r.isTotal);
    const visibleRows = [...filtered, ...(totalRow ? [totalRow] : [])];

    if (divFilter === 'all') {
      const shownTotal = visibleRows.find(r => r.isTotal);
      const districtOnly = visibleRows.filter(r => !r.isTotal);
      const shown = new Set();
      for (const divName of DIVISION_NAMES) {
        const divDistricts = districtOnly.filter(r => {
          const d = r.division || getDivisionOf(r.cells[0] || r.cells[1] || '');
          return d === divName;
        });
        if (divDistricts.length > 0) {
          renderRows.push({ type: 'divider', label: `${divName} Division`, color: DIVISION_COLORS[divName] });
          divDistricts.forEach(r => { shown.add(r); renderRows.push({ type: 'row', data: r }); });
        }
      }
      const unmatched = districtOnly.filter(r => !shown.has(r));
      if (unmatched.length > 0) {
        if (shown.size > 0) renderRows.push({ type: 'divider', label: 'Other Districts', color: '#8a9aaa' });
        unmatched.forEach(r => renderRows.push({ type: 'row', data: r }));
      }
      if (shownTotal) renderRows.push({ type: 'row', data: shownTotal });
    } else {
      visibleRows.forEach(r => renderRows.push({ type: 'row', data: r }));
    }
  }

  return (
    <>
      {isMasterSheet && (
        <div className="tab-warning">
          ⚠ Showing state-level summary — district tab name may not match the Google Sheet.
          Update <code>tabName</code> in <code>config/reports.js</code> to match the exact sheet tab name.
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {headers.map((h, i) => hiddenCols.has(i) ? null : (
                <th key={i} className={i === progIdx ? 'th-progress' : ''}>
                  {viewMode === 'division' && i === nameColDisplayIdx ? 'Division' : h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {renderRows.map((item, ri) => {
              if (item.type === 'divider') {
                return (
                  <tr key={`div-${ri}`} className="division-header-row">
                    <td colSpan={visColCount} style={{ borderLeft: `4px solid ${item.color}` }}>
                      <span className="div-group-label">{item.label}</span>
                    </td>
                  </tr>
                );
              }
              const row = item.data;
              const pcls = progressCls(row, progIdx, perfCfg);
              const distName = (row.cells[nameColDisplayIdx] || '').trim();
              // Division rows: sum Excel district values per division
              // District rows: fuzzy-match by district name
              const excelRow = row.isTotal ? null
                : row.isDivision && compareDataByDivision
                  ? fuzzyMatchExcel(compareDataByDivision, distName.replace(/\s*division\s*/i, '').trim())
                  : (!row.isDivision && compareData)
                    ? fuzzyMatchExcel(compareData, distName)
                    : null;



              return (
                <tr
                  key={ri}
                  className={[
                    row.isTotal ? 'total-row' : '',
                    row.isDivision ? 'division-sum-row' : '',
                    pcls ? `row-${pcls}` : '',
                  ].filter(Boolean).join(' ')}
                >
                  {row.cells.map((cell, ci) => {
                    if (hiddenCols.has(ci)) return null;
                    const isProgCol = ci === progIdx;
                    const isNameCol = ci === nameColDisplayIdx;

                    // Highlight 100% cells dark green
                    const isPerfect = (() => {
                      const n = parseNumeric(cell);
                      if (n !== 100) return false;
                      const hdr = (headers[ci] || '').toLowerCase();
                      return String(cell).includes('%') || hdr.includes('%') || hdr.includes('percent');
                    })();

                    let cmpArrow = null;
                    if (excelRow && !isNameCol) {
                      const colKey = (headers[ci] || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                      // Exact match first, then fuzzy for minor header differences
                      let excelVal = excelRow[colKey];
                      if (excelVal === undefined) {
                        let bestLen = 0;
                        for (const [k, v] of Object.entries(excelRow)) {
                          if (k.includes(colKey) || colKey.includes(k)) {
                            const shorter = Math.min(k.length, colKey.length);
                            const longer = Math.max(k.length, colKey.length);
                            if (shorter / longer >= 0.4 && shorter > bestLen) {
                              excelVal = v; bestLen = shorter;
                            }
                          }
                        }
                      }
                      if (excelVal !== undefined) {
                        const currNum = parseNumeric(cell);
                        if (!isNaN(currNum)) {
                          // Normalize decimal % (Excel: 0.59) to match GSheet 0–100 scale (59.28).
                          // Strict < 1 so a count of exactly 1 is never misread as 100% decimal.
                          const normExcel = (currNum > 1.5 && excelVal > 0 && excelVal < 1) ? excelVal * 100 : excelVal;
                          const diff = currNum - normExcel;
                          if (diff > 0.05) cmpArrow = <span className="cmp-up" title={`Excel: ${normExcel}`}>↑{formatDiff(diff)}</span>;
                          else if (diff < -0.05) cmpArrow = <span className="cmp-dn" title={`Excel: ${normExcel}`}>↓{formatDiff(Math.abs(diff))}</span>;
                          else cmpArrow = <span className="cmp-eq" title={`Excel: ${normExcel}`}>• 0</span>;
                        }
                      }
                    }

                    return (
                      <td
                        key={ci}
                        className={[
                          ci !== nameColDisplayIdx ? 'num' : '',
                          isProgCol && !row.isTotal ? `td-${pcls}` : '',
                          isPerfect ? 'td-perfect' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        {isNameCol && !row.isTotal && !row.isDivision && row.division && (
                          <span className="div-dot" style={{ background: DIVISION_COLORS[row.division] || '#159b9a' }} />
                        )}
                        {cell}
                        {cmpArrow && <span className="cell-diff">{cmpArrow}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// — Sidebar
function Sidebar({ active, onSelect, search, onSearch, onClose }) {
  const filtered = REPORTS.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  const visibleGroups = REPORT_GROUPS.filter(g => filtered.some(r => r.group === g));
  const navRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => {
    if (activeRef.current && navRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [active]);

  return (
    <>
      <div className="sidebar-top">
        <span className="sidebar-heading">Reports</span>
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">✕</button>
      </div>
      <input
        className="search-input"
        placeholder="⌕ Search reports…"
        value={search}
        onChange={e => onSearch(e.target.value)}
      />
      <nav ref={navRef}>
        {visibleGroups.map(group => (
          <div className="nav-group" key={group}>
            <div className="nav-group-title">{group}</div>
            {filtered.filter(r => r.group === group).map(r => (
              <button
                key={r.id}
                ref={active === r.name ? activeRef : null}
                className={`nav-item${active === r.name ? ' active' : ''}`}
                onClick={() => { onSelect(r.name); if (onClose) onClose(); }}
              >
                <span className="nav-icon">{r.icon}</span>
                {r.name}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}

// — Main page
export default function Dashboard({ initialData, initialReport }) {
  const [activeReport, setActiveReport] = useState(initialReport || DEFAULT_REPORT.name);
  const [data, setData] = useState(initialData || null);
  const [loading, setLoading] = useState(!initialData);
  const [viewMode, setViewMode] = useState('district');
  const [divFilter, setDivFilter] = useState('all');
  const [search, setSearch] = useState('');

  // Excel comparison
  const [compareFiles, setCompareFiles] = useState([]);
  const [activeCompare, setActiveCompare] = useState('');
  const [compareStatus, setCompareStatus] = useState(null); // {type:'success'|'error'|'warn', msg}
  const [compareLoading, setCompareLoading] = useState(false);

  // — Supabase auth
  const [supaUser, setSupaUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [savingCloud, setSavingCloud] = useState(false);

  // Per-tab config (column_name + thresholds) — loaded from Supabase, editable by admin
  const [tabConfigs, setTabConfigs] = useState({});
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showCfgPanel, setShowCfgPanel] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cfgTabId, setCfgTabId] = useState('');
  const [cfgDraft, setCfgDraft] = useState({ column_name: '', good: 60, moderate: 25 });

  // Restore comparison state from sessionStorage after hydration.
  // Uses versioned keys (v2) so old-format data (pre-multi-sheet refactor) is ignored.
  useEffect(() => {
    try {
      // Clear any stale old-format keys
      sessionStorage.removeItem('pacs_compareFiles');
      sessionStorage.removeItem('pacs_activeCompare');
      const files = sessionStorage.getItem('pacs_compareFiles_v2');
      if (files) {
        const parsed = JSON.parse(files);
        // Validate: each entry must have a .sheets object (new format)
        const valid = Array.isArray(parsed)
          ? parsed.filter(f => f && f.sheets && typeof f.sheets === 'object')
          : [];
        if (valid.length) setCompareFiles(valid);
      }
      const active = sessionStorage.getItem('pacs_activeCompare_v2');
      if (active) setActiveCompare(active);
    } catch {}
  }, []);

  // Persist comparison state so browser refresh restores it
  useEffect(() => {
    try { sessionStorage.setItem('pacs_compareFiles_v2', JSON.stringify(compareFiles)); } catch {}
  }, [compareFiles]);
  useEffect(() => {
    try { sessionStorage.setItem('pacs_activeCompare_v2', activeCompare); } catch {}
  }, [activeCompare]);

  // — Supabase: auth session + load cloud data on mount
  useEffect(() => {
    // Check existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) { setSupaUser(session.user); checkIsAdmin(session.user.email); }
    });
    // Listen for sign-in / sign-out
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) { setSupaUser(session.user); checkIsAdmin(session.user.email); }
      else { setSupaUser(null); setIsAdmin(false); }
    });

    // Load the last Excel upload saved by an admin
    loadCloudExcel();
    // Load dashboard config (thresholds)
    loadCloudConfig();

    // Close admin dropdown when clicking outside
    const closeMenu = (e) => {
      if (!e.target.closest('.admin-bar')) setShowAdminMenu(false);
    };
    document.addEventListener('mousedown', closeMenu);

    return () => { subscription.unsubscribe(); document.removeEventListener('mousedown', closeMenu); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkIsAdmin(email) {
    try {
      const { data, error } = await supabase.from('admin_users').select('email').eq('email', email).maybeSingle();
      if (error) console.warn('[PACS Admin] checkIsAdmin error:', error.message);
      setIsAdmin(!!data);
    } catch (err) {
      console.warn('[PACS Admin] checkIsAdmin threw:', err.message);
    }
  }

  async function loadCloudExcel() {
    try {
      const { data } = await supabase
        .from('excel_upload')
        .select('id, file_name, sheets_data, is_selected, uploaded_at, uploaded_by')
        .order('uploaded_at', { ascending: false });
      if (!data?.length) return;
      const entries = data
        .filter(r => r.sheets_data && r.file_name)
        .map(r => ({ id: r.id, name: r.file_name, sheets: r.sheets_data }));
      if (!entries.length) return;
      setCompareFiles(entries);
      const selected = data.find(r => r.is_selected) || data[0];
      if (selected) setActiveCompare(selected.file_name);
    } catch { /* network issue — silently skip */ }
  }

  async function loadCloudConfig() {
    try {
      const { data } = await supabase.from('dashboard_config').select('*');
      if (!data?.length) return;
      const configs = {};
      for (const row of data) {
        if (row.key?.startsWith('tab:')) {
          const tabId = row.key.slice(4);
          configs[tabId] = {
            column_name: row.column_name || '',
            good: row.value?.good ?? 60,
            moderate: row.value?.moderate ?? 25,
          };
        }
      }
      setTabConfigs(configs);
    } catch { /* silently skip */ }
  }

  const saveCloudExcel = useCallback(async function saveCloudExcel(fileName, sheetsData) {
    setSavingCloud(true);
    try {
      // Mark all existing files as not selected
      await supabase.from('excel_upload').update({ is_selected: false }).neq('id', 0);
      // Upsert by file_name (insert new or replace existing same-name upload)
      const { error } = await supabase.from('excel_upload').upsert(
        {
          file_name: fileName,
          sheets_data: sheetsData,
          uploaded_at: new Date().toISOString(),
          uploaded_by: supaUser?.email || '',
          is_selected: true,
        },
        { onConflict: 'file_name' }
      );
      if (error) throw error;
      // Reload the full list from Supabase so the admin sees all uploaded files
      await loadCloudExcel();
      setCompareStatus({ type: 'success', msg: `✓ Saved to cloud: ${fileName} — selected for comparison.` });
    } catch (err) {
      setCompareStatus({ type: 'warn', msg: `Loaded locally but cloud save failed: ${err.message}` });
    } finally {
      setSavingCloud(false);
    }
  }, [supaUser]);

  async function selectCloudExcel(fileName) {
    setActiveCompare(fileName);
    try {
      await supabase.from('excel_upload').update({ is_selected: false }).neq('id', 0);
      if (fileName) {
        await supabase.from('excel_upload').update({ is_selected: true }).eq('file_name', fileName);
      }
    } catch { /* silently skip — local state already updated */ }
  }

  async function saveTabConfig(tabId, draft) {
    try {
      await supabase.from('dashboard_config').upsert({
        key: `tab:${tabId}`,
        column_name: draft.column_name || null,
        value: { good: draft.good, moderate: draft.moderate },
        updated_by: supaUser?.email || '',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      const entry = { column_name: draft.column_name || '', good: draft.good, moderate: draft.moderate };
      setTabConfigs(prev => ({ ...prev, [tabId]: entry }));
      if (tabId === activeConfig.id) {
        setPerfCfg({ critBelow: draft.moderate, goodAbove: draft.good });
      }
      setShowCfgPanel(false);
    } catch (err) {
      alert('Failed to save config: ' + err.message);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError(''); setLoginLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword });
    setLoginLoading(false);
    if (error) setLoginError(error.message);
    else setLoginOpen(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setIsAdmin(false);
  }

  // Performance threshold config + column override
  const [perfCfg, setPerfCfg] = useState({ critBelow: 25, goodAbove: 60 });
  const [perfColOverride, setPerfColOverride] = useState(null); // null = auto-detect

  const skipFirstFetch = useRef(Boolean(initialData));
  const activeConfig = REPORTS.find(r => r.name === activeReport) || REPORTS[0];

  // Sync perfCfg thresholds whenever the active tab or cloud configs change
  useEffect(() => {
    const cfg = tabConfigs[activeConfig.id];
    if (cfg) setPerfCfg({ critBelow: cfg.moderate ?? 25, goodAbove: cfg.good ?? 60 });
  }, [activeConfig.id, tabConfigs]);

  // Sync perfColOverride by name when data loads for the active tab.
  // Use a joined string instead of the array reference so the effect only
  // re-runs when headers actually change, not on every data object recreation.
  const headersKey = data?.headers?.join('\x00') ?? '';
  useEffect(() => {
    if (!data?.headers) return;
    const cfg = tabConfigs[activeConfig.id];
    if (cfg?.column_name) {
      const target = cfg.column_name.toLowerCase().trim();
      const idx = data.headers.findIndex(h => (h || '').toLowerCase().trim() === target);
      if (idx >= 0) setPerfColOverride(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headersKey, activeConfig.id, tabConfigs]);

  // All selectable numeric columns for the perf card (excludes S.No and name col)
  // When a column override is selected, rebuild progressData client-side
  const effectivePerfData = useMemo(() => {
    if (perfColOverride === null || !data?.rows || !data?.headers) {
      return data?.progressData || [];
    }
    const nameColIdx = clientFindNameColIdx(data.headers);
    const distRows = data.rows.filter(r => !r.isTotal && !r.isDivision);
    return distRows.map(r => ({
      district: (r.cells[nameColIdx] || '').trim(),
      value: (r.cells[perfColOverride] || '').trim(),
      division: r.division,
    }));
  }, [data, perfColOverride]);

  const effectivePerfColumn = useMemo(() => {
    if (perfColOverride !== null && data?.headers) {
      return { colIdx: perfColOverride, colHeader: data.headers[perfColOverride] };
    }
    return data?.progressColumn || null;
  }, [data, perfColOverride]);

  // Pick the right sheet from the uploaded Excel for the current active report tab.
  const { compareEntry, matchedSheetName, allSheetNames } = useMemo(() => {
    if (!activeCompare) return { compareEntry: null, matchedSheetName: null, allSheetNames: [] };
    const file = compareFiles.find(f => f.name === activeCompare);
    if (!file?.sheets) return { compareEntry: null, matchedSheetName: null, allSheetNames: [] };
    const names = Object.keys(file.sheets);
    const tabName = REPORTS.find(r => r.name === activeReport)?.tabName || '';
    // Try tabName FIRST (exact GSheet tab name = exact Excel sheet name by design),
    // then fall back to display-name word-overlap matching.
    // This prevents e.g. "PACS as Jan Aushadhi Kendra" word-matching "Pashu Aushadhi Kendra"
    // instead of the correct "PM as PMJAK" sheet.
    const matched = (tabName ? findMatchingSheet(file.sheets, tabName) : null)
      || findMatchingSheet(file.sheets, activeReport);
    return {
      compareEntry: matched ? file.sheets[matched] : null,
      matchedSheetName: matched,
      allSheetNames: names,
    };
  }, [compareFiles, activeCompare, activeReport]);

  const compareData = compareEntry?.data ?? null; // district rows lookup
  const compareTotals = compareEntry?.totals ?? null; // column totals for KPI cards

  // Aggregate Excel district data into division totals so Division view can compare.
  // Percentage columns (all per-district values ≤ 1) are averaged, not summed,
  // so the decimal→percent normalization (×100) still applies at compare time.
  const compareDataByDivision = useMemo(() => {
    if (!compareData) return null;
    // Phase 1: accumulate sums + track whether every district value is a decimal (≤ 1)
    const acc = {}; // { divKey: { colName: { sum, count, allDecimal } } }
    Object.entries(compareData).forEach(([distKey, colVals]) => {
      const div = getDivisionForDistrict(distKey);
      if (!div) return;
      const divKey = div.toLowerCase();
      if (!acc[divKey]) acc[divKey] = {};
      Object.entries(colVals).forEach(([col, val]) => {
        if (!acc[divKey][col]) acc[divKey][col] = { sum: 0, count: 0, allDecimal: true };
        acc[divKey][col].sum += val;
        acc[divKey][col].count += 1;
        if (val > 1) acc[divKey][col].allDecimal = false;
      });
    });
    // Phase 2: for decimal-percentage columns use average; otherwise use sum
    const result = {};
    Object.entries(acc).forEach(([divKey, cols]) => {
      result[divKey] = {};
      Object.entries(cols).forEach(([col, { sum, count, allDecimal }]) => {
        result[divKey][col] = allDecimal ? sum / count : sum;
      });
    });
    return result;
  }, [compareData]);

  // isSwitch=true only when the user picks a different report — resets filters/column.
  // Auto-refresh and manual Refresh button both call with isSwitch=false (default)
  // so the selected column, division filter, and Excel comparison are all retained.
  const loadReport = useCallback(async (reportName, isSwitch = false) => {
    setLoading(true);
    if (isSwitch) {
      setDivFilter('all');
      setPerfColOverride(null);
      setShowCfgPanel(false);
      setShowAdminMenu(false);
    }
    const cfg = REPORTS.find(r => r.name === reportName) || { tabName: reportName };
    try {
      const res = await fetch(`/api/sheets?tab=${encodeURIComponent(cfg.tabName)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setData({ error: err.message, headers: [], rows: [], kpis: [], divisions: [], progressColumn: null, progressData: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skipFirstFetch.current) { skipFirstFetch.current = false; return; }
    setShowCfgPanel(false);
    loadReport(activeReport, true); // report switch → reset filters & column
  }, [activeReport, loadReport]);

  useEffect(() => {
    const t = setInterval(() => loadReport(activeReport), REFRESH_MS);
    return () => clearInterval(t);
  }, [activeReport, loadReport]);

  // Parse uploaded Excel — reads ALL sheets so one upload works for all report tabs
  const handleCompareUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = '';
    setCompareLoading(true);
    setCompareStatus({ type: 'warn', msg: '⟳ Parsing Excel file — reading all sheets…' });

    let XLSX;
    try {
      const mod = await import('xlsx');
      XLSX = mod.default || mod;
    } catch (err) {
      setCompareLoading(false);
      setCompareStatus({ type: 'error', msg: `Could not load Excel parser: ${err.message}` });
      setTimeout(() => setCompareStatus(null), 6000);
      return;
    }

    const results = [];
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const isCSV = file.name.toLowerCase().endsWith('.csv');
        const wb = isCSV
          ? XLSX.read(new TextDecoder().decode(buf), { type: 'string' })
          : XLSX.read(new Uint8Array(buf), { type: 'array' });

        // Parse every sheet; store as { sheetName → { data, totals, hdrsLower, count } }
        const sheets = {};
        for (const sName of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sName], { header: 1, defval: '' });
          const parsed = parseSheetData(rows);
          if (parsed) sheets[sName] = parsed;
        }

        const sheetCount = Object.keys(sheets).length;
        if (sheetCount === 0) {
          results.push({ name: file.name, ok: false, msg: 'no usable district data found in any sheet' });
          continue;
        }

        const entry = { name: file.name, sheets };
        setCompareFiles(prev => {
          const idx = prev.findIndex(f => f.name === file.name);
          if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u; }
          return [...prev, entry];
        });
        setActiveCompare(file.name);
        results.push({ name: file.name, ok: true, sheetCount, sheetNames: Object.keys(sheets) });
        // If admin, persist to Supabase so all viewers see the same comparison
        if (isAdmin) await saveCloudExcel(file.name, sheets);
      } catch (err) {
        results.push({ name: file.name, ok: false, msg: err.message });
        console.warn('[PACS] Excel parse error:', err.message);
      }
    }

    setCompareLoading(false);
    const ok = results.filter(r => r.ok);
    const bad = results.filter(r => !r.ok);
    if (ok.length && !bad.length) {
      setCompareStatus({ type: 'success', msg: `✓ Loaded: ${ok.map(r => `${r.name} — ${r.sheetCount} sheet(s) found: ${r.sheetNames.join(' | ')}`).join('; ')}` });
    } else if (ok.length) {
      setCompareStatus({ type: 'warn', msg: `Loaded ${ok.length} file(s). Failed: ${bad.map(r => `${r.name} — ${r.msg}`).join('; ')}` });
    } else {
      setCompareStatus({ type: 'error', msg: `Failed: ${bad.map(r => `${r.name} — ${r.msg}`).join('; ')}` });
    }
    setTimeout(() => setCompareStatus(null), 15000);
  }, [isAdmin, saveCloudExcel]);

  const districtRows = useMemo(() => (data?.rows || []).filter(r => !r.isTotal && !r.isDivision), [data]);
  const rowCount = useMemo(() => {
    if (viewMode === 'division') return DIVISION_NAMES.length;
    if (divFilter === 'all') return districtRows.length;
    return districtRows.filter(r => (r.division || getDivisionOf(r.cells?.[0] || r.cells?.[1] || '')) === divFilter).length;
  }, [viewMode, divFilter, districtRows]);

  return (
    <>
      <Head>
        <title>{`${activeReport} · Punjab Cooperative Department`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <header className="topbar">
        <button className="btn-hamburger" onClick={() => setSidebarOpen(v => !v)} aria-label="Open menu">☰</button>
        <div className="brand">
          <img className="brand-emblem" src="/logo.svg" alt="Punjab Cooperative Department logo" />
          <div>
            <h1 className="brand-title">
              Cooperative Department<span className="brand-sep"> | </span>State-Level Review
            </h1>
            <p className="brand-sub">Live monitoring · 17 reports · Government of Punjab</p>
          </div>
        </div>
        <span className="topbar-active-report">{activeReport}</span>
        <div className="topbar-right">
          <div className="sync-status">
            <span className="sync-dot" />
            <span>Live · Last sync {data?.lastFetched ? formatTime(data.lastFetched) : '—'}</span>
          </div>
          <button className="btn-refresh" disabled={loading} onClick={() => loadReport(activeReport)}>
            <span className={loading ? 'spin-icon' : ''}>⟳</span>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn-print" onClick={() => window.print()}>🖨 Print</button>

          {/* Admin controls */}
          {isAdmin ? (
            <div className="admin-bar" style={{ position: 'relative' }}>
              <button
                className="btn-admin-avatar"
                onClick={() => setShowAdminMenu(v => !v)}
                title={supaUser?.email}
              >
                ⚙ Admin ▾
              </button>
              {showAdminMenu && (
                <div className="admin-dropdown" onClick={() => setShowAdminMenu(false)}>
                  <p className="admin-dropdown-email">{supaUser?.email}</p>
                  <button className="admin-dropdown-item" onClick={() => {
                    const existing = tabConfigs[activeConfig.id];
                    setCfgTabId(activeConfig.id);
                    setCfgDraft({ column_name: existing?.column_name || '', good: existing?.good ?? 60, moderate: existing?.moderate ?? 25 });
                    setShowCfgPanel(true);
                  }}>
                    ⚙ Configure tab
                  </button>
                  <button className="admin-dropdown-item admin-dropdown-item-out" onClick={handleLogout}>
                    🚪 Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="btn-admin" onClick={() => { setLoginOpen(true); setLoginError(''); setLoginPassword(''); }}>
              🔒 Admin Login
            </button>
          )}
        </div>

        {/* — Login modal — */}
        {loginOpen && (
          <div className="modal-backdrop" onClick={() => setLoginOpen(false)}>
            <form className="modal-box" onClick={e => e.stopPropagation()} onSubmit={handleLogin}>
              <h2 className="modal-title">Admin Login</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>Sign in to manage dashboard configuration and upload Excel data.</p>
              <label className="modal-label">Email</label>
              <input className="modal-input" type="email" value={loginEmail} autoFocus
                onChange={e => setLoginEmail(e.target.value)} required />
              <label className="modal-label">Password</label>
              <input className="modal-input" type="password" value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)} required />
              {loginError && <p className="modal-err">{loginError}</p>}
              <div className="modal-actions">
                <button className="btn-primary" type="submit" disabled={loginLoading}>
                  {loginLoading ? 'Signing in…' : 'Sign in'}
                </button>
                <button className="btn-ghost" type="button" onClick={() => setLoginOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {/* — Admin config panel — */}
        {isAdmin && showCfgPanel && (
          <div className="admin-cfg-panel">
            <h3 className="cfg-title">Tab Configuration</h3>

            {/* Tab selector */}
            <div className="cfg-row">
              <label className="cfg-label">Tab</label>
              <select className="cfg-input" value={cfgTabId} onChange={e => {
                const id = e.target.value;
                setCfgTabId(id);
                const ex = tabConfigs[id];
                setCfgDraft({ column_name: ex?.column_name || '', good: ex?.good ?? 60, moderate: ex?.moderate ?? 25 });
              }}>
                {REPORTS.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>

            {/* Column Name */}
            <div className="cfg-row">
              <label className="cfg-label">Performance column name</label>
              <input className="cfg-input" type="text" placeholder="e.g. percentage total"
                value={cfgDraft.column_name}
                onChange={e => setCfgDraft(d => ({ ...d, column_name: e.target.value }))} />
            </div>

            {/* Thresholds */}
            <div className="cfg-row">
              <label className="cfg-label">Good threshold (≥ this % = Good)</label>
              <input className="cfg-input" type="number" min="1" max="100"
                value={cfgDraft.good}
                onChange={e => setCfgDraft(d => ({ ...d, good: Number(e.target.value) }))} />
            </div>
            <div className="cfg-row">
              <label className="cfg-label">Moderate threshold (≥ this % = Moderate, below = Critical)</label>
              <input className="cfg-input" type="number" min="1" max="100"
                value={cfgDraft.moderate}
                onChange={e => setCfgDraft(d => ({ ...d, moderate: Number(e.target.value) }))} />
            </div>
            <p className="cfg-hint">
              Critical &lt;{cfgDraft.moderate}% · Moderate {cfgDraft.moderate}–{cfgDraft.good - 1}% · Good ≥{cfgDraft.good}%
            </p>
            {cfgDraft.moderate >= cfgDraft.good && (
              <p className="cfg-hint" style={{ color: '#c74343' }}>⚠ Moderate threshold must be less than Good threshold.</p>
            )}
            <div className="cfg-actions">
              <button className="btn" disabled={cfgDraft.moderate >= cfgDraft.good}
                onClick={() => saveTabConfig(cfgTabId, cfgDraft)}>Save &amp; publish</button>
              <button className="btn btn-ghost" onClick={() => setShowCfgPanel(false)}>Cancel</button>
            </div>
            {savingCloud && <p className="cfg-hint">Saving Excel to cloud…</p>}
          </div>
        )}
      </header>

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="shell">
        <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
          <Sidebar active={activeReport} onSelect={setActiveReport} search={search}
            onSearch={setSearch} onClose={() => setSidebarOpen(false)} />
        </aside>

        <main className="main-content">
          <div className="page-header">
            <div>
              <div className="page-eyebrow">State Overview / Reports</div>
              <h2 className="page-title">{activeReport}</h2>
              <p className="page-subtitle">{activeConfig.subtitle}</p>
            </div>
          </div>

          <KPIGrid
            kpis={(data?.kpis || []).filter(k => !/sewadar|salesman|secretary/i.test(k.label))}
            loading={loading}
            compareTotals={compareTotals}
          />

          <PerformanceCard
            progressData={effectivePerfData}
            progressColumn={effectivePerfColumn}
            loading={loading}
            perfCfg={perfCfg}
            isAdmin={isAdmin}
            onOpenCfg={() => {
              const existing = tabConfigs[activeConfig.id];
              setCfgTabId(activeConfig.id);
              setCfgDraft({ column_name: existing?.column_name || '', good: existing?.good ?? 60, moderate: existing?.moderate ?? 25 });
              setShowCfgPanel(true);
            }}
          />

          <section className="data-panel">
            <div className="data-panel-head">
              <div className="panel-title-group">
                <div className="panel-icon-box">{activeConfig.icon}</div>
                <div>
                  <h3 className="panel-title">{activeReport}</h3>
                  <p className="panel-subtitle">{activeConfig.subtitle}</p>
                </div>
              </div>
              <FilterBar
                viewMode={viewMode}
                onViewMode={m => { setViewMode(m); setDivFilter('all'); }}
                divFilter={divFilter}
                onDivFilter={setDivFilter}
                hasData={Boolean(data?.headers.length)}
                isMasterSheet={data?.isMasterSheet}
                onCSV={() => downloadCSV(data.headers, data.rows, `${activeReport.replace(/[^a-z0-9]+/gi, '_')}.csv`)}
                compareFiles={compareFiles}
                activeCompare={activeCompare}
                onCompareSelect={isAdmin ? selectCloudExcel : setActiveCompare}
                onCompareUpload={handleCompareUpload}
                compareLoading={compareLoading}
                isAdmin={isAdmin}
              />
            </div>

            {compareLoading && (
              <div className="cmp-status cmp-status-warn cmp-loading-bar">
                <span className="cmp-spinner">⟳</span> Parsing Excel — reading all sheets, please wait…
              </div>
            )}
            {!compareLoading && compareStatus && (
              <div className={`cmp-status cmp-status-${compareStatus.type}`}>
                {compareStatus.msg}
              </div>
            )}
            {!compareLoading && activeCompare && !matchedSheetName && allSheetNames.length > 0 && (
              <div className="cmp-status cmp-status-warn">
                ⚠ No sheet in the Excel matches &quot;{activeReport}&quot;. Available sheets: <strong>{allSheetNames.join(', ')}</strong>. Rename a sheet to match the report name (or part of it).
              </div>
            )}

            <DataTable
              headers={data?.headers}
              rows={data?.rows || []}
              loading={loading}
              viewMode={viewMode}
              divFilter={divFilter}
              progressColumn={data?.progressColumn}
              isMasterSheet={data?.isMasterSheet}
              compareData={compareData}
              compareDataByDivision={compareDataByDivision}
              perfCfg={perfCfg}
              error={data?.error}
            />

            <div className="data-panel-footer">
              <span>
                {loading ? 'Syncing…' : data?.isMasterSheet
                  ? `${(data?.rows || []).length} rows shown (division summary)`
                  : `${rowCount} ${viewMode === 'division' ? 'division' : 'district'}${rowCount !== 1 ? 's' : ''} shown`}
                {activeCompare && matchedSheetName && (
                  <span className="cmp-badge"> · Comparing: {activeCompare} → <em>{matchedSheetName}</em></span>
                )}
                {activeCompare && !matchedSheetName && (
                  <span className="cmp-badge cmp-badge-warn"> · {activeCompare} ⚠ no sheet match</span>
                )}
              </span>
              <span>Auto-refresh every 5 min · ISR 60s</span>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}

export async function getStaticProps() {
  try {
    const data = await fetchSheetData(DEFAULT_REPORT.tabName);
    return { props: { initialData: data, initialReport: DEFAULT_REPORT.name }, revalidate: 60 };
  } catch {
    return { props: { initialData: null, initialReport: DEFAULT_REPORT.name }, revalidate: 60 };
  }
}