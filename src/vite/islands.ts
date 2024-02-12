import * as recast from 'recast'
import { processIslands } from './../islands/index.ts'
import preactProvider from './../islands/providers/preact/index.ts'
import { astFromCode } from './../islands/ast.ts'
import { sha } from './../utility/crypto.ts'
import { bundlePlugin, findBundleApi } from './bundlePlugin.ts'

import type { BundlePublicAPI, BundleStringifier } from './bundlePlugin.ts'
import type { Plugin, ResolvedConfig } from 'vite'


export type UserOptions = {
	provider?: Provider
}

export type Provider = {
	ssr: DescribeImport,
	bundle: BundleStringifier
}

type DescribeImport = {
	name: string,
	importFrom: string,
	importNamed: boolean,
}


/**
 * Vite plugin to allow SSR islands
 */
export function islands(userOptions: UserOptions = {}): Plugin[] {

	let bundleApi: BundlePublicAPI
	const bundleName = 'client'
	const provider = userOptions.provider || preactProvider

	return [
		...bundlePlugin(),
		{
			name: 'ssr-tools:islands',

			configResolved(config: ResolvedConfig) {
				bundleApi = findBundleApi(config)
				bundleApi(bundleName).onRender(provider.bundle)
			},

			transform(code, id, options) {
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
					importId: sha(id)
				})
				
				if (!exported) return

				bundleApi(bundleName).addImport(id, exported)

				// don't pass the AST back to rollup/vite, 
				// recast hooks cause a bug in rollup
				const { code: processed, map } = recast.print(ast, { 
					sourceMapName: 'unused-truthy-string-to-allow-sourcemaps' 
				})
				return { code: processed, map }
			}
		}
	]
}