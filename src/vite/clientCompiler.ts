import fs from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { importUserModule } from '../utility/userEnv.ts'

import type { build, Plugin, UserConfig, ResolvedConfig } from 'vite'

/**
 * Sub compiler to bundle client code, 
 * Takes initial settings from main SSR compilation config
 */
export async function clientCompiler(name: string, ssrResolvedConfig: ResolvedConfig, ssrUserConfig: UserConfig, clientCode: string) {

	const clientVirtualId = `/${name}`

	const ssrPlugins = ssrUserConfig?.plugins || []
	const clientPlugins = (ssrPlugins.flat() as Plugin[])
		.filter(plugin => plugin && plugin.name && !plugin?.name?.startsWith('ssr-tools:'))

	const { root, envDir } = ssrResolvedConfig

	const clientOutDir = join(ssrResolvedConfig.build.outDir, `../.${name}`)
	const absClientOutDir = resolvePath(root, clientOutDir)

	// `vite build` fails in some scenarios when multiple instances of vite are used in plugin and user context
	// (E.g. when npm linked in dev)
	const viteBuild = (await importUserModule('vite', envDir)).build as typeof build
	const manifest = await viteBuild({
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
