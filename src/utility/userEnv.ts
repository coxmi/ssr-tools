import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { resolve as resolveModule } from 'import-meta-resolve'

let cache: Record<string, string> = {}
let cacheResolved: Record<string, any> = {}

export async function clearUserModuleCache() {
	cache = {}
	cacheResolved = {}
}

export async function resolveUserModule(moduleName: string, dir: string = process.cwd()) {
	const cacheKey = `${moduleName}:${dir}`
	if (cache[cacheKey]) return cache[cacheKey]
	const from = pathToFileURL(join(dir, '_'))
	const userModulePath = resolveModule(
		moduleName,
		/* @ts-ignore - actually requires a URL() instance, not a string */ 
		from
	)
	return cache[cacheKey] = userModulePath
}

/**
 * Gets the user's instance of a module
 */
export async function importUserModule(moduleName: string, dir: string = process.cwd()) {
	const cacheKey = `${moduleName}:${dir}`
	if (cacheResolved[cacheKey]) return cacheResolved[cacheKey]
	const userModulePath = await resolveUserModule(moduleName, dir)
	const resolvedModule = await import(userModulePath)
	return cacheResolved[cacheKey] = resolvedModule
}


