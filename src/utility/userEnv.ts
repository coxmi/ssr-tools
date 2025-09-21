import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { resolve as resolveModule } from 'import-meta-resolve'

let cache: Record<string, any> = {}

export async function resolveUserModule(moduleName: string, dir: string = process.cwd()) {
	if (cache[moduleName]) return cache[moduleName]
	const from = pathToFileURL(join(dir, '_'))
	const userModulePath = resolveModule(
		moduleName,
		/* @ts-ignore - actually requires a URL() instance, not a string */ 
		from
	)
	return userModulePath
}

/**
 * Gets the user's instance of a module
 */

export async function importUserModule(moduleName: string, dir: string | false = process.cwd()) {
	const userModulePath = await resolveUserModule(moduleName, dir || undefined)
	return await import(userModulePath)
}


