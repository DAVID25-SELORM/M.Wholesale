/** Small RFC 4180 CSV reader: BOM, CRLF / LF, quoted fields with commas, newlines and doubled quotes, and , ; or tab as the delimiter. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const delimiter = detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue }
    if (ch === delimiter) { endField(); i++; continue }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); i++; continue }
    if (ch === '\n') { endRow(); i++; continue }
    field += ch; i++
  }
  if (field !== '' || row.length > 0) endRow()
  // blank lines (only empty fields) carry no data
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** The delimiter that appears most often outside quotes in the first line (comma when there is none). */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  let inQuotes = false
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!
  return n > 0 ? best : ','
}

const needsQuotes = /[",\r\n;]/
export const csvCell = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return needsQuotes.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows: (string | number | null | undefined)[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
