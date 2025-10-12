import type { ErrorPayload } from 'vite'
import type { RollupError } from 'rollup'
import { MultiError } from '../utility/MultiError.ts'

const ANSI_REGEXP = ansiRegex()


export function viteDevErrorPayload(err: RollupError): ErrorPayload {

	// try and provide a nicer error output on frontend, by shoving MultiError into:
	// .message, .file, .frame, .stack properties
	// this is not a very clean way to do this, but Vite doesn't support AggregateErrors
	// so we've got to work around it

	if (err instanceof MultiError && err.getErrors().length) {
		const errs = err.getErrors()

		err.message = 
			err.message 
			+ '\n\n' 
			+ 'Multiple errors in files:\n'

		// @ts-expect-error
		err.file = errs.map((err, i) => `${i+1}: ${err.loc?.file}`).join('\n')
		err.stack = errs.map(err => err.stack).join('\n\n')
	}

	let message = err.message.replace(ANSI_REGEXP, '')
	let frame = err.frame?.replace(ANSI_REGEXP, '') || ''
	let stack = err.stack?.replace(ANSI_REGEXP, '') || ''

	return {
		type: 'error',
		err: {
			name: err.name,
			message: message,
			stack,
			id: ('file' in err) ? err.file as string : '',
			frame,
			plugin: 'ssr-tools',
			loc: err.loc?.file && {
				file: err.loc?.file,
				line: err.loc?.line,
				column: err.loc?.column,
			} || undefined
		},
	}
}


// from: https://github.com/chalk/ansi-regex/blob/main/index.js
function ansiRegex({onlyFirst = false} = {}) {
	// Valid string terminator sequences are BEL, ESC\, and 0x9c
	const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)';

	// OSC sequences only: ESC ] ... ST (non-greedy until the first ST)
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;

	// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte
	const csi = '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]';

	const pattern = `${osc}|${csi}`;

	return new RegExp(pattern, onlyFirst ? undefined : 'g');
}