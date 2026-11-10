/**
 * Go types for units: a struct per unit's arguments (from its JSON
 * Schema) and a typed wrapper around `azora.Call[R]` of
 * github.com/azora-db/azora-go.
 */

/** What the generator reads of a unit (the manifest's `Unit`). */
export interface GoUnit {
  name: string
  kind: string
  internal: boolean
  description: string
  args: Record<string, unknown> | null
}

type Schema = Record<string, unknown>

const INITIALISMS = new Set(['id', 'url', 'uri', 'http', 'https', 'json', 'sql', 'api', 'uuid', 'ip', 'html', 'css', 'cpu', 'ttl', 'utc', 'xml', 'sha', 'db'])
const KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
  'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
])

/** An exported Go identifier for a name: `cart_id` and `cartId` become `CartID`. */
export function goName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let out = words.map((w) => (INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join('')
  if (out === '' || /^[0-9]/.test(out)) out = 'X' + out
  return out
}

/** A valid package name from a directory name. */
export function goPackage(name: string): string {
  let p = name.toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (p === '' || /^[0-9]/.test(p)) p = 'units' + p
  return KEYWORDS.has(p) ? p + 'pkg' : p
}

const isObject = (x: unknown): x is Schema => typeof x === 'object' && x !== null && !Array.isArray(x)

function isBytes(s: Schema): boolean {
  const p = s['properties']
  return s['type'] === 'object' && isObject(p) && Object.keys(p).length === 1 && isObject(p['$bytes'])
}

function comment(text: string, indent: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `${indent}// ${l}`.trimEnd() + '\n')
    .join('')
}

class Gen {
  readonly decls: string[] = []
  private readonly used = new Set<string>()

  /** Reserves a type name, made unique. */
  reserve(name: string): string {
    let n = name
    for (let i = 2; this.used.has(n); i++) n = `${name}${i}`
    this.used.add(n)
    return n
  }

  private scalar(t: unknown): string | null {
    switch (t) {
      case 'string':
        return 'string'
      case 'integer':
        return 'int64'
      case 'number':
        return 'float64'
      case 'boolean':
        return 'bool'
    }
    return null
  }

  private literal(values: unknown[]): string {
    if (values.every((x) => typeof x === 'string')) return 'string'
    if (values.every((x) => typeof x === 'boolean')) return 'bool'
    if (values.every((x) => Number.isInteger(x))) return 'int64'
    if (values.every((x) => typeof x === 'number')) return 'float64'
    return 'any'
  }

  /** The Go type of a schema; object schemas with properties become a struct named hint. */
  type(s: unknown, hint: string): string {
    if (!isObject(s)) return 'any'
    if (isBytes(s)) return 'azora.Bytes'
    if ('const' in s) return this.literal([s['const']])
    if (Array.isArray(s['enum'])) return this.literal(s['enum'])
    let types: unknown[] | null = Array.isArray(s['type']) ? s['type'] : null
    let nullable = false
    if (Array.isArray(s['anyOf'])) {
      const members = (s['anyOf'] as unknown[]).filter((m) => !(isObject(m) && m['type'] === 'null'))
      nullable = members.length < (s['anyOf'] as unknown[]).length
      if (members.length !== 1) return 'any'
      const t = this.type(members[0], hint)
      return nullable ? this.pointer(t) : t
    }
    if (types) {
      nullable = types.includes('null')
      types = types.filter((t) => t !== 'null')
      if (types.length !== 1) return 'any'
      const t = this.type({ ...s, type: types[0] }, hint)
      return nullable ? this.pointer(t) : t
    }
    const t = s['type']
    const sc = this.scalar(t)
    if (sc) return sc
    if (t === 'array') return '[]' + this.type(s['items'] ?? {}, hint + 'Item')
    if (t === 'object' || (t === undefined && isObject(s['properties']))) {
      if (isObject(s['properties']) && Object.keys(s['properties']).length > 0) return this.struct(s, hint)
      const ap = s['additionalProperties']
      return 'map[string]' + (isObject(ap) ? this.type(ap, hint + 'Value') : 'any')
    }
    return 'any'
  }

