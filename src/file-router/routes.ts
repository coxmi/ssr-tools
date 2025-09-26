import { join } from 'node:path'
import globToRegexp from 'glob-to-regexp'
import { pathToRegexp, match } from 'path-to-regexp'
import type { ParamData } from 'path-to-regexp'

const ROUTE_COMPLEXITY = {
	STATIC: 1,
	DYNAMIC: 2,
	DYNAMIC_SPREAD: 3,
}

export type Route = {
	name: string
	module: string
	routepath: string
	parts: string[]
	type: 'static' | 'dynamic' | 'dynamic-spread'
	order: typeof ROUTE_COMPLEXITY[keyof typeof ROUTE_COMPLEXITY]
	match: ReturnType<typeof match>
	regexp?: RegExp
	error: ErrorRoute | undefined
}

export type ErrorRoute = {
	module: string	
	parts: string[]
	dir: string
}

export type MatchedRoute = {
	route: Route | undefined
	params: ParamData
}

export type BuildRoutesArgs = {
    files: string[]
    dir: string
    remapFiles?: (path: string) => string | false
}


// match only the final extension (to support route.foo.tsx -> route.foo)
const extensionMatch = /\.[^\.]+$/

// matches '[...slug]' url part
const catchAllSectionMatch = /^\[\.{3}.+\]/

/**
 * build a list of routes to match against URLs.
 * To test the built routes against live URLs use `matchRoute(path, routes)`
 */
export function buildRoutes({ files, dir, remapFiles }: BuildRoutesArgs) {
    
    if (!dir.startsWith('/'))
    	throw new Error(`'dir' must be an absolute path`)

    const routes: Route[] = []
    const errorRoutes: ErrorRoute[] = []

    // removes $ from end of page directory regex, e.g:
    // from: /^\/abs\/path\/to\/pages$/ 
	// to:   /^\/abs\/path\/to\/pages/
	const dirMatchExact: RegExp = globToRegexp(dir, { extended: true, globstar: true })
    const dirMatch: RegExp = new RegExp(dirMatchExact.toString().slice(1, -2))

    for (const file of files) {
    	const absPath = remapFiles ? remapFiles(file) : file 
    	if (!absPath) continue

    	if (remapFiles && !absPath.startsWith('/')) {
			throw new Error(`'remapFiles' must return an absolute path. Returned "${absPath}" for "${file}"`)
		}

    	// absolute path localised to router dir (e.g. /:slug/index.ts)
    	// and without extension (e.g. /:slug/index)
    	const filepathExt = file.replace(dirMatch, '')
        const filepath = filepathExt.replace(extensionMatch, '')

        const pathParts = filepath.split('/').slice(1)

        const isErrorRoute = (pathParts[pathParts.length - 1] === '_error')
        if (isErrorRoute) {
        	errorRoutes.push({
        		module: absPath,
        		parts: pathParts,
        		dir: join(...pathParts.slice(0, -1))
        	})
        }

        // ignore files and folders starting with an underscore
        // to allow non-route files to exist in the folder structure
        // (e.g. layouts and shared js resources)
        const ignore = pathParts.find(part => part.startsWith('_'))
        if (ignore) continue

        routes.push(createRoute(filepathExt, absPath, pathParts))
    }
    
    // add error property to routes, using default error handler
    const defaultError = findErrorRoute(errorRoutes, ['index'])
    for (const route of routes) {
    	route.error = findErrorRoute(errorRoutes, route.parts) || defaultError
    }

    routes.sort((a, b) => Math.sign(a.order - b.order))

    const template: MatchedRoute = {
    	route: undefined,
    	params: {}
    }

    const routesByFile: Record<string, Route> = {}
    for (const route of routes) {
    	routesByFile[route.module] = route
    }

    return {
    	routes,
    	errorRoutes,
    	matchRoute: function (path: string, route?: Route): MatchedRoute {
	    	const withoutQuery = path.replace(/\?.*$/, '')
	    	if (route) {
	    		const matches = route.match(withoutQuery)
	    		if (matches) return {
	    			...structuredClone(template), 
	    			route, 
	    			params: matches.params,
	    		}
	    	}
	    	for (const route of routes) {
	    		const matches = route.match(withoutQuery)
	    		if (matches) return {
	    			...structuredClone(template), 
	    			route, 
	    			params: matches.params,
	    		}
	    	}
	    	return structuredClone(template)
	    },
	    findRouteByFile: function(file: string): Route | null {
	    	return routesByFile[file] || null
	    },
    }
}


function createRoute(name: string, absPath: string, pathParts: string[]) {
	
	const route: Route = {
		name: name,
		module: absPath,
	    routepath: '',
	    parts: pathParts,
	    type: 'static',
	    order: ROUTE_COMPLEXITY.STATIC,
	    match: () => false,
	    error: undefined
	}

	for (let i = 0; i < pathParts.length; i++) {
		const part = pathParts[i]
	    const isDynamicPart = isDynamicSegment(part)
	    
	    // match routes in order of complexity (static, dynamic, spread)
	    // also multiply by depth (i) so dynamic root parts are at the end
	    const maxDirectoryDepth = 100
	    if (route.order < ROUTE_COMPLEXITY.DYNAMIC && isDynamicPart && !part.startsWith('[...')) {
	    	route.order = ROUTE_COMPLEXITY.DYNAMIC + (i/-maxDirectoryDepth)
	    	route.type = 'dynamic'
	    }
	    if (route.order < ROUTE_COMPLEXITY.DYNAMIC_SPREAD && part.startsWith('[...')) {
	    	route.order = ROUTE_COMPLEXITY.DYNAMIC_SPREAD + (i/-maxDirectoryDepth)
	    	route.type = 'dynamic-spread'
	    }

		// Remove square brackets at the start and end
	    const normalizedPart = (isDynamicPart
	        ? part.replace(/^\[(\.{3})?/, '').replace(/\]$/, '')
	        : part
	    ).toLowerCase()

	    if (!isDynamicPart && normalizedPart === 'index') {
	    	const first = i === 0
	    	const last = (i === pathParts.length - 1)
	    	// root index
	    	if (first) route.routepath += '/'
	    	// skip index parts at the end
	    	if (last) continue
	    }
	    
	    if (isDynamicPart) {
	    	if (catchAllSectionMatch.test(part)) {
	    		route.routepath += `/*${normalizedPart}`
	    	} else {
	    		route.routepath += `/:${normalizedPart}`
	    	}
	    } else {
	        route.routepath += `/${normalizedPart}`
	    }
	}

	route.match = match(route.routepath, { 
		decode: decodeURIComponent 
	})

	route.regexp = pathToRegexp(route.routepath).regexp
	return route
}

const isDynamicSegment = (s: string) => /\[.+\]/.test(s)

function findErrorRoute(errorRoutes: ErrorRoute[], parts: string[]): ErrorRoute | undefined {
	const dirParts = parts.slice(0, -1)
	const dirPath = join(...dirParts)
	for (const error of errorRoutes) {
		if (dirPath === error.dir) return error
	}
	if (dirParts.length) findErrorRoute(errorRoutes, dirParts)
}

export function isStatic(route: Route) {
	return route.order === ROUTE_COMPLEXITY.STATIC
}

export function isDynamic(route: Route) {
	return (
		(route.order === ROUTE_COMPLEXITY.DYNAMIC) 
		|| (route.order === ROUTE_COMPLEXITY.DYNAMIC_SPREAD)
	)
}