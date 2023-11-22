
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
function functionParts(nodeAST: FunctionNodes): FunctionParts {

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
		throw new Error(`functionParts cannot deal with arrow function body of type: ${nodeAST.body.type}`)
	}

	function findReturnExpression(fnBlock: Statement[]) {
		const statement = fnBlock.find(x => x.type === 'ReturnStatement') as ReturnStatement | undefined
		if (statement && statement.argument) return statement.argument
		return null
	}

	throw new Error(`isNodeIsland cannot deal with type: ${nodeAST.type}`)
}


/*
 * Tests whether the passed node is an island
 * Takes function, arrow function, and class nodes
 */
function isNodeIsland(nodeAST: FunctionNodes) {

	const { fnBody, returnExpression } = functionParts(nodeAST)

	if (!returnExpression) return false

	// test for untransformed JSX as return type
	const hasReturnJSX = ['JSXFragment', 'JSXElement'].includes(returnExpression.type)
	
	// test for jsx-runtime transform
	const hasReturnJSXRuntimeTransformed = (
		returnExpression && 
		returnExpression.type === 'CallExpression' && 
		['_jsx', '_jsxs', '_jsxDEV'].includes(returnExpression.callee?.name)
	)

	// bail early if no JSX found
	if (!hasReturnJSX && !hasReturnJSXRuntimeTransformed) {
		return false
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

	// find internal triggers for dom events
	const internalTriggers: string[] = []
	let isIsland = false

	if (fnBody) {
		fnBody.forEach(statement => {
			if (statement.type == 'FunctionDeclaration') {
				internalTriggers.push(statement.id.name)
			}
			if (statement.type == 'VariableDeclaration') {
				const arrow = statement.declarations.find(
					x => x.init.type === 'ArrowFunctionExpression'
				)
				if (!arrow) return
				internalTriggers.push(arrow.id.name)
			}
		})
	}

	walker(nodeAST, {
		Identifier(node: Identifier) {
		    if (/(use[A-Z])/.test(node.name)) isIsland = true
		},
		ReturnStatement(node: ReturnStatement) {
	   		walker(node, {
	    		Identifier(_node: Identifier) {
		    		if (_node.name && internalTriggers.includes(_node.name)) {
						isIsland = true
			        }
		     	},
		     	ArrowFunctionExpression(_node: ArrowFunctionExpression) {
			       isIsland = true
			    },
		    })
	 	},
		JSXAttribute(node: Node) {
		  	const isExpression = node.value && node.value.type === 'JSXExpressionContainer'
		  	if (!isExpression) return

		  	const isArrowFn = node.value.expression.type === 'ArrowFunctionExpression'
			const isLocalFnRef = (
				node.value.expression.type == 'Identifier' && 
				internalTriggers.includes(node.value.expression.name)
			)

		    if (isArrowFn || isLocalFnRef) isIsland = true
		},
	})

	return isIsland
}


type ProcessExportOptions = {
	name: string,
	importFrom?: string,
	importNamed?: boolean
}

type Manifest = Array<string>

/*
 * Not a pure function, the AST's exports are transformed in place
 * Do a structuredClone(ast) before using if you need purity
 */
export function processIslands(ast: Program, options: ProcessExportOptions): false | Manifest {

	if (!options) 
		throw new Error('No options provided')

	const {
		name: functionWrapName,
		importFrom,
		importNamed = false
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
					node.declaration = wrapWithCallExpression(functionWrapName, expression)
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
					node.declaration = wrapWithCallExpression(functionWrapName, expression)
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
						const exportedName = specifier.exported.name
						const fn = functions.get(name)

						if (fn && isNodeIsland(fn, name)) {
							willAddImport = true
							manifest.push(exportedName || name)
							
							// remove name specifier and reset loop position
							node.specifiers.splice(position, 1)
							position--
							
							appendQueue.push(() => {
								// add island reference to end of ast
								ast.body.push(
									createVariable(`__${name}Island`, wrapWithCallExpression(functionWrapName, {
									    type: 'Identifier', name: name,
									}))
								)

								// and add a named export
								ast.body.push(
									createNamedExportAST(`__${name}Island`, exportedName || name)
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
						createVariable(`__${name}Island`, wrapWithCallExpression(functionWrapName, {
						    type: 'Identifier', name: name,
						}))
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
									createVariable(`__${name}Island`, wrapWithCallExpression(functionWrapName, {
									    type: 'Identifier',
									    name: name,
									}))
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