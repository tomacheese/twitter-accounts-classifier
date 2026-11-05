import { fromBigIntId, toBigIntId } from './id-codec'

/** Prisma の `Prisma.dmmf` のうち、この境界変換が参照する部分。 */
export interface DmmfSource {
  readonly dmmf: {
    readonly datamodel: {
      readonly models: readonly {
        readonly name: string
        readonly fields: readonly {
          readonly name: string
          readonly kind: string
          readonly type: string
        }[]
      }[]
    }
  }
}

interface ModelInfo {
  readonly bigintFields: ReadonlySet<string>
  readonly jsonFields: ReadonlySet<string>
  readonly relations: ReadonlyMap<string, string>
}

type Models = ReadonlyMap<string, ModelInfo>

export interface IdBoundaryExtension {
  name: string
  query: {
    $allModels: {
      $allOperations: (params: {
        model: string
        operation: string
        args: unknown
        query: (args: unknown) => Promise<unknown>
      }) => Promise<unknown>
    }
  }
}

function buildModels(source: DmmfSource): Models {
  const models = new Map<string, ModelInfo>()
  for (const model of source.dmmf.datamodel.models) {
    const bigintFields = new Set<string>()
    const jsonFields = new Set<string>()
    const relations = new Map<string, string>()
    for (const field of model.fields) {
      if (field.kind === 'object') relations.set(field.name, field.type)
      else if (field.type === 'BigInt') bigintFields.add(field.name)
      else if (field.type === 'Json') jsonFields.add(field.name)
    }
    models.set(model.name, { bigintFields, jsonFields, relations })
  }
  return models
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** BigInt 列に対する値 (スカラー、配列、フィルタ演算子のオブジェクト) の文字列をすべて bigint にする。 */
function convertIdLeaves(value: unknown): unknown {
  if (typeof value === 'string') return toBigIntId(value)
  if (Array.isArray(value)) return value.map((item) => convertIdLeaves(item))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, convertIdLeaves(item)]),
    )
  }
  return value
}

/**
 * where / data / create / update 内のオブジェクトを変換する。
 * フィールド名に一致するキーは型で扱いを決め、それ以外 (AND、some、connect など) は同じモデルのまま辿る。
 */
function convertContainer(models: Models, modelName: string, node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => convertContainer(models, modelName, item))
  if (!isPlainObject(node)) return node
  const info = models.get(modelName)
  if (info === undefined) throw new Error(`Unknown Prisma model "${modelName}"`)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    const related = info.relations.get(key)
    if (info.bigintFields.has(key)) {
      result[key] = convertIdLeaves(value)
    } else if (info.jsonFields.has(key)) {
      result[key] = value
    } else {
      result[key] = convertContainer(models, related ?? modelName, value)
    }
  }
  return result
}

/** findMany や upsert などの操作引数 (where、data、select など) を変換する。 */
function convertOperationArgs(models: Models, modelName: string, args: unknown): unknown {
  if (!isPlainObject(args)) return args
  const info = models.get(modelName)
  if (info === undefined) throw new Error(`Unknown Prisma model "${modelName}"`)
  const convertSelection = (selection: unknown): unknown => {
    if (!isPlainObject(selection)) return selection
    return Object.fromEntries(
      Object.entries(selection).map(([key, value]) => {
        const related = info.relations.get(key)
        if (related !== undefined) return [key, convertOperationArgs(models, related, value)]
        if (key === '_count' && isPlainObject(value)) {
          return [key, { ...value, select: convertSelection(value.select) }]
        }
        return [key, value]
      }),
    )
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    switch (key) {
      case 'where':
      case 'cursor':
      case 'data':
      case 'create':
      case 'update': {
        result[key] = convertContainer(models, modelName, value)
        break
      }
      case 'select':
      case 'include': {
        result[key] = convertSelection(value)
        break
      }
      default: {
        result[key] = value
      }
    }
  }
  return result
}

function convertResult(models: Models, modelName: string | undefined, value: unknown): unknown {
  if (typeof value === 'bigint') return fromBigIntId(value)
  if (Array.isArray(value)) return value.map((item) => convertResult(models, modelName, item))
  if (!isPlainObject(value)) return value
  const info = modelName === undefined ? undefined : models.get(modelName)
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] =
      info?.jsonFields.has(key) === true
        ? item
        : convertResult(models, info?.relations.get(key), item)
  }
  return result
}

/**
 * アプリ側の ID (10 進文字列) と DB の bigint を Prisma Client の境界で相互変換する query extension を作る。
 * 引数は schema.prisma の BigInt 列だけを変換し、Json 列と文字列列は触らない。
 * 戻り値は bigint をすべて文字列にする。生 SQL は対象外で、SQL 側で `::text` と `::bigint` を明示する。
 * @param source 生成済み Prisma Client の `Prisma` 名前空間
 * @returns `$extends` に渡す extension
 */
export function createIdBoundaryExtension(source: DmmfSource): IdBoundaryExtension {
  const models = buildModels(source)
  return {
    name: 'id-boundary',
    query: {
      $allModels: {
        async $allOperations({ model, args, query }) {
          const converted = convertOperationArgs(models, model, args)
          return convertResult(models, model, await query(converted))
        },
      },
    },
  }
}
