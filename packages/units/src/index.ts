/**
 * Units for Azora DB: TypeScript functions that run inside the database,
 * next to the data, and that clients call by name.
 *
 * ```ts
 * import { query, mutation, v, UnitError } from '@azora-db/units'
 *
 * export const checkout = mutation({
 *   args: { cartId: v.string() },
 *   handler(ctx, { cartId }) { ... },
 * })
 * ```
 *
 * Publish with `npx azora-units publish`. This module is bundled into the
 * engine: it has no dependencies and uses no runtime APIs.
 *
 * @packageDocumentation
 */
export {
  action, isUnitDefinition, isUnitName, mutation, onChange, query, schedule, type ChangeOp, type OnChangeDefinition, type RunMode,
  type ScheduleDefinition, type UnitBrand, type UnitDefinition,
} from './define.ts'
export { UnitError, type UnitErrorCode } from './error.ts'
export { argsSchema, isValidator, v, type ArgsSpec, type Described, type Infer, type InferArgs, type InferShape, type JsonSchema, type Shape, type Validator } from './v.ts'
export type {
  ActionCtx, Auth, BaseCtx, BatchStatement, Change, ChangeBatch, Crypto, Ctx, Db, DbReader, ExecResult, FetchInit, FetchResponse, Log, MutationCtx,
  QueryCtx, Row, SqlArg, SqlValue, UnitInfo, UnitKind,
} from './ctx.ts'
