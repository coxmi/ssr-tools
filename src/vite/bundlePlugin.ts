import { createRequire } from 'node:module'
import { sha } from './../utility/crypto.ts'
import { isKebabCase } from '../utility/string.ts'
import { clientCompiler } from './clientCompiler.ts'

import type { Plugin, UserConfig, ResolvedConfig, ViteDevServer, Rollup, ModuleNode } from 'vite'


type ClientImport = {
	code: string[],
	variables: string[],
	names: string[],
	exportMap: Map<string, string>
}

type ClientImports = Map<string, ClientImport>

type EntriesToClientImports = Record<string, Array<string>>

export type BundlePublicAPI = ((bundleName: string) => ClientBundle)


/**
 * Public interface for sibling plugins to access via bundlePlugin.api('name')
 */

export type BundleStringifier = (props: { 
	imports: string[], 
	variables: string[],
	code: string[]
}) => string

class ClientBundle {

	name: string
	devName: string
	imports: ClientImports = new Map()
	code: string[] = []

	stringify: BundleStringifier = ({ imports, variables, code }) => {
		return imports.concat(code).join("\n") 
	}

	constructor(name: string) {
		if (!isKebabCase(name)) throw new Error(`bundle name ("${name}") must be a kebab-case string`)
		this.name = name
		this.devName = `/@${name}-dev`
	}

	addImport(absPathToFile: string, exported: string[] = []) {
		this.imports.set(absPathToFile, createClientImport(absPathToFile, exported))
		return this
	}

	addCode(code: string) {
		this.code.push(code)
		return this
	}

	onRender(stringifier: BundleStringifier) {
		this.stringify = stringifier
		return this
	}
}

/**
 * create a ClientImport
 * Used to include in the final client bundle
 */
function createClientImport(absPathToFile: string, exported: string[] = []): ClientImport {
	// we don't want the full absolute path appearing in the source, so we
	// generate a client friendly id, which is used later in the 
	// hydration script and client output
	const suffix = '_' + sha(absPathToFile)
	const variables: Array<string> = []
	const exportMap: Map<string, string> = new Map()

	const code = exported.map(name => {
		const as = name + suffix
		exportMap.set(name, as)
		variables.push(as)
		return `import { ${name} as ${as} } from "${absPathToFile}"`
	})

	if (!exported.length) {
		code.push(`import "${absPathToFile}"`)
	}

	return { 
		code, 
		variables,
		names: exported,
		exportMap
	}
}


/**
 * Entries to imports (build mode: buildEnd hook)
 * Traverse ModuleInfo tree in build mode and return a map illustrating which
 * entries use which client imports somewhere in the tree
 */
function getBuildEntriesToImports(context: Rollup.PluginContext, clientImports: ClientImports): EntriesToClientImports {

	const modules = [...context.getModuleIds()].map(id => context.getModuleInfo(id))	
	const entryModulesInfo = modules.filter(info => {
		return info !== null && !info.isExternal && info.isEntry
	}) as Rollup.ModuleInfo[]

	const entriesToImports: EntriesToClientImports = {}

	for (const moduleInfo of entryModulesInfo) {
		const imports = walkImportsInModuleInfoMap(context, moduleInfo, clientImports)
		if (imports.length) entriesToImports[moduleInfo.id] = imports
	}
	return entriesToImports
}

function walkImportsInModuleInfoMap(
	context: Rollup.PluginContext,
	parentNode: Rollup.ModuleInfo, 
	clientImports: ClientImports,
	importIds: string[] = [],
	visited: Record<string, true> = {}
) {
	for (const id of [...parentNode.dynamicallyImportedIds, ...parentNode.importedIds ]) {
		const node = context.getModuleInfo(id)
		if (!node || !node.id) continue
		if (visited[node.id]) continue
		if (clientImports.has(node.id)) {
			importIds.push(node.id)
		}
		visited[node.id] = true
		walkImportsInModuleInfoMap(context, node, clientImports, importIds, visited)
	}
	return importIds
}


/**
 * Entries to imports (dev mode: load hook) 
 * Traverse the ModuleGraph in dev mode and return a map illustrating which
 * entries use which client imports somewhere in the tree
 */
function getDevEntriesToImports(server: ViteDevServer, clientImports: ClientImports): EntriesToClientImports {

	const entryNodes = [...server.moduleGraph.idToModuleMap.values()].filter(node => {
		if (node.type !== 'js') return false
		if (node.importers.size) return false
		return true
	})

	const entriesToImports: EntriesToClientImports = {}
	for (const node of entryNodes) {
		if (!node.id) continue
		const imports = walkImportsInModuleGraph(node, clientImports)
		if (imports.length) entriesToImports[node.id] = imports
	}
	return entriesToImports
}

function walkImportsInModuleGraph(
	parentNode: ModuleNode, 
	clientImports: ClientImports,
	importIds: string[] = [], 
	visited: Record<string, true> = {}
) {
	for (const node of parentNode.ssrImportedModules) {
		if (!node.id) continue
		if (visited[node.id]) continue
		if (clientImports.has(node.id)) {
			importIds.push(node.id)
		}
		visited[node.id] = true
		walkImportsInModuleGraph(node, clientImports, importIds, visited)
	}
	return importIds
}


