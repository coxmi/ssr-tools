import { join } from 'node:path'
import globToRegexp from 'glob-to-regexp'
import { pathToRegexp, match } from 'path-to-regexp'
import type { Prettify } from './../utility/types.ts'

const paramTypes = Object.freeze({
	SINGLE: 'single',
	MULTIPLE: 'multiple',
})

const routeComplexity = Object.freeze({
	BASIC: 1,
	PARAMS: 2,
	SPREAD: 3,
})

type Values<T> = Prettify<T[keyof T] & {}>

export type Route = {
	name: string
	module: string
	routepath: string
	segments: string[]
	requiredParams: Record<string, Values<typeof paramTypes>>
	type: Values<typeof routeComplexity>
	order: number,
	match: MatchFn
	matchParams: MatchParamsFn
	regexp?: RegExp
	error: ErrorRoute | undefined
}

type ParamData = Record<string, string | string[] | undefined>

type MatchedOutput = {
	path: string
	params: ParamData
}

type MatchFn = (url: string) => false | MatchedOutput
type MatchParamsFn = (params: ParamData) => false | never | MatchedOutput

export type ErrorRoute = {
	module: string	
	segments: string[]
	dir: string
}

export type MatchedRoute = {
	route: Route
	params: ParamData
}

export type BuildRoutesArgs = {
    files: string[]
    dir: string
    remapFiles?: (path: string) => string | false
}


// match only the final extension (to support route.foo.tsx -> route.foo)
const extensionMatch = /\.[^\.]+$/

// match any `[slug]` or '[...slug]' param segments 
const paramSegmentMatch = /\[.+\]/

// matches '[...slug]' url part
const catchAllSectionMatch = /^\[\.{3}.+\]/

// query strings
const queryMatch = /\?.*$/


