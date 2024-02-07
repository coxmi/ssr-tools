
const headIndent = /([ \t]*)<head/i
const headInjectRegex = /<\/head>/i
const bodyInjectRegex = /([ \t]*)<\/body>/i
const doctypeInjectRegex = /<!doctype html>/i


function addIndent(indent = '') {
	return `${indent}${indent[0] === '\t' ? '\t' : '  '}`
}


export function addToHead(html: string, tags: string[]): string {
	if (!tags.length) return html

	if (headInjectRegex.test(html)) {
		// indent of opening <head> tag
		const indent1 = (html.match(headIndent) || [])[1] || ''
		const indent2 = addIndent(indent1)

		return html.replace(headInjectRegex, () => {
			return indent1 + tags.join(`\n${indent2}`) + `\n${indent1}</head>`
		})
	}

    if (doctypeInjectRegex.test(html)) {
    	return html.replace(
    		doctypeInjectRegex,
    		(match) => `${match}\n${tags.join("\n")}`
    	)
    }

    // just add to start of string as a fallback
    return tags.join("\n") + "\n" + html
}

export function addToBody(html: string, tags: string[]): string {
	// add before body close
	if (bodyInjectRegex.test(html)) {
		return html.replace(
			bodyInjectRegex,
			(match, indent) => {
				const indent2 = addIndent(indent)
				return indent2 + tags.join(indent2) + `\n${match}`
			}
		)
	}

	return html + "\n" + tags.join("\n")
}