  private pointer(t: string): string {
    return t === 'any' || t.startsWith('[]') || t.startsWith('map[') || t.startsWith('*') || t === 'azora.Bytes' ? t : '*' + t
  }

  /** Declares a struct for an object schema and returns its name. */
  struct(s: Schema, hint: string): string {
    const name = this.reserve(hint)
    const props = s['properties'] as Record<string, unknown>
    const required = new Set(Array.isArray(s['required']) ? (s['required'] as string[]) : [])
    const fields = new Set<string>()
    let body = ''
    for (const [prop, ps] of Object.entries(props)) {
      let field = goName(prop)
      for (let i = 2; fields.has(field); i++) field = `${goName(prop)}${i}`
      fields.add(field)
      let t = this.type(ps, name + field)
      const optional = !required.has(prop)
      if (optional) t = this.pointer(t)
      const desc = isObject(ps) && typeof ps['description'] === 'string' ? ps['description'] : ''
      if (desc) body += comment(desc, '\t')
      body += `\t${field} ${t} \`json:${JSON.stringify(prop + (optional ? ',omitempty' : ''))}\`\n`
    }
    const desc = typeof s['description'] === 'string' ? s['description'] : ''
    this.decls.push(`${desc ? comment(`${name}: ${desc}`, '') : ''}type ${name} struct {\n${body}}\n`)
    return name
  }
}

/**
 * The Go source for the callable units (queries, mutations and actions
 * that are not internal): argument types and one wrapper per unit,
 *
 * ```go
 * res, err := units.Checkout[units.CheckoutResult](ctx, db, units.CheckoutArgs{CartID: "c1"})
 * ```
 *
 * The result type is the caller's: the manifest describes arguments only.
 */
export function generateGo(all: readonly GoUnit[], o: { package: string; source?: string }): string {
  const units = all
    .filter((u) => (u.kind === 'query' || u.kind === 'mutation' || u.kind === 'action') && !u.internal)
    .sort((a, b) => a.name.localeCompare(b.name))
  const g = new Gen()
  const funcs: string[] = []
  const fnNames = new Set<string>()
  for (const u of units) {
    let fn = goName(u.name)
    for (let i = 2; fnNames.has(fn); i++) fn = `${goName(u.name)}${i}`
    fnNames.add(fn)
    let argsType = 'any'
    if (u.args) {
      const hint = fn + 'Args'
      const t = g.type(u.args, hint)
      if (t === hint || t === `*${hint}`) argsType = hint
      else {
        const name = g.reserve(hint)
        g.decls.push(`${comment(`${name} is the argument of ${u.name}.`, '')}type ${name} = ${t}\n`)
        argsType = name
      }
    }
    let doc = `${fn} calls the ${u.kind} unit ${JSON.stringify(u.name)}; R is the type its result decodes into.`
    if (u.description) doc += `\n\n${u.description}`
    funcs.push(
      `${comment(doc, '')}func ${fn}[R any](ctx context.Context, db *azora.DB, args ${argsType}, opts ...azora.CallOption) (R, error) {\n` +
        `\treturn azora.Call[R](ctx, db, ${JSON.stringify(u.name)}, args, opts...)\n}\n`,
    )
  }
  let out = `// Code generated by azora-units types${o.source ? ` from ${o.source}` : ''}; DO NOT EDIT.\n\n`
  out += `// Package ${o.package} calls the units of an Azora database.\npackage ${o.package}\n`
  if (units.length === 0) return out
  out += `\nimport (\n\t"context"\n\n\t"github.com/azora-db/azora-go"\n)\n`
  for (const d of g.decls) out += '\n' + d
  for (const f of funcs) out += '\n' + f
  return out
}
