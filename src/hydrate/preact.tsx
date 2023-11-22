
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

const isServer = typeof window === 'undefined'


// context to check whether a hydrated component
// is already in a hydrated component

let HydrationContext


// stores all hydration data with id

let _hydrationData = {}

if (isServer) {
	HydrationContext = createContext(false)
}


export const hydrate = (Component) => (props) => {

	if (!isServer) return <Component {...props} /> 

	const name = Component.name || Component.prototype?.constructor?.name
	const hasParentHydration = useContext(HydrationContext)
	
	if (!hasParentHydration && Object.values(props).find((prop) => typeof prop === 'function'))
		throw new Error(`Can’t save function props in hydration data, component "${name}"`)

	return hasParentHydration
		? <Component {...props} /> 
		: <HydrationContext.Provider value={true}>
			<preact-island data-name={name} data-props={JSON.stringify(props)}>
				<Component {...props} />
			</preact-island>
			<script type="marker" data-name={name} data-props={JSON.stringify(props)}></script>
		  </HydrationContext.Provider>
}

// NOTES
/*

For automatic hydration:
	- return list of island files & exports by name/default
	- build into one list of export { Blah } from '/abs/path/to/file'
		Options:
			vite virtual import
			global islands.js file with all
				emitFile with all after buildEnd
			islands per-route
				emitFile per route — assuming it works its way into the manifest?
			atomic – don't bother, this can be done manually?
				emit individual files — does this add all components to the manifest?

*/