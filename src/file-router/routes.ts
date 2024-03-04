import { join, dirname } from 'node:path'
import globToRegexp from 'glob-to-regexp'
import { pathToRegexp, match } from 'path-to-regexp'

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
	match?: ReturnType<typeof match>
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
	params: Record<string, string | string[]>
	defaultError: ErrorRoute | undefined
} & {}

export type BuildRoutesArgs = {
    files: string[]
    dir: string
    root: string
}


// match only the final extension (to support route.foo.tsx -> route.foo)
const extensionMatch = /\.[^\.]+$/

// matches '[...slug]' url part
const catchAllSectionMatch = /^\[\.{3}.+\]/

/**
 * build a list of routes to match against URLS.
 * To test the built routes against live URLs use `matchRoute(path, routes)`
 */
export function buildRoutes({ files, dir, root }: BuildRoutesArgs) {
    
    if (!root.startsWith('/') || !dir.startsWith('/'))
    	throw new Error(`'root' and 'dir' must be absolute paths`)

    const routes: Route[] = []
    const errorRoutes: ErrorRoute[] = []

    // removes $ from end of page directory regex, e.g:
    // from: /^\/abs\/path\/to\/pages$/ 
	// to:   /^\/abs\/path\/to\/pages/
	const dirMatchExact: RegExp = globToRegexp(dir, { extended: true })
    const dirMatch: RegExp = new RegExp(dirMatchExact.toString().slice(1, -2))

    for (const file of files) {
    	const component = file.replace(root, '')

    	// absolute path localised to pages dir, without extension
    	// e.g. /home
        const filepath = file
            .replace(dirMatch, '')
            .replace(extensionMatch, '')

        const pathParts = filepath.split('/').slice(1)

        const isErrorRoute = (pathParts[pathParts.length - 1] === '_error')
        if (isErrorRoute) {
        	errorRoutes.push({
        		module: file,
        		parts: pathParts,
        		dir: join(...pathParts.slice(0, -1))
        	})
        }

        // ignore files and folders starting with an underscore
        // to allow non-route files to exist in the folder structure
        // (e.g. layouts and shared js resources)
        const ignore = pathParts.find(part => part.startsWith('_'))
        if (ignore) continue

        routes.push(createRoute(component, file, pathParts))
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

    return function matchFunction(path: string) {
    	const withoutQuery = path.replace(/\?.*$/, '')
    	for (const route of routes) {
    		const matches = route.match ? route.match(withoutQuery) : false
    		if (matches) return {
    			...structuredClone(template), 
    			route, 
    		}
    	}
    	return structuredClone(template)
    }
}


function createRoute(component: string, absPath: string, pathParts: string[]) {
	const route: Route = {
		module: absPath,
	    routepath: '',
	    parts: pathParts,
	    order: routeComplexity.STATIC,
	    error: undefined
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
	    		route.routepath += `/:${normalizedPart}+`
	    	} else {
	    		route.routepath += `/:${normalizedPart}`
	    	}
	    } else {
	        route.routepath += `/${normalizedPart}`
	    }
	}

	route.match = match(route.routepath, { decode: decodeURIComponent })
	route.regexp = pathToRegexp(route.routepath)
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