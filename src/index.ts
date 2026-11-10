/**
 * The TypeScript SDK of Azora DB: one encrypted connection per database
 * for SQL, exactly-once writes, live queries, file storage and units.
 *
 * @packageDocumentation
 */
export { connect, connectEnv, Database, type BatchStatement, type QueryOptions, type WriteOptions } from './database.ts'
export { parseUrl, decodeServerKey, encodeServerKey, type ConnectOptions, type CredentialProvider } from './config.ts'
export { fingerprint, keyId } from './channel.ts'
export type { Session } from './session.ts'
export { Subscription, rowObject } from './subscription.ts'
export { LiveQuery, compareValues, type LiveChange, type LiveEvent, type LiveOptions } from './live.ts'
export { Replica, rowHash, keyString } from './replica.ts'
export {
  and, eq, gt, gte, inList, isNull, lt, lte, ne, not, notInList, notNull, or, parseFilter, startsWith, FilterError, type Filter,
} from './filter.ts'
export { sql, SqlStatement } from './sql.ts'
export {
  Storage, uploadToSignedUrl, type ListOptions, type ResumableUploadOptions, type SignOptions, type StoredObject, type UploadBody,
  type UploadGrant, type UploadOptions,
} from './storage.ts'
export {
  AzoraError, ClosedError, ConnectionError, ErrorCode, HandshakeError, ResyncError, RetryVerifyError, TimeoutError, UnknownOutcomeError,
  isCode, UnitError, UnitErrorCode, type ErrorCodeValue, type UnitErrorCodeValue,
} from './errors.ts'
export {
  UnitsAdmin, type DeployInfo, type DeployInput, type DeployResult, type JsonSchema, type UnitArgs, type UnitBrand, type UnitCallOptions,
  type UnitFunction, type UnitInfo, type UnitKind, type UnitResult, type UnitRun, type Units, type UnitSecret, type UnitsOf, type UnitTrigger,
  type UntypedUnits,
} from './units.ts'
export { CodecError, type InputValue, type Value } from './codec.ts'
export { newMutationId, type CallOptions } from './util.ts'
export type {
  Change, ExecResult, Operation, QueryResult, Row, Statement, Stats, SubscribeSpec, SubscriptionKind, Update, VerifyResult,
} from './types.ts'
export type { WebSocketCtor } from './transport.ts'
