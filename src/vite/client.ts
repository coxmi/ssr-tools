import { bundlePlugin, findBundleApi } from './bundlePlugin.ts'
import type { BundlePublicAPI } from './bundlePlugin.ts'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * Vite plugin to allow importing client code into the bundle directly from SSR realm
 */
export function client(): Plugin[] {

	let bundleApi: BundlePublicAPI
	const bundleName = 'client'
	const emptyModuleSource = 'export default {}'

	return [
		...bundlePlugin(),
		{
			name: 'ignored-ssr-tools:client',
			enforce: 'pre',
			
			configResolved(config: ResolvedConfig) {
				bundleApi = findBundleApi(config)
			},

			load(id, options) {
				if (!id.match(/\?client$/)) return
				if (options?.ssr) {
					bundleApi(bundleName).addImport(id, [])
					return emptyModuleSource
				}
			}
		}
	]
}