/** The `sql` template tag: statements whose interpolated values travel as arguments. */
import type { InputValue } from './codec.ts'
import type { Statement } from './types.ts'

/** A statement built by {@link sql}. */
export class SqlStatement implements Statement {
  readonly sql: string
  readonly args: readonly InputValue[]

  constructor(sql: string, args: readonly InputValue[]) {
    this.sql = sql
    this.args = args
  }
}

/** Text spliced into a statement as it is (see {@link raw}). */
class RawSql {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

/**
 * Builds a statement from a template: every interpolated value becomes a
 * `?` argument, so values are never part of the SQL text.
 *
 * ```ts
 * await db.query(sql`SELECT * FROM orders WHERE customer = ${id} AND status = ${status}`)
 * ```
 *
 * Statements nest (their text and arguments are spliced in), and
 * `sql.join` builds lists.
 */
export function sql(strings: TemplateStringsArray, ...values: Array<InputValue | SqlStatement | RawSql>): SqlStatement {
  let text = strings[0] as string
  const args: InputValue[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v instanceof SqlStatement) {
      text += v.sql
      args.push(...v.args)
    } else if (v instanceof RawSql) {
      text += v.text
    } else {
      text += '?'
      args.push(v)
    }
    text += strings[i + 1] as string
  }
  return new SqlStatement(text, args)
}

/** Joins values (or statements) with a separator: `sql\`id IN (${sql.join(ids)})\``. */
sql.join = (items: ReadonlyArray<InputValue | SqlStatement>, separator = ', '): SqlStatement => {
  let text = ''
  const args: InputValue[] = []
  items.forEach((v, i) => {
    if (i > 0) text += separator
    if (v instanceof SqlStatement) {
      text += v.sql
      args.push(...v.args)
    } else {
      text += '?'
      args.push(v)
    }
  })
  return new SqlStatement(text, args)
}

/**
 * A quoted identifier (table or column name) for use inside {@link sql}:
 * `sql\`SELECT * FROM ${sql.id(table)}\``.
 */
sql.id = (name: string): RawSql => new RawSql('"' + name.replace(/"/g, '""') + '"')

/**
 * Text spliced in as it is. Never pass user input: it is not an argument
 * and is not escaped.
 */
sql.raw = (text: string): RawSql => new RawSql(text)
