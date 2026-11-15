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
  action, httpResponse, isUnitDefinition, isUnitName, mutation, onChange, query, schedule, type ChangeOp, type HttpResponse, type OnChangeDefinition, type RunMode,
  type ScheduleDefinition, type UnitAccess, type UnitBrand, type UnitDefinition,
} from './define.ts'
export { UnitError, type UnitErrorCode } from './error.ts'
export { argsSchema, isValidator, v, type ArgsSpec, type Described, type Infer, type InferArgs, type InferShape, type JsonSchema, type Shape, type Validator } from './v.ts'
export type {
  ActionCtx, Auth, BaseCtx, BatchStatement, Change, ChangeBatch, Crypto, Ctx, Db, DbReader, ExecResult, FetchHeaders, FetchInit, FetchResponse, FileOptions,
  FileUpload, HttpRequest, JobInfo, Log, MutationCtx, QueryCtx, Row, Scheduler, SqlArg, SqlValue, Storage, StorageReader, StoredFile, UnitInfo, UnitKind, UnitTrigger,
  UploadGrant,
} from './ctx.ts'
