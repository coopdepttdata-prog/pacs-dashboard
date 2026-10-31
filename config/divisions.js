// Division → Districts mapping (exact names from CRM Report 14.10.2026)
// Alternate/old names included so fuzzy matching works for any sheet spelling.
export const DIVISIONS = {
  Ferozepur: [
    'Bathinda', 'Faridkot', 'Fazilka',
    'Ferozepur', 'Firozpur',            // Firozpur = alternate spelling
    'Mansa', 'Moga',
    'Sri Muktsar Sahib', 'Muktsar',     // Muktsar = short form
  ],
  Jalandhar: [
    'Amritsar', 'Gurdaspur', 'Hoshiarpur', 'Jalandhar', 'Kapurthala',
    'Pathankot', 'Tarn Taran',
    'SBS Nagar', 'Nawanshahr',          // Nawanshahr = old name for SBS Nagar
    'Shaheed Bhagat Singh Nagar',
  ],
  Patiala: [
    'Barnala', 'Fatehgarh Sahib', 'Ludhiana',
    'Malerkotla',                      // 23rd district (added 2021, carved from Sangrur)
    'Patiala', 'Sangrur',
    'Ropar', 'Rupnagar',                // Rupnagar = official name, Ropar = common name
    'SAS Nagar', 'Mohali',              // Mohali = common name for SAS Nagar
  ],
};

// Fuzzy match: return division name for a given district string, or null
export function getDivisionForDistrict(districtStr) {
  if (!districtStr) return null;
  const s = districtStr.toLowerCase().trim();
  for (const [div, districts] of Object.entries(DIVISIONS)) {
    for (const d of districts) {
      if (s.includes(d.toLowerCase()) || d.toLowerCase().includes(s)) {
        return div;
      }
    }
  }
  return null;
}

export const DIVISION_NAMES = Object.keys(DIVISIONS);