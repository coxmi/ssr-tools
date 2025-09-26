// use source maps in error stacks
import 'source-map-support/register.js'

// types
export type { PageProps } from './file-router/request.ts'
export type { ErrorPageProps } from './file-router/request.ts'

// main plugins
export { islands } from './vite/islands.ts'
export { fileRouter, fileRouterMiddleware } from './vite/fileRouter.ts'
export { client } from './vite/client.ts'