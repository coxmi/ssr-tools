import fs from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { sha } from './../utility/crypto.ts'
import { isKebabCase } from '../utility/string.ts'
import * as vite from 'vite'

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


// allow this plugin to be a dependency of multiple plugins
let shouldInitialisePlugin: boolean = true


export function bundlePlugin(): Plugin[] {

	const bundles: Record<string, ClientBundle> = {}

	let ssrUserConfig: UserConfig
	let ssrResolvedConfig: ResolvedConfig
	let server: ViteDevServer

	// only initialize once per server start
	if (!shouldInitialisePlugin) return []
	shouldInitialisePlugin = false

	return [
		{
			name: 'ssr-tools:bundle',
			enforce: 'pre',

			config(config) {
				ssrUserConfig = config
			},

			configResolved(resolvedConfig) {
				ssrResolvedConfig = resolvedConfig
			},

			configureServer() {
	    		// after it's started up, allow the server to restart 
	    		// with a new plugin instance
	    		shouldInitialisePlugin = true
		    },

			api(bundleName: string): ClientBundle {
				if (bundles[bundleName]) return bundles[bundleName]
				return bundles[bundleName] = new ClientBundle(bundleName)
			},

			async resolveId(id, _from, _options) {
				// resolve ssr-tools relative to the main project, otherwise repositories using `npm link` error with:
				// [vite]: Rollup failed to resolve import "ssr-tools/…" from "../linked-package/path/to/component.tsx".
				if (id.startsWith('ssr-tools/')) {
					return createRequire(import.meta.url).resolve(id)
				}
			},

			async buildEnd() {
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

					const manifest = await bundleClient(bundle, ssrResolvedConfig, ssrUserConfig, globalCode)
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
			configureServer(_server) {
		    	server = _server
		    },

			transformIndexHtml() {
				// add script to the html output in dev mode
				return Object.values(bundles).map(bundle => ({
					tag: 'script', 
					attrs: { 
						src: bundle.devName, 
						type: 'module' 
					}, 
					injectTo: 'body' 
				}))
			},

			load(id, options) {
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
	const api = config.plugins.find(plugin => plugin?.name === 'ssr-tools:bundle')?.api
	if (!api) throw new Error("No bundle API found")
	return api
}


/**
 * Used in build mode only.
 * Uses a sub compiler to bundle client code, with initial config in main SSR compilation
 */
async function bundleClient(bundle: ClientBundle, ssrResolvedConfig: ResolvedConfig, ssrUserConfig: UserConfig, clientCode: string) {

	const clientVirtualId = `/${bundle.name}`

	const ssrPlugins = ssrUserConfig?.plugins || []
	const clientPlugins = (ssrPlugins.flat() as Plugin[])
		.filter(plugin => plugin && plugin.name && !plugin?.name?.startsWith('ssr-tools:'))

	const { root } = ssrResolvedConfig
	const clientOutDir = join(ssrResolvedConfig.build.outDir, `../.${bundle.name}`)
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
