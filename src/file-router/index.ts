import globToRegexp from 'glob-to-regexp'
import { pathToRegexp, match } from 'path-to-regexp'
import { ImportMode, ImportModeResolveFn, Route } from './options.ts'
import { basename } from 'path'

export interface BuildRoutesContext {
    files: string[];
    dir: string;
    root: string;
}

export function buildRoutes({ files, dir, root }: BuildRoutesContext) {
    
    const routes: Route[] = []

    const extensionMatch = /\.[^\.]+$/
    const pathExactMatch: RegExp = globToRegexp(dir, { extended: true })

    // removes unnecessary '/' from start, and '$/' from end of regex, e.g:
    // from: /^\/path\/to\/folder$/ 
	// to:   ^\/path\/to\/folder
    const pathStartMatch: RegExp = new RegExp(
    	pathExactMatch.toString().slice(1, -2)
    )

    for (const file of files) {

    	// ignore files starting with an underscore,
    	// to allow layouts and shared js resources
    	if (basename(file).startsWith('_')) continue

        const pathParts = file
	        // remove root directory path
            .replace(pathStartMatch, '')
            // remove final extension (supports route.foo.tsx -> route.foo)
            .replace(extensionMatch, '')
            .split('/')
            // remove inital /
            .slice(1)

        const component = file.replace(root, '')

        const route: Route = {
            name: '',
            path: '',
            component: component.startsWith('/') 
            	? component
            	: `/${component}`,
        };

        let parent = routes

        for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i]

            // Remove square brackets at the start and end
            const isDynamicPart = isDynamicRoute(part)
            const normalizedPart = (isDynamicPart
                ? part.replace(/^\[(\.{3})?/, '').replace(/\]$/, '')
                : part
            ).toLowerCase()

            route.name += route.name 
            	? `-${normalizedPart}` 
            	: normalizedPart

            const child = parent.find(
                (parentRoute) => parentRoute.name === route.name
            )

            if (child) {
                child.children = child.children || []
                parent = child.children
                route.path = ''
            } else if (normalizedPart === 'index' && !route.path) {
                route.path += '/'
            } else if (normalizedPart !== 'index') {
                if (isDynamicPart) {
                    route.path += `/:${normalizedPart}`
                    // Catch-all route
                    if (/^\[\.{3}/.test(part)) {
                        route.path += '(.*)'
                    } else if (i === pathParts.length - 1) {
                        route.path += '?'
                    }
                } else {
                    route.path += `/${normalizedPart}`
                }
            }
        }

        parent.push(route)
    }

    return prepareRoutes(routes)
}


export function matchRoute(path: string, routes: Route[]) {
	const withoutQuery = path.replace(/\?.*$/, '')
	for (const route of routes) {
		const matches = route.match ? route.match(withoutQuery) : false
		if (matches) return route
	}
	return false
}

const isDynamicRoute = (s: string) => /^\[.+\]$/.test(s)


/**
 * Performs a final cleanup on the routes array.
 * This is done to ease the process of finding parents of nested routes.
 */
function prepareRoutes(
    routes: Route[],
    parent?: Route
) {
    for (const route of routes) {
        if (route.name) {
            route.name = route.name.replace(/-index$/, '')
        }

        if (parent) {
            route.path = route.path.replace(/^\//, '').replace(/\?$/, '')
        }

        if (route.children) {
            delete route.name
            route.children = prepareRoutes(route.children, route)
        }

        route.match = match(route.path, { decode: decodeURIComponent })
        route.regexp = pathToRegexp(route.path)
    }
    return routes
}

function resolveImportMode(
    filepath: string,
    mode: ImportMode | ImportModeResolveFn
) {
    if (typeof mode === 'function') {
        return mode(filepath)
    }
    return mode
}

function pathToName(filepath: string) {
    return filepath.replace(/[\_\.\-\\\/]/g, '_').replace(/[\[:\]()]/g, '$')
}