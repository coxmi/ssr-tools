
export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}


export function isRecord(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === 'object'
}


export function isRecordWithKeys(obj: object, keys: string[]): obj is Record<PropertyKey, string | string[]> {
  if (!isRecord(obj)) return false
  const record = obj as Record<PropertyKey, unknown>
  return keys.every(key =>
    key in record && (
      typeof record[key] === "string" || (
        Array.isArray(record[key]) && record[key].every(v => typeof v === "string")
      )
    )
  )
}


export function isIterable(x: unknown): x is Iterable<unknown> {
  return Symbol.iterator in Object(x)
}


export function isObject(obj: unknown): obj is object {
  return obj === Object(obj)
}