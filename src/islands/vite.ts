import fs from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import * as vite from 'vite'
import * as recast from 'recast'
import { processIslands } from './process.ts'
import { astFromCode } from './ast.ts'
import { md5 } from './../utility/crypto.ts'
import type { PluginOption, UserConfig, ResolvedConfig, ViteDevServer, Rollup } from 'vite'
import preactProvider from './providers/preact/index.ts'

type EntriesToIslands = Record<string, Array<string>>
type ClientIslandImports = Map<string, ReturnType<typeof createClientIslandImport>>

export type UserOptions = {
	provider?: Provider
}

export type Provider = {
	ssr: DescribeImport,
	bundle: (props:{ imports: string[], variables: string[] }) => string
}

type DescribeImport = {
	name: string,
	importFrom: string,
	importNamed: boolean,
}


/**
 * Vite plugin to allow SSR islands
 */
export function islands(userOptions: UserOptions = {}): PluginOption {

	let ssrUserConfig: UserConfig, 
		ssrResolvedConfig: ResolvedConfig,
		absRoot: string,
		isBuild: boolean,
		isSSR: boolean, 
		manifestFileName: boolean | string

	const provider = userOptions.provider || preactProvider

	const clientIslandImports: ClientIslandImports = new Map()

	// save server in plugin scope to access later in dev mode load step
	let server: ViteDevServer

	return [
		// islands:ssr plugin
		// process server files & wrap island exports with hydration function
		// saves clientIslandImports in global scope
		{
			name: 'islands:ssr',
			config(config) {
				ssrUserConfig = config
			},

			configResolved(resolvedConfig) {
				ssrResolvedConfig = resolvedConfig
				const mode = resolvedConfig.mode
				const command = resolvedConfig.command
				isBuild = resolvedConfig.command === 'build'
				isSSR = !!resolvedConfig?.build.ssr
				absRoot = resolvedConfig.root
				manifestFileName = resolvedConfig?.build.manifest
				// console.log({ isBuild, isSSR, mode, command, opts: resolvedConfig.build?.rollupOptions?.input })
			},

			async transform(code, id, options) {

				// only work on ssr transformations
				if (!options?.ssr) return

				// only match js/ts files
				const matchJs = /\.(ts|js)x?$/i
				if (!matchJs.test(id)) return

				// recast causes errors on const { ...props } = obj
				// need to rethink this to get sourcemaps working
				// 	const ast = recast.parse(code, {
				//    parser: { parse: astFromCode },
				//    sourceFileName: id,
				// 	}).program
				const ast = astFromCode(code)

				const exported = processIslands(ast, {
					name: provider.ssr.name,
					importFrom: provider.ssr.importFrom,
					importNamed: provider.ssr.importNamed,
					pathToSource: id,
					importId: md5(id)
				})
			
				if (!exported) return

				const clientImport = createClientIslandImport({ 
					absPathToFile: id,
					exported: exported
				})

				clientIslandImports.set(id, clientImport)

				// don't pass the AST back to rollup/vite, 
				// recast hooks cause a bug in rollup
				const { code: processed, map } = recast.print(ast, { 
					sourceMapName: 'unused-truthy-string-to-allow-sourcemaps' 
				})
				return { code: processed, map }
			},

			async resolveId(id, _from, options) {
				// required for import in ssr transform — repositories using `npm link` error with:
				// [vite]: Rollup failed to resolve import "ssr-tools/hydrate/preact" from "../linked-package/path/to/component.tsx".
				if (id.startsWith('ssr-tools/')) {
					return createRequire(import.meta.url).resolve(id)
				}
			},

			async buildEnd() {
				// build the client bundles (runs in non-dev modes only)
				// save output in main build manifest using `this.emitFile`
				const entriesToIslands = getBuildEntriesToIslands(this, clientIslandImports)
				const { global: globalCode, ...routeCode } = createClientCode(entriesToIslands, clientIslandImports, provider)

				const manifest = await bundleClient(ssrResolvedConfig, ssrUserConfig, globalCode)
				
				manifest?.output.map(file => {
					if (!file.name || file.type === 'asset') return
					const name = `${file.name}.js`
					this.emitFile({
						type: 'asset',
						name: name,
						source: file.code,
					})
					if (file.map) {
						const mapSource = JSON.stringify(file.map)
						this.emitFile({
							type:'asset',
							fileName: file.sourcemapFileName,
							source: mapSource
						})
					}
				})
			},
		},

		// islands:dev plugin
		// processes requests for /@islands-client in dev mode and generates client file
		{
			name: 'islands:dev',
			configureServer(_server) {
		      server = _server
		    },			
			transformIndexHtml() {
				// add script to the html output in dev mode
				return [{ 
					tag: 'script', 
					attrs: { src: '/@islands-dev', type: 'module' }, 
					injectTo: 'body' 
				}]
			},

			load(id, options) {
				if (options?.ssr) return
				if (!id.startsWith('/@islands-dev')) return
				const entriesToIslands = getDevEntriesToIslands(server, clientIslandImports)
				const codeOutput = createClientCode(entriesToIslands, clientIslandImports, provider)
				// TODO: for route-specific loading
				// const routeId = id.slice('/@islands-client:'.length)
				// return codeOutput[routeId] || codeOutput.global
				return codeOutput.global
			},
		}
	]
}


