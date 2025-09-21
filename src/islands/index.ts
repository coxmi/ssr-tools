// @ts-nocheck

import { 
	createNamedExportAST,
	createVariable,
	createVariableFromVariableDeclarator,
	wrapWithCallExpression,
	addImportToAST, 
	walker
} from './ast.ts'

import type { 
	Program, 
	Node,
	Statement,
	Expression,
	ClassDeclaration, 
	ClassExpression, 
	CallExpression,
	AnonymousFunctionDeclaration,
	FunctionDeclaration, 
	FunctionExpression, 
	ArrowFunctionExpression,
    AnonymousClassDeclaration,
    ReturnStatement,
    Identifier
} from 'acorn'

type FunctionNodes = 
	AnonymousClassDeclaration |
	AnonymousFunctionDeclaration | 
	ArrowFunctionExpression | 
	ClassDeclaration |
	ClassExpression |
	FunctionDeclaration | 
	FunctionExpression

type FunctionParts = {
	fnBody: Statement[] | null,
	returnExpression: Expression | null
}


/*
 * Gets a Statement array and returned Expression from:
 * function, class declarations, arrow functions
 */
function functionParts(nodeAST: FunctionNodes): FunctionParts|false {

	const empty = {
		fnBody: null,
		returnExpression: null
	}

	if (nodeAST.type === 'FunctionDeclaration' || nodeAST.type === 'FunctionExpression') {
		if (nodeAST.body.type === 'BlockStatement' && nodeAST.body.body) {
			return {
				fnBody: nodeAST.body.body,
				returnExpression: findReturnExpression(nodeAST.body.body)
			}
		}
		return empty
	}

	if (nodeAST.type === 'ClassDeclaration' || nodeAST.type === 'ClassExpression') {
		if (!nodeAST.body.body) return empty
		const methods = nodeAST.body.body
		for (const method of methods) {
			if (
				method.type === 'MethodDefinition' && 
				method.key.type === 'Identifier' &&
				method.key.name.toLowerCase() === 'render'
			) {
				if (method.value.body.type === 'BlockStatement' && method.value.body.body) {
					return {
						fnBody: method.value.body.body,
						returnExpression: findReturnExpression(method.value.body.body)
					}
				}
				return empty
			}
		}
		return empty
	}

	if (nodeAST.type === 'ArrowFunctionExpression') {
		if (nodeAST.body.type === 'BlockStatement') {
			return {
				fnBody: nodeAST.body.body,
				returnExpression: findReturnExpression(nodeAST.body.body)
			}
		}
		if (nodeAST.body.type === 'CallExpression') {
			return {
				fnBody: [],
				returnExpression: nodeAST.body
			}
		}
	}

	function findReturnExpression(fnBlock: Statement[]) {
		const statement = fnBlock.find(x => x.type === 'ReturnStatement') as ReturnStatement | undefined
		if (statement && statement.argument) return statement.argument
		return null
	}

	return false
}


const hookRegex = /(use[A-Z])/
const onEventRegex = /(on[A-Z])/

const jsxReturnExpressionType = {
	'JSXFragment' : true,
	'JSXElement' : true,
} as const

const jsxRuntimeExpressions = {
	'jsx' : true,
	'jsxs' : true,
	'jsxDEV' : true,
	'_jsx' : true,
	'_jsxs' : true,
	'_jsxDEV' : true,
} as const

/*
 * Tests whether the passed node is an island
 * Takes function, arrow function, and class nodes
 */
function isNodeIsland(nodeAST: FunctionNodes) {

	const parts = functionParts(nodeAST)
	if (!parts) return false
	
	const { fnBody, returnExpression } = parts
	if (!returnExpression) return false

	// test for untransformed JSX as return type
	const hasReturnJSX = jsxReturnExpressionType[returnExpression.type] || false
	
	// test for jsx-runtime transform
	const hasReturnJSXRuntimeTransformed = (
		returnExpression.type === 'CallExpression' &&
		jsxRuntimeExpressions[returnExpression.callee?.name]
	)

	// bail early if no JSX found
	if (!hasReturnJSX && !hasReturnJSXRuntimeTransformed) {
		return false
	}

	// allow to set an island with "use island" as the first statement
	const first = fnBody?.[0]
	if (
		first && 
		first.type === 'ExpressionStatement' &&
		first.expression.value === 'use island'
	) {
		return true
	}

	// if it's a class and includes a componentDidMount function
	if (nodeAST.type === 'ClassDeclaration') {
		const methods = nodeAST.body.body
		const isCDM = m => (
			m.type === 'MethodDefinition' && 
			m.key.name === 'componentDidMount'
		)
		if (methods.find(isCDM)) return true
	}
	
	let isIsland = false

	walker(nodeAST, {
		CallExpression(node: CallExpression) {
			// test for hooks
			if (node.callee.name && hookRegex.test(node.callee.name)) {
				isIsland = true
			}
		},
		// ReturnStatement(node: ReturnStatement) {
	   	// 	walker(node, {
	   	// 		CallExpression(_node: CallExpression) {
	   	// 			// walk jsx calls, get props, and test for onEvent handler names
	   	// 			if (['_jsx', '_jsxs', '_jsxDEV'].includes(_node.callee?.name)) {
	   	// 				const props = _node.arguments?.[1]
	   	// 				if (!props || props.type !== 'ObjectExpression') return
	   					
	   	// 				const handlers = props.properties.filter(prop => {
	   	// 					const isEventHandler = prop?.key?.name && onEventRegex.test(prop.key.name)
	   	// 					return isEventHandler
	   	// 				})
	   	// 				if (handlers.length) isIsland = true
	   	// 			}
	   	// 		},
		//     })
	 	// },
		// JSXAttribute(node: Node) {
		// 	if (!node?.name?.name) return
		// 	const isExpression = node.value && node.value.type === 'JSXExpressionContainer'
		// 	const hasOnEventHandler = onEventRegex.test(node.name.name)
		// 	if (isExpression && hasOnEventHandler) isIsland = true
		// },
	})

	return isIsland
}


