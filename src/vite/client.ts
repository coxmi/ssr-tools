import { bundlePlugin, findBundleApi } from './bundlePlugin.ts'
import type { BundlePublicAPI } from './bundlePlugin.ts'
import type { PluginOption, ResolvedConfig } from 'vite'

/**
 * Vite plugin to allow importing client code into the bundle directly from SSR realm
 */
export function client(): PluginOption {

	let bundleApi: BundlePublicAPI
	const bundleName = 'client'
	const emptyModuleSource = 'export default {}'

	return [
		...bundlePlugin(),
		{
			name: 'ssr-tools:client',
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