import { h, hydrate } from 'preact'

export const client = (islands) => {
	if (customElements.get('preact-island')) return
	customElements.define('preact-island', class PreactIsland extends HTMLElement {
		constructor() { 
			super()
		}
	  	async connectedCallback() {
	  		const component = islands[this.dataset.import]
	  		const props = JSON.parse(this.dataset.props  || '{}')
	  		hydrate(h(component, props), this)
		}
	})
}