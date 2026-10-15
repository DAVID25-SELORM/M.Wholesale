import { useQueryClient } from '@tanstack/react-query'
import { Download, FileSpreadsheet, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, InlineError, PageHeader, Tabs } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { loadStockLookups, runDatabaseImport, runOpeningStock, stockCheckOutcomes, type RowOutcome } from '@/services/imports'
import { toCsv } from './csv'
import { planOpeningStock, type OpeningPlanRow } from './openingStock'
import { FileProblem, readTable } from './parseFile'
import { SPECS, matchHeaders, templateCsv, toImportRows, type HeaderMatch, type ImportKind, type ImportRow } from './specs'

const PERMISSION: Record<ImportKind, string> = { products: 'products.create', suppliers: 'suppliers.create', opening_stock: 'inventory.opening_stock' }
type Phase = 'idle' | 'reading' | 'ready' | 'checking' | 'checked' | 'importing' | 'done'

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

const TONE = { VALID: 'green', CREATED: 'green', EXISTS: 'slate', ERROR: 'red' } as const
const LABEL = { VALID: 'Ready', CREATED: 'Imported', EXISTS: 'Already there', ERROR: 'Problem' } as const

export function ImportPage() {
  const { ability } = useSession()
  const qc = useQueryClient()
  const allowed = (Object.keys(SPECS) as ImportKind[]).filter((k) => ability.can(PERMISSION[k]))
  const [kind, setKind] = useState<ImportKind>(allowed[0] ?? 'products')
  const [phase, setPhase] = useState<Phase>('idle')
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<ImportRow[]>([])
  const [match, setMatch] = useState<HeaderMatch | null>(null)
  const [outcomes, setOutcomes] = useState<RowOutcome[]>([])
  const [plan, setPlan] = useState<OpeningPlanRow[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const spec = SPECS[kind]

  function reset(nextKind?: ImportKind) {
    if (nextKind) setKind(nextKind)
    setPhase('idle'); setFileName(''); setRows([]); setMatch(null); setOutcomes([]); setPlan([]); setError(null); setOnlyProblems(false)
    if (input.current) input.current.value = ''
  }

  async function choose(file: File | undefined) {
    if (!file) return
    reset()
    setFileName(file.name)
    setPhase('reading')
    try {
      const table = await readTable(file)
      const m = matchHeaders(table[0]!, spec)
      setMatch(m)
      setRows(toImportRows(table, m.mapping))
      setPhase('ready')
      if (m.missing.length > 0) setError(`The file is missing the required column${m.missing.length > 1 ? 's' : ''}: ${m.missing.map((c) => c.label).join(', ')}. Download the template to see the headings.`)
    } catch (e) {
      setError(e instanceof FileProblem ? e.message : toAppError(e).message)
      setPhase('idle')
    }
  }

  async function check() {
    setError(null)
    setPhase('checking')
    setProgress({ done: 0, total: rows.length })
    try {
      if (kind === 'opening_stock') {
        const p = planOpeningStock(rows, await loadStockLookups(rows))
        setPlan(p)
        setOutcomes(stockCheckOutcomes(p))
      } else {
        setOutcomes(await runDatabaseImport(kind, rows, true, (done) => setProgress({ done, total: rows.length })))
      }
      setPhase('checked')
    } catch (e) {
      setError(toAppError(e).message)
      setPhase('ready')
    }
  }

  async function doImport() {
    setError(null)
    setPhase('importing')
    setProgress({ done: 0, total: rows.length })
    try {
      const result = kind === 'opening_stock'
        ? await runOpeningStock(plan, `Imported from ${fileName}`, (done) => setProgress({ done, total: rows.length }))
        : await runDatabaseImport(kind, rows, false, (done) => setProgress({ done, total: rows.length }))
      setOutcomes(result)
      setPhase('done')
      await Promise.all(['products', 'suppliers', 'stock', 'balances', 'stock-documents', 'expiring', 'stock-valuation', 'supplier-options', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
    } catch (e) {
      setError(toAppError(e).message)
      setPhase('checked')
    }
  }

  const count = (s: RowOutcome['status']) => outcomes.filter((o) => o.status === s).length
  const problems = outcomes.filter((o) => o.status === 'ERROR')
  const shown = (onlyProblems ? problems : outcomes).slice(0, 500)
  const importable = count('VALID')
  const busy = phase === 'reading' || phase === 'checking' || phase === 'importing'

  if (allowed.length === 0) {
    return <><PageHeader title="Import data" /><Card><CardBody><p className="text-sm text-slate-600">Importing needs permission to create products, suppliers or opening stock for the whole organization.</p></CardBody></Card></>
  }

  return (
    <>
      <PageHeader title="Import data" description="Bring your existing lists in from Excel or CSV. Every file is checked first, row by row, before anything is saved." />
      <div className="mb-4">
        <Tabs
          label="What to import"
          value={kind}
          onChange={(k) => reset(k as ImportKind)}
          items={allowed.map((k) => ({ id: k, label: SPECS[k].title }))}
        />
      </div>

      <Card>
        <CardHeader title={`1. Get the ${spec.title.toLowerCase()} template`} description={spec.summary} actions={
          <Button variant="secondary" size="sm" onClick={() => download(`${kind}-template.csv`, templateCsv(spec))}><Download className="h-4 w-4" aria-hidden /> Download template</Button>
        } />
        <CardBody>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-brand-700">What goes in each column</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Columns</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-1.5 pr-4">Column</th><th className="pr-4">Needed</th><th>Notes</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {spec.columns.map((c) => (
                    <tr key={c.key}>
                      <td className="py-1.5 pr-4 font-mono text-xs">{c.key}</td>
                      <td className="pr-4">{c.required ? <Badge tone="amber">required</Badge> : <span className="text-slate-400">optional</span>}</td>
                      <td className="text-slate-600">{c.hint}{c.example ? <span className="text-slate-400"> · e.g. {c.example}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </CardBody>
      </Card>

      <div className="mt-4">
        <Card>
          <CardHeader title="2. Choose your file" description="Excel (.xlsx) or CSV, up to 5,000 rows. The first row must be the column headings; other spellings of the headings are recognised." />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-white px-4 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-brand-500">
                <FileSpreadsheet className="h-4 w-4" aria-hidden /> Choose file
                <input ref={input} type="file" accept=".xlsx,.csv,.txt" className="sr-only" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} aria-label="Choose a file to import" />
              </label>
              {fileName && <span className="text-sm text-slate-600">{fileName}{rows.length > 0 ? ` · ${rows.length.toLocaleString()} rows` : ''}</span>}
              {phase !== 'idle' && !busy && <Button variant="ghost" size="sm" onClick={() => reset()}><RotateCcw className="h-4 w-4" aria-hidden /> Start over</Button>}
              {phase === 'reading' && <span className="text-sm text-slate-500">Reading…</span>}
            </div>
            <InlineError message={error} />
            {match && (
              <p className="text-sm text-slate-600">
                Recognised {match.mapping.size} column{match.mapping.size === 1 ? '' : 's'}.
                {match.unrecognised.length > 0 && <span className="text-amber-700"> Ignored (not recognised): {match.unrecognised.join(', ')}.</span>}
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      {(phase === 'ready' || phase === 'checking') && rows.length > 0 && !match?.missing.length && (
        <div className="mt-4">
          <Card>
            <CardHeader title="3. Check the file" description="Nothing is saved yet. We read every row and tell you what would happen." />
            <CardBody className="space-y-3">
              <Button onClick={() => void check()} loading={phase === 'checking'}>Check {rows.length.toLocaleString()} rows</Button>
              {phase === 'checking' && <Progress done={progress.done} total={progress.total} />}
            </CardBody>
          </Card>
        </div>
      )}

      {(phase === 'checked' || phase === 'importing' || phase === 'done') && (
        <div className="mt-4">
          <Card>
            <CardHeader
              title={phase === 'done' ? 'Result' : '3. Check result'}
              description={phase === 'done' ? 'Rows marked “Imported” are saved. Fix the problems in your file and import it again: rows that already exist are left alone.' : 'Fix problems in your file and choose it again, or import the rows that are ready.'}
              actions={problems.length > 0 && (
                <Button variant="secondary" size="sm" onClick={() => download(`${kind}-problems.csv`, toCsv([['row', spec.keyColumn, 'problem'], ...problems.map((p) => [p.line, p.key, p.message ?? ''])]))}>
                  <Download className="h-4 w-4" aria-hidden /> Download problems
                </Button>
              )}
            />
            <CardBody className="space-y-4">
              <div className="flex flex-wrap gap-2" aria-live="polite">
                {phase === 'done' ? <Badge tone="green">{count('CREATED')} imported</Badge> : <Badge tone="green">{importable} ready</Badge>}
                {count('EXISTS') > 0 && <Badge tone="slate">{count('EXISTS')} already there</Badge>}
                {problems.length > 0 && <Badge tone="red">{problems.length} with a problem</Badge>}
              </div>
              {phase === 'importing' && <Progress done={progress.done} total={progress.total} />}
              {phase === 'checked' && importable > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                  <Button onClick={() => void doImport()}>Import {importable.toLocaleString()} {importable === 1 ? 'row' : 'rows'}</Button>
                  <p className="text-sm text-slate-600">
                    {problems.length > 0 ? `The ${problems.length} problem rows are skipped. ` : ''}
                    {kind === 'opening_stock' ? 'This adds to stock, so import a stock file only once. Every row is recorded in a stock document.' : 'Rows already in the system are left unchanged.'}
                  </p>
                </div>
              )}
              {phase === 'checked' && importable === 0 && <p className="text-sm text-slate-600">Nothing to import yet.</p>}
              {problems.length > 0 && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="h-4 w-4 rounded border-slate-300" /> Show only rows with a problem
                </label>
              )}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <caption className="sr-only">Row results</caption>
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">{spec.keyColumn.toUpperCase()}</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Details</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((o) => (
                      <tr key={o.line}>
                        <td className="px-3 py-1.5 tabular-nums text-slate-500">{o.line}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{o.key}</td>
                        <td className="px-3 py-1.5"><Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge></td>
                        <td className="px-3 py-1.5 text-slate-600">{o.message ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(onlyProblems ? problems : outcomes).length > 500 && <p className="px-3 py-2 text-xs text-slate-500">Showing the first 500 rows. Download the problems file to see all of them.</p>}
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  )
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress" className="h-2 w-full max-w-md overflow-hidden rounded-full bg-slate-200">
      <div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
    </div>
  )
}
