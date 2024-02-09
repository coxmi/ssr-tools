import fs from 'node:fs'
import { resolve, join } from 'node:path'
import * as vite from 'vite'

import type { Plugin, UserConfig, ResolvedConfig } from 'vite'

/**
 * Sub compiler to bundle client code, 
 * Takes initial settings from main SSR compilation config
 */
export async function clientCompiler(name: string, ssrResolvedConfig: ResolvedConfig, ssrUserConfig: UserConfig, clientCode: string) {

	const clientVirtualId = `/${name}`

	const ssrPlugins = ssrUserConfig?.plugins || []
	const clientPlugins = (ssrPlugins.flat() as Plugin[])
		.filter(plugin => plugin && plugin.name && !plugin?.name?.startsWith('ssr-tools:'))

	const { root } = ssrResolvedConfig
	const clientOutDir = join(ssrResolvedConfig.build.outDir, `../.${name}`)
	const absClientOutDir = resolve(root, clientOutDir)

	const manifest = await vite.build({
		...ssrUserConfig,
		configFile: false,
		envFile: false,
		build: {
			...(ssrUserConfig?.build || {}),
			manifest: false,
			ssrManifest: false,
			ssr: false,
			outDir: clientOutDir,
			rollupOptions: {
				...(ssrUserConfig?.build?.rollupOptions || {}),
				input: [clientVirtualId],
				output: {}
			}
		},
		plugins: [
			...clientPlugins,
			{
				name: 'ssr-tools:client-bundle',
				enforce: 'pre',
				resolveId(id) {
					if (id === clientVirtualId) return clientVirtualId
				},
				load(id) {
					if (id === clientVirtualId) {
						return clientCode
					}
				}
			},
		],
		logLevel: 'silent'
	})

	// delete dir and return manifest to allow main plugin to emit the files
	fs.rmSync(absClientOutDir, { recursive: true, force: true })
	return manifest
}
