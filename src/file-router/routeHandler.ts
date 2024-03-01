import { importUserModule } from '../utility/userEnv.ts'
import http from 'node:http'
import type { MatchedRoute } from './routes.ts'

const { default: renderToString } = await importUserModule('preact-render-to-string/jsx')

export type PageProps = {
	params: Record<string, string | string[]>,
	query: URLSearchParams,
	request: { 
		[key: string]: any 
	} & http.IncomingMessage & { 
		originalUrl: string,
		path: string,
		query: string,
	},
	response: http.ServerResponse,
}


export async function routeHandler(
	imported: any, 
	matched: MatchedRoute, 
	req: any, 
	res: any
): Promise<string | false> {

	const [path, query] = req.originalUrl.split('?')
	const searchParams = new URLSearchParams(query)

	// no default export go to next middleware
	if (!imported.default) return false

	// run the default export with props
	const result = await imported.default({ 
		params: matched?.params ? Object.freeze({ ...matched.params }) : {},
		query: searchParams,
		request: req, 
		response: res 
	})

	// no response, go to next middleware
	if (result === false || result === undefined) return false

	// allow string types as basic html
	if (typeof result === 'string') return result

	// preact element
	if (result !== null && result.constructor === undefined) {
		return renderToString(result, {}, { pretty: true, jsx: false })
	}

	return false
}