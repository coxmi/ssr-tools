import { locFromStack, generateCodeFrameFromError } from './generateCodeFrame.ts'
import { styleText } from 'node:util'


type MultiErrorOptions = {
	prefix?: string
	fixStacktrace?: (e: Error) => void
}

const newlineRE = /\r?\n/

// doesn't extend AggregateError because it shows in the console 
// as a strangely-formatted array/string crossover

export class MultiError extends Error {
	
	#errRecord: Record<string, Error> = {}
	#prefix = ''
	#_errors: Array<Error> = []

	#fixStacktrace = (e: Error) => {}

	constructor(message: string = '', options: MultiErrorOptions = {}) { 
		const { 
			prefix = '', 
			fixStacktrace = e => {} 
		} = options
		super(message)
		// @ts-ignore
		this.name = 'MultiError'
		this.#prefix = prefix
		this.#fixStacktrace = fixStacktrace
		// discard the stack, because we'll generate this using child errors
		this.stack = '\n\n' + this.stackStart()
	}

	stackStart(prefix = this.#prefix) {
		return styleText(
			'red', 
			MultiError.firstLine(this.name, prefix, this.message)
		)
	}

	static firstLine(name: string, prefix: string, message: string) {
		return [
			name,
			[prefix, message].filter(Boolean).join(' – ')
		].join(': ')
	}
	
	add(err: Error) {	
		if (err instanceof MultiError) {
			throw new Error('MultiErrors must be merged, not added')
		}

		// don't add if it already exists
		if (this.#errRecord[err.message]) return this
		this.#errRecord[err.message] = err
		this.#_errors.push(err)
		this.fixStacktrace(err)
		let [
			_, 
			...stackLines
		] = (err.stack || '').split(newlineRE)

		const firstLine = MultiError.firstLine(err.name, this.#prefix, err.message)

		// add custom properties for vite (sorry in advance, typescript)
		// @ts-expect-error
		err.loc = locFromStack(err.stack)
		// @ts-expect-error
		const isLib = err.loc.file.includes('/node_modules/') || err.loc.file.includes('/ssr-tools/')
		// @ts-expect-error
		err.frame = generateCodeFrameFromError(err.loc)
		// reconstruct the stack of the individual errors
		err.stack = [
			firstLine,
			// @ts-expect-error
			isLib ? '' : err.frame,
			styleText('dim', stackLines.join('\n'))
		].filter(Boolean).join('\n\n')

		// add to aggregate error stack
		this.stack += '\n\n' + err.stack
		return this
	}

	merge(...errs: MultiError[]) {	

		const errorsToMerge = errs.map(err => {
			Object.values(err.#errRecord).map(e => {
				// merge prefixes
				if (e.stack) e.stack = e.stack?.replace(
					err.#prefix, 
					[this.#prefix, err.#prefix].filter(Boolean).join(' ')
				)
			})
			return err.#errRecord
		})
		Object.assign(this.#errRecord, ...errorsToMerge)
		this.#_errors = Object.values(this.#errRecord)

		// rebuild stack
		this.stack = '\n\n' 
			+ this.stackStart()
			+ '\n\n'
			+ this.#_errors.map(err => err.stack).join('\n\n')

		return this
	}

	fixStacktrace(e: Error) {
		this.#fixStacktrace(e)
		e.stack = e.stack?.replaceAll('__vite_ssr_export_default__', 'default export')
	}

	getErrors() {
		return this.#_errors
	}

	get length() {
		return this.#_errors.length
	}
}