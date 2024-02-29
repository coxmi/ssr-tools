import { h, hydrate } from 'preact'

export const client = (islands: Record<string, any>) => {
	if (customElements.get('preact-island')) return
	customElements.define('preact-island', class PreactIsland extends HTMLElement {
		constructor() { 
			super()
		}
	  	async connectedCallback() {
	  		if (!this.dataset.import) return
	  		const component = islands[this.dataset.import]
	  		const props = JSON.parse(this.dataset.props  || '{}')
	  		hydrate(h(component, props), this)
		}
	})
}