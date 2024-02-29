import fs from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import url from 'node:url'
import { resolve as resolveModule } from 'import-meta-resolve'

import type { build, Plugin, UserConfig, ResolvedConfig } from 'vite'

/**
 * Gets the user's instance of vite build:
 * `vite build` fails in some scenarios when multiple instances of vite are used in plugin and user context
 * (E.g. when npm linked in dev)
 */

let viteBuild: typeof build
async function getViteBuild(dir: string) {
	if (viteBuild) return viteBuild
	const from = url.pathToFileURL(join(dir, '_'))
	const userVitePath = resolveModule(
		'vite', 
		/* @ts-ignore - actually requires URL, not string */ 
		from
	)
	viteBuild = (await import(userVitePath)).build
	return viteBuild
}

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

	const build = await getViteBuild(envDir)
	const manifest = await build({
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