type ProcessExportOptions = {
	/** Name of function to wrap exports with */
	name: string,
	/** Node path e.g. `ssr-tools/islands/preact/ssr` of file to import hydration function from */
	importFrom?: string,
	/** Import the function with a named import (`name` argument) */
	importNamed?: boolean,
	/** Pass the path to the source file to the hydration function */
	pathToSource: string
	/** An ID for the source file to generate unique export names  */
	importId: string
}


type Manifest = string[]

/**
 * Processes islands exported in file and wraps island exports in a function, e.g. 
 * `export default ssr(IslandComponent, exportedName, '/path/to/source.jsx')`
 * @returns List of exports `[default, exportName1, exportName2, ...]`
 * @note Not a pure function, the AST's exports are transformed in place. Do a `structuredClone(ast)` before using if you need purity.
 */
export function processIslands(ast: Program, options: ProcessExportOptions): false | Manifest {

	if (!options) 
		throw new Error('No options provided')

	const {
		name: functionWrapName,
		importFrom,
		importNamed = false,
		pathToSource = '',
		importId = ''
	} = options

	if (!functionWrapName)
		throw new Error('`name` must be provided')

	// main process should only require two loops of the top-level of the AST
	// – one for gathering references/declarations to potential island functions
	// – one for processing exports in-place

	const { functions } = gatherFunctions(ast)

	// replace specific nodes in place where neccessary (maintaining the iteration position)
	// otherwise queue additions until the end of procesing
	const appendQueue: Array<() => void> = []
	let willAddImport = false

	// gather island exports in manifest
	const manifest: Manifest = []

	const componentId = (exportName: string): string => {
		return exportName + '_' + importId
	}

	for (let i = 0; i < ast.body.length; i++) {
		const position = i
		const node = ast.body[i]

		if (node.type === 'ExportDefaultDeclaration') {

			// variable export, e.g. `export default Component`
			// check against current file for previously declared functions 
			// then wrap the identifier in a hydration function call
			if (node.declaration.type === 'Identifier') {
				const name = node.declaration.name
				const fn = functions.get(name)
				if (fn && isNodeIsland(fn)) {
					const expression = node.declaration
					node.declaration = wrapWithCallExpression(
						functionWrapName, 
						expression, 
						{ type: 'Literal', value: 'default' },
						{ type: 'Literal', value: componentId('default') },
						{ type: 'Literal', value: pathToSource }
					)
					willAddImport = true
					manifest.push('default')
				}
				continue
			}

			// inline function or class expression
			// e.g.
			//	`export default () => {}`
			//	`export default function() {}`
			//	`export default class {}`
			// then wrap the expression with a hydration function call
			if (
				node.declaration.type === 'ClassDeclaration' ||
				node.declaration.type === 'FunctionDeclaration' ||
				node.declaration.type === 'ArrowFunctionExpression'
			) {
				const name = node.declaration?.name
				const fn = node.declaration
				if (fn && isNodeIsland(fn)) {
					const expression = node.declaration
					node.declaration = wrapWithCallExpression(
						functionWrapName, 
						expression, 
						{ type: 'Literal', value: 'default' },
						{ type: 'Literal', value: componentId('default') },
						{ type: 'Literal', value: pathToSource }
					)
					willAddImport = true
					manifest.push('default')
				}
				continue
			}
		}

		if (node.type === 'ExportNamedDeclaration') {

			// named specifier export
			// e.g. 
			//	`export { Component }`
			//	`export { Component as AltName }`
			if (!node.declaration && node.specifiers) {
				for (let position = 0; position < node.specifiers.length; position++) {
					const specifier = node.specifiers[position]
					if (specifier.local.type === 'Identifier') {	
						// local name is within the file,
						// exported is the `export { ref as name }` exported name
						const name = specifier.local.name
						const exportedName = specifier.exported.name || name
						const fn = functions.get(name)

						if (fn && isNodeIsland(fn)) {
							willAddImport = true
							manifest.push(exportedName)
							
							// remove name specifier and reset loop position
							node.specifiers.splice(position, 1)
							position--
							
							appendQueue.push(() => {
								// add island reference to end of ast
								ast.body.push(
									createVariable(
										`__${name}Island`, 
										wrapWithCallExpression(
											functionWrapName, 
											{ type: 'Identifier', name }, 
											{ type: 'Literal', value: exportedName },
											{ type: 'Literal', value: componentId(exportedName) },
											{ type: 'Literal', value: pathToSource }
										)
									)
								)

								// and add a named export
								ast.body.push(
									createNamedExportAST(`__${name}Island`, exportedName)
								)
							})
						}
					}
				}
				continue
			}
			
			// function and class named export
			// e.g. 
			//	`export function Component() {}`
			// 	`export class ClassName extends Component {}`
			if (
				node.declaration && (
					node.declaration.type === 'FunctionDeclaration' ||
					node.declaration.type === 'ClassDeclaration'
				)
			) {
				const name = node.declaration.id.name
				const fn = node.declaration as FunctionDeclaration | ClassDeclaration
				if (isNodeIsland(fn)) {
					willAddImport = true
					manifest.push(name)
					// swap export declaration out for simple function|class definition
					ast.body[position] = node.declaration

					// add island reference to end of ast
					ast.body.push(
						createVariable(
							`__${name}Island`, 
							wrapWithCallExpression(
								functionWrapName, 
								{ type: 'Identifier', name },
								{ type: 'Literal', value: name },
								{ type: 'Literal', value: componentId(name) },
								{ type: 'Literal', value: pathToSource },
							)
						)
					)

					// add new export at end of file for wrapped function
					ast.body.push(
						createNamedExportAST(`__${name}Island`, name)
					)
				}
				continue
			}

			// anonymous function named export
			// e.g. 
			//	`export const Component = () => {}`
			//	`export const Component = function() {}`
			if (node.declaration && node.declaration.type === 'VariableDeclaration') {
				for (let i = 0; i < node.declaration.declarations.length; i++) {
					const declaration = node.declaration.declarations[i]

					if (declaration.init && (
						declaration.init.type === 'FunctionExpression' 
						|| declaration.init.type === 'ArrowFunctionExpression'
						|| declaration.init.type === 'ClassExpression'
					)) {
						const name = declaration.id.name
						const fn = declaration.init

						if (isNodeIsland(fn)) {
							willAddImport = true
							manifest.push(name)

							// remove declaration and reset loop i
							node.declaration.declarations.splice(i, 1)
							i--

							// insert new variable declaration of the same name
							appendQueue.push(() => {
								ast.body.push(createVariableFromVariableDeclarator(declaration))

								// add island reference
								ast.body.push(
									createVariable(
										`__${name}Island`, 
										wrapWithCallExpression(
											functionWrapName, 
											{ type: 'Identifier', name },
											{ type: 'Literal', value: name },
											{ type: 'Literal', value: componentId(name) },
											{ type: 'Literal', value: pathToSource }
										)
									)
								)

								// add new export at end of file for wrapped function
								ast.body.push(
									createNamedExportAST(`__${name}Island`, name)
								)
							})
						}
					}
				}

				// if declarations array is empty, remove the variable declaration from the AST
				if (!node.declaration.declarations.length) {
					ast.body.splice(position, 1)
				}
				continue
			}
		}
	}

	appendQueue.map(fn => fn())

	if (importFrom && willAddImport) {
		addImportToAST(ast, functionWrapName, importFrom, { named: importNamed })
	}

	return manifest.length 
		? manifest 
		: false
}

