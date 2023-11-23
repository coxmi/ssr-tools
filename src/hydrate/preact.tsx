import { render, createContext } from 'preact'
import { useContext } from 'preact/hooks'

const isServer = typeof window === 'undefined'

// context to check whether a hydrated component
// is already in a hydrated component
let HydrationContext
if (isServer) {
	HydrationContext = createContext(false)
}


export const ssr = (Component, importPath) => (props) => {

	const name = Component.name || Component.prototype?.constructor?.name
	const hasParentHydration = useContext(HydrationContext)
	
	if (!hasParentHydration && Object.values(props).find((prop) => typeof prop === 'function'))
		throw new Error(`Can’t save function props in hydration data, component "${name}"`)

	return hasParentHydration
		? <Component {...props} /> 
		: <HydrationContext.Provider value={true}>
			<preact-island data-name={name} data-props={JSON.stringify(props)} data-import={importPath}>
				<Component {...props} />
			</preact-island>
			{/*<script src={pathToSource} data-name={name} data-props={JSON.stringify(props)} />*/}
			{/*<script type="marker" data-name={name} data-props={JSON.stringify(props)}></script>*/}
		  </HydrationContext.Provider>
}


export const client = () => {
	if (customElements.get('preact-island')) return
	customElements.define('preact-island', class PreactIsland extends HTMLElement {
		constructor() { 
			super()
		}

	  	async connectedCallback() {
	  		console.log(this.dataset)
	  		const script = this.dataset.import
	  		const name = this.dataset.name
	  		// const component = (await import(/* @vite-ignore */ script))[name]
	  		const props = JSON.parse(this.dataset.props  || '{}')
	  		// render(h(component, props), this)
		}
	})
}