/**
 * build a list of routes to match against URLs.
 * To test the built routes against live URLs use `routes.matchRoute(path, routes)`
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

    	// absolute path localised to router dir (e.g. /[slug]/index.ts)
    	// and without extension (e.g. /[slug]/index)
    	const filepathExt = file.replace(dirMatch, '')
        const filepath = filepathExt.replace(extensionMatch, '')
        const segments = filepath.split('/').slice(1)

        const isErrorRoute = (segments[segments.length - 1] === '_error')
        if (isErrorRoute) {
        	errorRoutes.push({
        		module: absPath,
        		segments: segments,
        		dir: join(...segments.slice(0, -1))
        	})
        }

        // ignore files and folders starting with an underscore
        // to allow non-route files to exist in the folder structure
        // (e.g. layouts and shared js resources)
        const ignore = segments.find(part => part.startsWith('_'))
        if (ignore) continue

        routes.push(createRoute(filepathExt, absPath, segments))
    }
    
    // add error property to routes, using default error handler
    const defaultError = findErrorRoute(errorRoutes, ['index'])
    for (const route of routes) {
    	route.error = findErrorRoute(errorRoutes, route.segments) || defaultError
    }

    routes.sort((a, b) => Math.sign(a.order - b.order))

    const routesByFile: Record<string, Route> = {}
    for (const route of routes) {
    	routesByFile[route.module] = route
    }

    return {
    	routes,
    	errorRoutes,
    	matchRoute: function (path: string, route?: Route): MatchedRoute | false {
	    	const withoutQuery = path.replace(queryMatch, '')
	    	if (route) {
	    		const matches = route.match(withoutQuery)
	    		if (matches) return {
	    			route, 
	    			params: matches.params,
	    		}
	    	}
	    	for (const route of routes) {
	    		const matches = route.match(withoutQuery)
	    		if (matches) return {
	    			route, 
	    			params: matches.params,
	    		}
	    	}
	    	return false
	    },
	    findRouteByFile: function(file: string): Route | null {
	    	return routesByFile[file] || null
	    },
    }
}

function createRoute(name: string, absPath: string, segments: string[]) {
	
	const route: Route = {
		name,
		module: absPath,
	    routepath: '',
	    segments,
	    requiredParams: {},
	    type: routeComplexity.BASIC,
	    order: routeComplexity.BASIC,
	    match: () => false,
	    matchParams: () => false,
	    error: undefined
	}

	for (let i = 0; i < segments.length; i++) {
		const part = segments[i]
	    const isParamSegment = paramSegmentMatch.test(part)
	    
	    // match routes in order of complexity (basic, param, spread)
	    // also multiply by depth (i) to factor in tree, 
	    // making sure spread routes are at the end
	    const maxDirectoryDepth = 100

	    if (isParamSegment && !part.startsWith('[...')) {
	    	const order = routeComplexity.PARAMS + (i/-maxDirectoryDepth)
	    	if (order > route.order) route.order = order
	    	if (route.type < routeComplexity.PARAMS) 
	    		route.type = routeComplexity.PARAMS
	    }

	    if (part.startsWith('[...')) {
	    	const order = routeComplexity.SPREAD + (i/-maxDirectoryDepth)
	    	if (order > route.order) route.order = order
	    	if (route.type < routeComplexity.SPREAD)
	    		route.type = routeComplexity.SPREAD
	    }

		// Remove square brackets at the start and end
	    const normalizedSegment = (isParamSegment
	        ? part.replace(/^\[(\.{3})?/, '').replace(/\]$/, '')
	        : part
	    ).toLowerCase()

	    if (!isParamSegment && normalizedSegment === 'index') {
	    	const first = i === 0
	    	const last = (i === segments.length - 1)
	    	// root index
	    	if (first) route.routepath += '/'
	    	// skip index parts at the end
	    	if (last) continue
	    }
	    
	    if (isParamSegment) {
	    	if (catchAllSectionMatch.test(part)) {
	    		route.requiredParams[normalizedSegment] = 'multiple'
	    		route.routepath += `/*${normalizedSegment}`
	    	} else {
	    		route.requiredParams[normalizedSegment] = 'single'
	    		route.routepath += `/:${normalizedSegment}`
	    	}
	    } else {
	        route.routepath += `/${normalizedSegment}`
	    }
	}

	route.match = match(route.routepath, { 
		decode: decodeURIComponent 
	})

	route.matchParams = (params: ParamData) => validateParams(params, route)

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

export function isBasic(route: Route) {
	return !isDynamic(route)
}

export function isDynamic(route: Route) {
	return (
		(route.type === routeComplexity.PARAMS) 
		|| (route.type === routeComplexity.SPREAD)
	)
}

function segmentDisallowedChars(segment: string): string[] {
	const regexp = /[\\\/\?\#]/g
	return [...segment.matchAll(regexp)].map(match => match[0])
}

function onlyUnique<T>(value: T, index: number, array: T[]) {
  return array.indexOf(value) === index
}

function arrayDisallowedChars(array: string[]): string[] {
	let disallowed: string[] = []
	array.map(segment => {
		const chars = segmentDisallowedChars(segment)
		disallowed.push(...chars)
	})
	return disallowed.filter(onlyUnique)
}

function validateParams(params: ParamData, route: Route): never | MatchedOutput {

	const errors: Record<string, boolean> = {}
	const outputParams: ParamData = {}
	let reifiedPath = route.routepath

	for (const param in route.requiredParams) {
		const type = route.requiredParams[param]
		const value = params[param]

		if (!(param in params)) {
			errors[`"${param}" not found`] = true
			continue
		}

		if (type === 'multiple') {
			const isStringArray = Array.isArray(value) && value.every(x => typeof x === 'string')
			if (!isStringArray) {
				errors[`"${param}" must be an array of strings`] = true
				continue
			}
			const disallowedChars = arrayDisallowedChars(value)
			if (disallowedChars.length) {
				const s = disallowedChars.length === 1 ? '' : 's'
				const chars = '"' + disallowedChars.join(', ') + '"'
				errors[
					`Segment for "${param}" includes disallowed character${s} ${chars} in url params: ` +
					`["${value.join('", "')}"]`
				] = true
				continue
			}
			reifiedPath = reifiedPath.replace(`*${param}`, value.join('/'))

		} else if (type === 'single') {
			 if (typeof value !== 'string') {
				errors[`"${param}" must be a string`] = true
				continue
			}

			const disallowedChars = segmentDisallowedChars(value)
			if (disallowedChars.length) {
				const s = disallowedChars.length === 1 ? '' : 's'
				const chars = '"' + disallowedChars.join(', ') + '"'
				errors[
					`Segment for "${param}" includes disallowed character${s} ${chars} in url params: ` +
					`["${value}"]`
				] = true
				continue
			}
			reifiedPath = reifiedPath.replace(`:${param}`, value)
		}

		outputParams[param] = value
	}

	const errs = Object.keys(errors)
	if (errs.length) {
		throw new Error(errs.join(', '))
	}

	return {
		path: reifiedPath,
		params: outputParams
	}
}

export function regexes(segments: Array<RegExp|string>, flags?: string) {
    return new RegExp(
        segments.map(segment => {
            if (segment instanceof RegExp) return segment.source
            return segment.toString()
        }).join(''),
        flags
    )
}

const permalinkPattern:RegExp = regexes(
    [
        // just a root path: "/",
        /^\/$|/,
        // or:
            // negative lookahead across pattern
            // to catch likely mistakes
            `^(?!`,
                // disallow more than double dots everywhere
                /.*\.{3,}.*|/,
                // disallow double dots at start of files
                /.*\.{2,}(?!\/|$)/,
            `)`,
            // start with slash
            /\//,
            // path segment, 1 or more
            `(?:`,
                // standard limited characters
                /[a-z0-9-_.]+/,
                // optional trailing slash
                /\/?/,
            `)+`,
        // end (discounts ?query, #hash, etc.)
        /$/
    ],
    'i'
)

function validateUrl(permalink: string): boolean {
    return permalinkPattern.test(permalink)   
}