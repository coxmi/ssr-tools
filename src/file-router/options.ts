import { match } from 'path-to-regexp'

export type ImportMode = 'sync' | 'async'
export type ImportModeResolveFn = (filepath: string) => ImportMode

export interface Route {
  name?: string
  path: string
  component: string
  children?: Route[]
  meta?: Record<string, unknown>
  match?: ReturnType<typeof match>
  regexp?: RegExp
}
