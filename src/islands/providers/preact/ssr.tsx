import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { Component, Context } from 'preact'

const isServer = typeof window === 'undefined'

let HydrationContext: Context<boolean>
if (isServer) {
	HydrationContext = createContext(false)
}

export const ssr = (Component: Component, name: string, importPath: string) => props => {

	const hasParentHydration = useContext(HydrationContext)

	return hasParentHydration
		? <Component {...props} /> 
		: <HydrationContext.Provider value={true}>
			<preact-island data-name={name} data-props={JSON.stringify(props)} data-import={importPath}>
				<Component {...props} />
			</preact-island>
		  </HydrationContext.Provider>
}