/**
 * TypeScript row types from a database's schema: `readSchema` reads the
 * tables, views and their columns through the query API (a read-scope
 * credential is enough) and `generateTypes` turns them into the source of
 * one `.ts` file, so `db.query<Orders>(…)` and live queries are typed
 * without hand-written interfaces. The `azora-gen` command (typegen-cli.ts)
 * wraps the two.
 *
 * The mapping follows SQLite's type-affinity rules on the declared type and
 * what the codec returns (codec.ts); the Go generator uses the same rules.
 */
import type { Database } from './database.ts'

/** One column, as `pragma_table_xinfo` describes it. */
export interface ColumnSchema {
  name: string
  /** The declared type, as written in CREATE TABLE (`''` when there is none). */
  type: string
  /** Declared NOT NULL (SQLite reports it too for the key of a WITHOUT ROWID table). */
  notNull?: boolean
  /** Position in the primary key, from 1; 0 or absent when the column is not part of it. */
  pk?: number
  /** Has a DEFAULT. */
  hasDefault?: boolean
  /** A generated column (virtual or stored): read, never written. */
  generated?: boolean
}

export interface TableSchema {
  name: string
  kind: 'table' | 'view'
  columns: ColumnSchema[]
}

/** Tables and views, and their columns, in schema order. */
export interface Schema {
  tables: TableSchema[]
}

export interface ReadSchemaOptions {
  /**
   * Only these tables or views, in the schema's order. A name that does
   * not exist throws {@link TypegenError}. Naming an internal table
   * (`azora_…`) includes it.
   */
  tables?: readonly string[]
}

export interface GenerateOptions {
  /**
   * Type integer columns `number | bigint` instead of `number`. The SDK
   * returns an integer as a number while that is exact (up to 2^53 - 1 in
   * magnitude) and as a bigint beyond; turn this on when a database stores
   * such values.
   */
  bigint?: boolean
  /** The command of the header's "regenerate" line (default: `azora-gen --out <file>`). */
  command?: string
}

/** A schema that cannot be read or has nothing to generate from. */
export class TypegenError extends Error {
  override name = 'TypegenError'
}

/** SQLite's own tables and the engine's (`azora_…`) are not application tables. */
function isInternal(name: string): boolean {
  const l = name.toLowerCase()
  return l.startsWith('sqlite_') || l.startsWith('azora_')
}

interface XinfoRow {
  tbl: string
  kind: string
  name: string
  type: string | null
  notnull: number | boolean
  dflt_value: unknown
  pk: number
  hidden: number
}

/**
 * Reads the tables and views of the database and their columns. Internal
 * tables (`sqlite_…`, `azora_…`) are skipped unless `tables` names them;
 * hidden columns of virtual tables are skipped (SELECT * does not return
 * them).
 */
export async function readSchema(db: Pick<Database, 'query'>, options: ReadSchemaOptions = {}): Promise<Schema> {
  const rows = await db.query<XinfoRow>(
    'SELECT m.name AS tbl, m.type AS kind, p.name AS name, p.type AS type, p."notnull" AS "notnull", p.dflt_value AS dflt_value, p.pk AS pk, p.hidden AS hidden ' +
      "FROM sqlite_schema m, pragma_table_xinfo(m.name) p WHERE m.type IN ('table', 'view') ORDER BY m.rowid, p.cid",
  )
  const wanted = options.tables ? new Set(options.tables) : null
  const tables: TableSchema[] = []
  const byName = new Map<string, TableSchema>()
  for (const r of rows) {
    if (wanted ? !wanted.has(r.tbl) : isInternal(r.tbl)) continue
    let t = byName.get(r.tbl)
    if (!t) {
      t = { name: r.tbl, kind: r.kind === 'view' ? 'view' : 'table', columns: [] }
      byName.set(r.tbl, t)
      tables.push(t)
    }
    if (r.hidden === 1) continue
    t.columns.push({
      name: r.name,
      type: r.type ?? '',
      notNull: Boolean(r.notnull),
      pk: Number(r.pk),
      hasDefault: r.dflt_value !== null && r.dflt_value !== undefined,
      generated: r.hidden === 2 || r.hidden === 3,
    })
  }
  if (wanted) {
    const missing = [...wanted].filter((n) => !byName.has(n))
    if (missing.length > 0) throw new TypegenError(`no table or view named ${missing.map((n) => `"${n}"`).join(', ')} in the database`)
  }
  return { tables }
}

/** What a declared type stores, by SQLite's affinity rules, plus the declared types the SDK treats specially. */
export type ColumnKind = 'integer' | 'real' | 'text' | 'blob' | 'json' | 'numeric' | 'any'