/**
 * Iterates through ModulesInfo references in build mode, and tests 
 * to see whether those modules are in the ClientIslandImports 
 * map generated in the transform step
 */
function getBuildEntriesToIslands(context: Rollup.PluginContext, clientIslandImports: ClientIslandImports): EntriesToIslands {

	const modules = [...context.getModuleIds()].map(id => context.getModuleInfo(id))	
	const entryModulesInfo = modules.filter(info => {
		return info !== null && !info.isExternal && info.isEntry
	}) as Rollup.ModuleInfo[]

	const entriesToIslands: EntriesToIslands = {}

	for (const moduleInfo of entryModulesInfo) {
		const islands = walkIslandsInModuleInfoMap(context, moduleInfo, clientIslandImports)
		if (islands.length) entriesToIslands[moduleInfo.id] = islands
	}
	return entriesToIslands
}

function walkIslandsInModuleInfoMap(
	context: Rollup.PluginContext,
	parentNode: Rollup.ModuleInfo, 
	clientIslandImports: ClientIslandImports,
	islandIds: string[] = [],
	visited: Record<string, true> = {}
) {
	for (const id of [...parentNode.dynamicallyImportedIds, ...parentNode.importedIds ]) {
		const node = context.getModuleInfo(id)
		if (!node || !node.id) continue
		if (visited[node.id]) continue
		if (clientIslandImports.has(node.id)) {
			islandIds.push(node.id)
		}
		visited[node.id] = true
		walkIslandsInModuleInfoMap(context, node, clientIslandImports, islandIds, visited)
	}
	return islandIds
}


/**
 * Iterates through ModuleGraph in dev mode, and tests 
 * to see whether those modules are in the ClientIslandImports
 * map generated in the transform step
 */
function getDevEntriesToIslands(server: ViteDevServer, clientIslandImports: ClientIslandImports) {

	const entryNodes = [...server.moduleGraph.idToModuleMap.values()].filter(node => {
		if (node.type !== 'js') return false
		if (node.importers.size) return false
		return true
	})

	const entriesToIslands: EntriesToIslands = {}
	for (const node of entryNodes) {
		if (!node.id) continue
		const islands = walkIslandsInModuleGraph(node, clientIslandImports)
		if (islands.length) entriesToIslands[node.id] = islands
	}
	return entriesToIslands
}

function walkIslandsInModuleGraph(
	parentNode: vite.ModuleNode, 
	clientIslandImports: ClientIslandImports,
	islandIds: string[] = [], 
	visited: Record<string, true> = {}
) {
	for (const node of parentNode.ssrImportedModules) {
		if (!node.id) continue
		if (visited[node.id]) continue
		if (clientIslandImports.has(node.id)) {
			islandIds.push(node.id)
		}
		visited[node.id] = true
		walkIslandsInModuleGraph(node, clientIslandImports, islandIds, visited)
	}
	return islandIds
}


/**
 * Uses a sub compiler to bundle client code 
 * generated from previous ssr processing
 */
async function bundleClient(ssrResolvedConfig: ResolvedConfig, ssrUserConfig: UserConfig, clientCode: string) {

	const clientVirtualId = '/islands-client'

	const ssrPlugins = ssrUserConfig?.plugins || []
	const clientPlugins = (ssrPlugins.flat() as vite.Plugin[]).filter(
		plugin => plugin && plugin.name && !plugin.name.startsWith('islands:')
	)

	const { root } = ssrResolvedConfig
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
			outDir: clientOutDir,
			rollupOptions: {
				...(ssrUserConfig?.build?.rollupOptions || {}),
				input: [clientVirtualId],
			}
		},
		plugins: [
			...clientPlugins,
			{
				name: 'islands:client-bundle',
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

function createClientCode(entriesToIslands: EntriesToIslands, clientIslandImports: ClientIslandImports, provider: Provider) {

	const codeOutput: Record<string, string> = {}
	const globalImports: Array<string> = []
	const globalVariables: Array<string> = []

	for (const entry in entriesToIslands) {
		const imports: Array<string> = []
		const variables: Array<string> = []
		entriesToIslands[entry].forEach(island => {
			const islandImport = clientIslandImports.get(island)
			if (!islandImport) return
			imports.push(...islandImport.code)
			globalImports.push(...islandImport.code)
			variables.push(...islandImport.exportMap.values())
			globalVariables.push(...islandImport.exportMap.values())
		})
		codeOutput[entry] = provider.bundle({ imports, variables })
	}	
	codeOutput.global = provider.bundle({ imports: globalImports, variables: globalVariables })
	return codeOutput
}


type CreateImportsOptions = {
	absPathToFile: string, 
	exported: Array<string>
}

function createClientIslandImport({ absPathToFile, exported = [] }: CreateImportsOptions) {
	// we don't want the full absolute path appearing in the source, so we
	// generate a client friendly id, which is used later in the 
	// hydration script and client output
	const suffix = '_' + md5(absPathToFile)
	const variables: Array<string> = []
	const exportMap: Map<string, string> = new Map()

	const code = exported.map(name => {
		const as = name + suffix
		exportMap.set(name, as)
		variables.push(as)
		return `import { ${name} as ${as} } from "${absPathToFile}"`
	})
	return { 
		code, 
		variables,
		names: exported,
		exportMap
	}
}