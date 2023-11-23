import type { PluginOption, UserConfig, ResolvedConfig } from 'vite'
import { basename, relative, resolve, join } from 'node:path'
import fs from 'node:fs'
import * as vite from 'vite'
import * as recast from 'recast'
import { processIslands } from './process.ts'
import { createImport } from './../utility/createImport.ts'


export function islands(): PluginOption {
	
	let ssrUserConfig: UserConfig, 
		ssrResolvedConfig: ResolvedConfig,
		absRoot: string,
		isBuild: boolean,
		isSSR: boolean, 
		manifestFileName: boolean | string

	// map from island src relativeId to import code
	// to use in the build bundle or dev client load hook
	const islandImports = new Map<string, string>()

	const test = {
		test: false
	}
	
	return [
		{
			name: 'islands',
			config(config) {
				ssrUserConfig = config
				return {
					build: {
						emptyOutDir: false
					}
				}
			},
			configResolved(resolvedConfig) {
				ssrResolvedConfig = resolvedConfig
				isBuild = resolvedConfig.command === 'build'
				absRoot = resolvedConfig.root
				isSSR = !!resolvedConfig?.build.ssr
				manifestFileName = resolvedConfig?.build.manifest
			},
			async transform(code, id, options) {

				// only work on ssr transofmrations
				// we parse the source files for islands then add bundled
				// island files as virtuals for the client later on
				if (!options.ssr) return

				// only match js/ts files
				const matchJs = /\.(ts|js)x?$/i
				if (!matchJs.test(id)) return

				// use recast to create the AST (any changes maintain a sourcemap)
				// to pass back to rollup
				const ast = recast.parse(code, {
				  parser: { parse: this.parse },
				  sourceFileName: id,
				})

				// in dev mode, the relative path to the source file
				// is put into the SSR html source
				const relativeId = '/' + relative(absRoot, id)

				const exported = processIslands(ast.program, {
					name: 'ssr',
					importFrom: 'ssr-tools/hydrate/preact',
					importNamed: true,
					pathToSource: null,
				})
				if (!exported) return

				// remove all extensions from basename and convert to pascal case
				const defaultName = toPascalCase(
					basename(id).replace(/\..+$/, '')
				)

				const virtualImportCode = createImport({ 
					absPathToFile: id, 
					imports: exported || [], 
					defaultName: defaultName 
				})

				islandImports.set(relativeId, virtualImportCode)

				// console.log(`————${relativeId}————`)
				// console.log(
				// 	exported 
				// 		? `Island exports: ${exported.join(', ')}`
				// 		: 'No island exports'
				// )
				// console.log(virtualImportCode)
				// console.log("\n")

				// console.log(this.getModuleInfo(id))
				// clientBuild()

				const { code: processed, map } = recast.print(ast, { 
					sourceMapName: 'unused-truthy-string-to-allow-sourcemaps' 
				})

				// don't pass the AST back to rollup/vite, 
				// recast hooks cause a bug in rollup
				return { code: processed, map }
			},

			// at the end of the build, create the client bundle and add it to the manifest
			// with this.emitFile
			async buildEnd(error) {
				const manifest = await clientBuild(ssrResolvedConfig, ssrUserConfig)
				test.test = true
				manifest.output.map(file => {
					if (!file.name) return
					this.emitFile({
						type: 'asset',
						name: `${file.name}.js`,
						source: file.code,
					})
					if (file.map) {
						this.emitFile({
							type:'asset',
							fileName: file.sourcemapFileName,
							source: JSON.stringify(file.map)
						})
					}
				})
			}
		},

		// only for development mode
		{
			name: 'islands:client',
			resolveId(id, options) {
				if (id === '/islands.js') {
					return id
				}
			},
			load(id, options) {
				if (!options.ssr && id === '/islands.js') {
					return `
						import { client } from 'ssr-tools/hydrate/preact'
						client()
					`
				}
			}
		}
	]
}


async function clientBuild(ssrResolvedConfig: ResolvedConfig, ssrUserConfig: UserConfig) {

	const clientDevPath = 'islands:client'

	const ssrPlugins = ssrUserConfig?.plugins || []
	const clientPlugins = ssrPlugins.flat().filter(
		plugin => !plugin.name.startsWith('islands')
	)	

	const { root } = ssrResolvedConfig
	const absOutDir = resolve(root, ssrResolvedConfig.build.outDir)
	const clientOutDir = join(ssrResolvedConfig.build.outDir, '../.islands')
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
			emptyOutDir: false,
			outDir: clientOutDir,
			rollupOptions: {
				...(ssrUserConfig?.build?.rollupOptions || {}),
				input: [
					clientDevPath
				],
			}
		},
		plugins: [
			...clientPlugins,
			{
				name: 'islands:client',
				enforce: 'pre',
				resolveId(id) {
					if (id === clientDevPath) return 'islands'
				},
				load(id) {
					if (id === 'islands') {
						return `
							import { client } from 'ssr-tools/hydrate/preact'
							client()
						`
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


function toPascalCase(text) {
	return text.replace(/(^\w|-\w)/g, text => text.replace(/-/, "").toUpperCase())
}