/*
 * Gather function and class references in file
 * Their function bodies will be checked later to see if they're islands
 */
function gatherFunctions(ast: Program) {

	const functions = new Map<string, FunctionNodes>()
	const kinds = new Map<FunctionNodes, 'let'|'var'|'const'>()

	for (let i = 0; i < ast.body.length; i++) {
		const node = ast.body[i]

		if (node.type === 'VariableDeclaration') {
			const kind = node.kind
			for (const declaration of node.declarations) {
				// is Identifier check necessary?:
				// const isIdentifier = declaration.id && declaration.id.type === 'Identifier'
				const expression = declaration.init
				if (expression) {
					const isFunctionOrClass = (
						expression.type === 'FunctionExpression' ||
						expression.type === 'ArrowFunctionExpression' ||
						expression.type === 'ClassExpression'
					)
					if (isFunctionOrClass) {
						expression
						const name = declaration?.id?.name
						if (name) {
							functions.set(name, expression)
							kinds.set(expression, kind)
						}
					}
				}
			}
			continue
		}

		if (node.type === 'FunctionDeclaration') {
			const name = node?.id?.name
			if (name) functions.set(name, node)
			continue
		}

		if (node.type === 'ClassDeclaration') {
			const name = node?.id?.name
			if (name) functions.set(name, node)
			continue
		}
	}

	return {
		functions, 
		kinds
	}	
}