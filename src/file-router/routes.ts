import { join } from 'node:path'
import globToRegexp from 'glob-to-regexp'
import { pathToRegexp, match } from 'path-to-regexp'
import type { ParamData } from 'path-to-regexp'

const routeComplexity = {
	STATIC: 1,
	DYNAMIC: 2,
	DYNAMIC_SPREAD: 3,
}

export type Route = {
	module: string
	routepath: string
	parts: string[]
	order: typeof routeComplexity[keyof typeof routeComplexity],
	match: ReturnType<typeof match>
	regexp?: RegExp,
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
	defaultError: ErrorRoute | undefined
}

export type BuildRoutesArgs = {
    files: string[]
    dir: string
    root: string
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
export function buildRoutes({ files, dir, root, remapFiles }: BuildRoutesArgs) {
    
    if (!root.startsWith('/') || !dir.startsWith('/'))
    	throw new Error(`'root' and 'dir' must be absolute paths`)

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

    	// absolute path localised to pages dir, without extension
    	// e.g. /home
        const filepath = file
            .replace(dirMatch, '')
            .replace(extensionMatch, '')

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

        routes.push(createRoute(absPath, pathParts))
    }

    for (const route of routes) {
    	route.error = findErrorRoute(errorRoutes, route.parts)
    }

    routes.sort((a, b) => Math.sign(a.order - b.order))

    const template: MatchedRoute = {
    	route: undefined,
    	params: {},
    	defaultError: findErrorRoute(errorRoutes, ['index'])
    }

    const routesByModuleId: Record<string, Route> = {}
    for (const route of routes) {
    	routesByModuleId[route.module] = route
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
	    findModuleRoute: function(file: string): Route | null {
	    	return routesByModuleId[file] || null
	    },
	    isStatic: function(route: Route) {
	    	return route.order === routeComplexity.STATIC
	    },
	    isDynamic: function(route: Route) {
	    	return (
	    		(route.order === routeComplexity.DYNAMIC) 
	    		|| (route.order === routeComplexity.DYNAMIC_SPREAD)
	    	)
	    },
    }
}


function createRoute(absPath: string, pathParts: string[]) {
	const route: Route = {
		module: absPath,
	    routepath: '',
	    parts: pathParts,
	    order: routeComplexity.STATIC,
	    error: undefined,
	    match: () => false
	}

	for (let i = 0; i < pathParts.length; i++) {
		const part = pathParts[i]
	    const isDynamicPart = isDynamicSegment(part)
	    
	    // match routes in order of complexity (static, dynamic, spread)
	    // also multiply by depth (i) so dynamic root parts are at the end
	    const maxDepth = 100
	    if (route.order < routeComplexity.DYNAMIC && isDynamicPart && !part.startsWith('[...')) {
	    	route.order = routeComplexity.DYNAMIC + (i/-maxDepth)
	    }
	    if (route.order < routeComplexity.DYNAMIC_SPREAD && part.startsWith('[...')) {
	    	route.order = routeComplexity.DYNAMIC_SPREAD + (i/-maxDepth)
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


function findErrorRoute(errorRoutes: ErrorRoute[], parts: string[]): ErrorRoute | undefined {
	const dirParts = parts.slice(0, -1)
	const dirPath = join(...dirParts)
	for (const error of errorRoutes) {
		if (dirPath === error.dir) return error
	}
	if (dirParts.length) findErrorRoute(errorRoutes, dirParts)
}


const isDynamicSegment = (s: string) => /\[.+\]/.test(s)