/**
 * 
 * create the final source code before bundling
 */
function createClientCode(entriesToImports: EntriesToClientImports, bundle: ClientBundle) {

	const output: Record<string, string> = {}
	const globalImports: Array<string> = []
	const globalVariables: Array<string> = []

	// for each entry, gather imports and imported variables
	// also save to global bundle and deduplicate
	for (const entry in entriesToImports) {
		const imports: Array<string> = []
		const variables: Array<string> = []

		entriesToImports[entry].forEach(imported => {
			const clientImport = bundle.imports.get(imported)
			if (!clientImport) return

			imports.push(...clientImport.code)
			variables.push(...clientImport.exportMap.values())
			globalImports.push(...clientImport.code)
			globalVariables.push(...clientImport.exportMap.values())
		})
		output[entry] = bundle.stringify({ 
			imports, 
			variables, 
			code: bundle.code 
		})
	}

	output.global = bundle.stringify({ 
		imports: [...new Set(globalImports)], 
		variables: [...new Set(globalVariables)],
		code: bundle.code
	})
	return output
}


export function bundlePlugin(): Plugin[] {

	const bundles: Record<string, ClientBundle> = {}

	let ssrUserConfig: UserConfig
	let ssrResolvedConfig: ResolvedConfig
	let server: ViteDevServer

	const api = (bundleName: string): ClientBundle => {
		if (bundles[bundleName]) return bundles[bundleName]
		return bundles[bundleName] = new ClientBundle(bundleName)
	}

	// allow this plugin to be a dependency of multiple plugins
	// only run hooks when it's been initiated by a call to findBundleApi()
	let initiated = false
	api.initiate = () => initiated = true
	api.state = () => initiated

	return [
		{
			name: 'ssr-tools:bundle',
			enforce: 'pre',
			api,

			config(config) {
				ssrUserConfig = config
			},

			configResolved: function(resolvedConfig) {
				ssrResolvedConfig = resolvedConfig
			},

			async resolveId(id, _from, _options) {
				if (!initiated) return
				// resolve ssr-tools relative to the main project, otherwise repositories using `npm link` error with:
				// [vite]: Rollup failed to resolve import "ssr-tools/…" from "../linked-package/path/to/component.tsx".
				if (id === 'ssr-tools' || id.startsWith('ssr-tools/')) {
					return createRequire(import.meta.url).resolve(id)
				}
			},

			async buildEnd() {
				if (!initiated) return

				// build the client bundles (runs in non-dev modes only)
				// save output in main build manifest using `this.emitFile`
				const pluginContext = this
				const bundleInstances = Object.values(bundles)
				
				await Promise.all(bundleInstances.map(async bundle => {
					const entriesToImports = getBuildEntriesToImports(pluginContext, bundle.imports)
					
					const { 
						global: globalCode, 
						// TODO: supports route-specific bundles 
						// rather than only global code
						...routeCode 
					} = createClientCode(entriesToImports, bundle)

					const manifest = await clientCompiler(bundle.name, ssrResolvedConfig, ssrUserConfig, globalCode)
					if (!('output' in manifest)) return

					manifest.output.map(file => {
						if (!file.name || file.type === 'asset') return
						const name = `${file.name}.js`
						pluginContext.emitFile({
							type: 'asset',
							name: name,
							source: file.code,
						})
						if (file.map) {
							const mapSource = JSON.stringify(file.map)
							pluginContext.emitFile({
								type:'asset',
								fileName: file.sourcemapFileName || undefined,
								source: mapSource
							})
						}
					})
				}))
			}
		},
		{
			name: 'ssr-tools:bundle-dev',
			api,
			configureServer(_server) {
				if (!initiated) return
		    	server = _server
		    },

			transformIndexHtml(html, ctx) {
				if (!initiated) return
				// add script to the html output in dev mode
				return Object.values(bundles).map(bundle => ({
					tag: 'script', 
					attrs: { 
						type: 'module',
						// add cache busting per-route:
						// the script would otherwise be cached on the initial
						// route in dev mode
						src: `${bundle.devName}?v=${sha(ctx.path)}`
					}, 
					injectTo: 'body' 
				}))
			},

			load(id, options) {
				if (!initiated) return
				if (options?.ssr) return
				for (const name in bundles) {
					const bundle = bundles[name]
					if (!id.startsWith(bundle.devName)) continue
					const entriesToImports = getDevEntriesToImports(server, bundle.imports)
					const codeOutput = createClientCode(entriesToImports, bundle)
					// TODO: create route-specific loading with pattern: `devName:path/to/entry/source.ts`
					return codeOutput.global
				}				
			}
		}
	]
}


export function findBundleApi(config: ResolvedConfig): BundlePublicAPI | never {
	const first = config.plugins.find(plugin => plugin?.name === 'ssr-tools:bundle')
	if (!first) throw new Error("No bundle API found")
	first.api.initiate()
	return first.api
}