/**
 * The kind of a declared column type:
 *
 *   - `BOOLEAN`, `BOOL` -> integer: the server returns what is stored, 1 or 0
 *   - `JSON`, `JSONB` -> json
 *   - no declared type -> any
 *   - then SQLite's rules, in order: contains `INT` -> integer; `CHAR`,
 *     `CLOB` or `TEXT` -> text; `BLOB` -> blob; `REAL`, `FLOA` or `DOUB` ->
 *     real; anything else (NUMERIC, DECIMAL, DATE, DATETIME…) -> numeric
 */
export function columnKind(declared: string): ColumnKind {
  const t = declared.trim().toUpperCase()
  const base = t.replace(/\s*\(.*$/s, '')
  if (t === '') return 'any'
  if (base === 'BOOLEAN' || base === 'BOOL') return 'integer'
  if (base === 'JSON' || base === 'JSONB') return 'json'
  if (t.includes('INT')) return 'integer'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text'
  if (t.includes('BLOB')) return 'blob'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real'
  return 'numeric'
}

function tsType(kind: ColumnKind, o: GenerateOptions): string {
  switch (kind) {
    case 'integer':
      return o.bigint ? 'number | bigint' : 'number'
    case 'real':
      return 'number'
    case 'text':
      return 'string'
    case 'blob':
      return 'Uint8Array'
    case 'numeric':
      return 'number | string'
    case 'json':
    case 'any':
      return 'unknown'
  }
}

/** The lone `INTEGER` primary-key column of a table: an alias of the rowid, never null, assigned on insert. */
function rowidAlias(t: TableSchema): ColumnSchema | undefined {
  const pk = t.columns.filter((c) => (c.pk ?? 0) > 0)
  const only = pk[0]
  return t.kind === 'table' && pk.length === 1 && only && only.type.trim().toUpperCase() === 'INTEGER' ? only : undefined
}

/** `order_items` -> `OrderItems`: the parts between non-alphanumerics, capitalized; never singularized. */
export function typeName(table: string): string {
  const name = table
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p !== '')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
  if (name === '') return 'Table'
  return /^[0-9]/.test(name) ? `_${name}` : name
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function property(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name)
}

function inComment(s: string): string {
  return s.replace(/\*\//g, '*\\/').replace(/[\r\n]+/g, ' ')
}

/**
 * The source of one `.ts` file for the schema: per table or view a row
 * type named after it in PascalCase, per table an insert type `New<Table>`
 * (generated columns left out; columns with a default, nullable columns
 * and the integer primary key optional) and a `Tables` interface from
 * table name to row type. Tables and columns keep the schema's order, and
 * the text depends on nothing else, so it diffs cleanly.
 *
 * A column is `| null` unless it is NOT NULL or the integer primary key
 * (the rowid). Other primary keys of ordinary tables do accept NULL in
 * SQLite unless declared NOT NULL, and are typed so.
 */
export function generateTypes(schema: Schema, options: GenerateOptions = {}): string {
  // Names first: two tables may map to one name, and a New<Table> may meet a table's.
  const used = new Set<string>(['Tables'])
  const unique = (base: string): string => {
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`
    used.add(name)
    return name
  }
  const rowNames = schema.tables.map((t) => unique(typeName(t.name)))
  const newNames = schema.tables.map((t, i) => (t.kind === 'table' ? unique(`New${rowNames[i]}`) : ''))

  const out: string[] = [
    '// Generated by azora-gen from the database schema. Do not edit: changes are lost.',
    `// Regenerate with: ${options.command ?? 'azora-gen --out <this file>'}`,
    '//',
    options.bigint
      ? '// Integer columns are number | bigint: the SDK returns a bigint beyond 2^53 - 1.'
      : '// Integer columns are typed number; the SDK returns a bigint for values beyond',
    ...(options.bigint ? [] : ['// 2^53 - 1 (generate with --bigint when the database stores such values).']),
    '',
  ]
  schema.tables.forEach((t, i) => {
    const alias = rowidAlias(t)
    const nullable = (c: ColumnSchema): boolean => !c.notNull && c !== alias
    const type = (c: ColumnSchema): string => {
      const ts = tsType(columnKind(c.type), options)
      return ts === 'unknown' || !nullable(c) ? ts : `${ts} | null`
    }

    out.push(`/** A row of the ${t.kind} \`${inComment(t.name)}\`. */`, `export interface ${rowNames[i]} {`)
    for (const c of t.columns) out.push(`  ${property(c.name)}: ${type(c)}`)
    out.push('}', '')
    if (t.kind !== 'table') return

    out.push(`/** What an insert into \`${inComment(t.name)}\` takes. */`, `export interface ${newNames[i]} {`)
    for (const c of t.columns) {
      if (c.generated) continue
      const optional = c.hasDefault || nullable(c) || c === alias
      out.push(`  ${property(c.name)}${optional ? '?' : ''}: ${type(c)}`)
    }
    out.push('}', '')
  })
  out.push('/** Every table and view, by name. */', 'export interface Tables {')
  schema.tables.forEach((t, i) => out.push(`  ${property(t.name)}: ${rowNames[i]}`))
  out.push('}', '')
  return out.join('\n')
}
