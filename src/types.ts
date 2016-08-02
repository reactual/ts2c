import * as ts from 'typescript';

export type CType = string | StructType | ArrayType | DictType;
export const UniversalVarType = "struct js_var *";
export const PointerVarType = "void *";
export const StringVarType = "const char *";
export const NumberVarType = "int16_t";
export const BooleanVarType = "uint8_t";
type PropertiesDictionary = { [propName: string]: CType };

export class ArrayType {
    public getText() {
        let elementType = this.elementType;
        let elementTypeText;
        if (typeof elementType === 'string')
            elementTypeText = elementType;
        else
            elementTypeText = elementType.getText();

        if (this.isDynamicArray)
            return "ARRAY(" + elementTypeText + ")";
        else
            return "static " + elementTypeText + " {var}[" + this.capacity + "]";
    }
    constructor(
        public elementType: CType,
        public capacity: number,
        public isDynamicArray: boolean
    ) { }
}

export class StructType {
    public getText() {
        return this.structName;
    }
    constructor(
        private structName: string,
        public properties: PropertiesDictionary
    ) { }
}
export class DictType {
    public getText() {
        let elementType = this.elementType;
        let elementTypeText;
        if (typeof elementType === 'string')
            elementTypeText = elementType;
        else
            elementTypeText = elementType.getText();

        return "DICT(" + elementTypeText + ")";
    }
    constructor(
        public elementType: CType
    ) { }
}

export class VariableInfo {
    /** Name of the variable */
    name: string;
    /** The final determined C type for this variable */
    type: CType;
    /** Contains all references to this variable */
    references: ts.Node[] = [];
    /** Where variable was declared */
    declaration: ts.VariableDeclaration;
    /** Determines if the variable requires memory allocation */
    requiresAllocation: boolean;
}

class TypePromise {
    public resolved: boolean = false;
    public associatedProperty: string;
    public arrayOf: boolean = false;
    constructor(
        public associatedNode: ts.Node,
        public element: string | boolean
    ) { }
}

class VariableData {
    tsType: ts.Type;
    assignmentTypes: { [type: string]: CType } = {};
    typePromises: TypePromise[] = [];
    addedProperties: { [propName: string]: CType } = {};
    parameterIndex: number;
    parameterFuncDeclPos: number;
    objLiteralAssigned: boolean = false;
    isDynamicArray: boolean;
    isDict: boolean;
}


export class TypeHelper {
    public variables: { [varDeclPos: number]: VariableInfo } = {};

    private userStructs: { [name: string]: StructType } = {};
    private variablesData: { [varDeclPos: number]: VariableData } = {};
    private functionCallsData: { [funcDeclPos: number]: (CType | TypePromise)[] } = {};
    private functionReturnsData: { [funcDeclPos: number]: CType | TypePromise } = {};
    private functionReturnTypes: { [funcDeclPos: number]: CType } = {};
    private functionPrototypes: { [funcDeclPos: number]: ts.FunctionDeclaration } = {};
    private arrayLiteralsTypes: { [litArrayPos: number]: CType } = {};
    private objectLiteralsTypes: { [litObjectPos: number]: CType } = {};

    constructor(private typeChecker: ts.TypeChecker) { }

    /** Performs initialization of variables array */
    /** Call this before using getVariableInfo */
    public figureOutVariablesAndTypes(sources: ts.SourceFile[]) {

        for (let source of sources)
            this.findVariablesRecursively(source);
        this.resolvePromisesAndFinalizeTypes();

        let structs = Object.keys(this.userStructs)
            .filter(k => Object.keys(this.userStructs[k].properties).length > 0)
            .map(k => {
                return {
                    name: k,
                    properties: Object.keys(this.userStructs[k].properties)
                        .map(pk => {
                            return {
                                name: pk,
                                type: this.userStructs[k].properties[pk]
                            };
                        })
                };
            });

        let functionPrototypes = Object.keys(this.functionPrototypes).map(k => this.functionPrototypes[k]);

        return [structs, functionPrototypes];

    }

    public getCType(node: ts.Node): CType {
        if (!node.kind)
            return null;
        switch (node.kind) {
            case ts.SyntaxKind.NumericLiteral:
                return NumberVarType;
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword:
                return BooleanVarType;
            case ts.SyntaxKind.StringLiteral:
                return StringVarType;
            case ts.SyntaxKind.Identifier:
                {
                    let varInfo = this.getVariableInfo(<ts.Identifier>node);
                    return varInfo && varInfo.type || null;
                }
            case ts.SyntaxKind.ElementAccessExpression:
                {
                    let elemAccess = <ts.ElementAccessExpression>node;
                    let parentObjectType = this.getCType(elemAccess.expression);
                    if (parentObjectType instanceof ArrayType)
                        return parentObjectType.elementType;
                    else if (parentObjectType instanceof StructType)
                        return parentObjectType.properties[elemAccess.argumentExpression.getText().slice(1, -1)];
                    else if (parentObjectType instanceof DictType)
                        return parentObjectType.elementType;
                    return null;
                }
            case ts.SyntaxKind.PropertyAccessExpression:
                {
                    let propAccess = <ts.PropertyAccessExpression>node;
                    let parentObjectType = this.getCType(propAccess.expression);
                    if (parentObjectType instanceof StructType)
                        return parentObjectType.properties[propAccess.name.getText()];
                    else if (parentObjectType instanceof ArrayType && propAccess.name.getText() == "length")
                        return NumberVarType;
                    else if (parentObjectType === StringVarType && propAccess.name.getText() == "length")
                        return NumberVarType;
                    return null;
                }
            case ts.SyntaxKind.CallExpression:
                {
                    let call = <ts.CallExpression>node;
                    if (call.expression.kind == ts.SyntaxKind.PropertyAccessExpression) {
                        let propAccess = <ts.PropertyAccessExpression>call.expression;
                        if (propAccess.name.getText() == 'pop' && call.arguments.length == 0) {
                            let arrType = this.getCType(propAccess.expression);
                            if (arrType && arrType instanceof ArrayType)
                                return arrType.elementType;
                        }
                        else if (propAccess.name.getText() == 'push' && call.arguments.length == 1) {
                            let arrType = this.getCType(propAccess.expression);
                            if (arrType && arrType instanceof ArrayType)
                                return NumberVarType;
                        }
                        else if (propAccess.name.getText() == 'indexOf' && call.arguments.length == 1) {
                            let arrType = this.getCType(propAccess.expression);
                            if (arrType && (arrType == StringVarType || arrType instanceof ArrayType))
                                return NumberVarType;
                        }
                    } else if (call.expression.kind == ts.SyntaxKind.Identifier) {
                        let funcSymbol = this.typeChecker.getSymbolAtLocation(call.expression);
                        if (funcSymbol != null) {
                            let funcDeclPos = funcSymbol.valueDeclaration.pos + 1;
                            return this.functionReturnTypes[funcDeclPos];
                        }
                    }
                    return null;
                }
            case ts.SyntaxKind.ArrayLiteralExpression:
                return this.arrayLiteralsTypes[node.pos];
            case ts.SyntaxKind.ObjectLiteralExpression:
                return this.objectLiteralsTypes[node.pos];
            case ts.SyntaxKind.FunctionDeclaration:
                return this.functionReturnTypes[node.pos + 1] || 'void';
            default:
                {
                    let tsType = this.typeChecker.getTypeAtLocation(node);
                    let type = tsType && this.convertType(tsType);
                    if (type != UniversalVarType && type != PointerVarType)
                        return type;
                }
                return null;
        }
    }

    /** Get information of variable specified by ts.Identifier */
    public getVariableInfo(node: ts.Identifier): VariableInfo {
        let ident = node;
        let symbol = this.typeChecker.getSymbolAtLocation(ident);
        if (symbol != null)
            return this.variables[symbol.valueDeclaration.pos];
        else
            return null;
    }

    /** Get textual representation of type of the parameter for inserting into the C code */
    public getTypeString(source) {

        if (source.flags != null && source.intrinsicName != null) // ts.Type
            source = this.convertType(source)
        else if (source.flags != null && source.callSignatures != null && source.constructSignatures != null) // ts.Type
            source = this.convertType(source)
        else if (source.kind != null && source.flags != null) // ts.Node
            source = this.getCType(source);
        else if (source.name != null && source.flags != null && source.valueDeclaration != null && source.declarations != null) //ts.Symbol
            source = this.variables[source.valueDeclaration.pos].type;

        if (source instanceof ArrayType)
            return source.getText();
        else if (source instanceof StructType)
            return source.getText();
        else if (source instanceof DictType)
            return source.getText();
        else if (typeof source === 'string')
            return source;
        else
            throw new Error("Unrecognized type source");
    }

    /** Convert ts.Type to CType */
    /** Used mostly during type preprocessing stage */
    private convertType(tsType: ts.Type, ident?: ts.Identifier): CType {
        if (!tsType || tsType.flags == ts.TypeFlags.Void)
            return "void";

        if (tsType.flags == ts.TypeFlags.String)
            return StringVarType;
        if (tsType.flags == ts.TypeFlags.Number)
            return NumberVarType;
        if (tsType.flags == ts.TypeFlags.Boolean)
            return BooleanVarType;

        if (tsType.flags & ts.TypeFlags.ObjectType && tsType.getProperties().length > 0) {
            return this.generateStructure(tsType, ident);
        }

        if (tsType.flags == ts.TypeFlags.Any)
            return PointerVarType;

        console.log("Non-standard type: " + this.typeChecker.typeToString(tsType));
        return UniversalVarType;
    }

    private temporaryVariables: { [scopeId: string]: string[] } = {};
    private iteratorVarNames = ['i', 'j', 'k', 'l', 'm', 'n'];
    public addNewIteratorVariable(scopeNode: ts.Node): string {
        let parentFunc = this.findParentFunction(scopeNode);
        let scopeId = parentFunc && parentFunc.pos + 1 || 'main';
        let existingSymbolNames = this.typeChecker.getSymbolsInScope(scopeNode, ts.SymbolFlags.Variable).map(s => s.name);
        if (!this.temporaryVariables[scopeId])
            this.temporaryVariables[scopeId] = [];
        existingSymbolNames = existingSymbolNames.concat(this.temporaryVariables[scopeId]);
        let i = 0;
        while (i < this.iteratorVarNames.length && existingSymbolNames.indexOf(this.iteratorVarNames[i]) > -1)
            i++;
        let iteratorVarName;
        if (i == this.iteratorVarNames.length) {
            i = 2;
            while (existingSymbolNames.indexOf("i_" + i) > -1)
                i++;
            iteratorVarName = "i_" + i;
        }
        else
            iteratorVarName = this.iteratorVarNames[i];

        this.temporaryVariables[scopeId].push(iteratorVarName);
        return iteratorVarName;
    }

    public addNewTemporaryVariable(scopeNode: ts.Node, proposedName: string): string {
        let parentFunc = this.findParentFunction(scopeNode);
        let scopeId = parentFunc && parentFunc.pos + 1 || 'main';
        let existingSymbolNames = this.typeChecker.getSymbolsInScope(scopeNode, ts.SymbolFlags.Variable).map(s => s.name);
        if (!this.temporaryVariables[scopeId])
            this.temporaryVariables[scopeId] = [];
        existingSymbolNames = existingSymbolNames.concat(this.temporaryVariables[scopeId]);
        if (existingSymbolNames.indexOf(proposedName) > -1) {
            let i = 2;
            while (existingSymbolNames.indexOf(proposedName + "_" + i) > -1)
                i++;
            proposedName = proposedName + "_" + i;
        }

        this.temporaryVariables[scopeId].push(proposedName);
        return proposedName;
    }

    private findParentFunction(node: ts.Node) {
        let parentFunc = node;
        while (parentFunc && parentFunc.kind != ts.SyntaxKind.FunctionDeclaration) {
            parentFunc = parentFunc.parent;
        }
        return parentFunc;
    }

    private findVariablesRecursively(node: ts.Node) {
        if (node.kind == ts.SyntaxKind.CallExpression) {
            let call = <ts.CallExpression>node;
            if (call.expression.kind == ts.SyntaxKind.Identifier) {
                let funcSymbol = this.typeChecker.getSymbolAtLocation(call.expression);
                if (funcSymbol != null) {
                    let funcDeclPos = funcSymbol.valueDeclaration.pos + 1;
                    if (funcDeclPos > call.pos)
                        this.functionPrototypes[funcDeclPos] = <ts.FunctionDeclaration>funcSymbol.valueDeclaration;
                    for (let i = 0; i < call.arguments.length; i++) {
                        let determinedType = this.determineType(null, call.arguments[i]);
                        let callData = this.functionCallsData[funcDeclPos] || [];
                        this.functionCallsData[funcDeclPos] = callData;
                        if (!callData[i] || callData[i] == UniversalVarType || callData[i] instanceof TypePromise)
                            callData[i] = determinedType;
                    }
                }
            }
        }
        else if (node.kind == ts.SyntaxKind.ReturnStatement) {
            let ret = <ts.ReturnStatement>node;
            let parentFunc = this.findParentFunction(node);
            let scopeId = parentFunc && parentFunc.pos + 1 || 'main';
            if (ret.expression)
            {
                let determinedType = this.determineType(null, ret.expression);
                if (determinedType == UniversalVarType || determinedType == PointerVarType)
                    determinedType = new TypePromise(ret.expression, false);
                let retData = this.functionReturnsData[scopeId];
                if (!retData || retData == UniversalVarType || retData instanceof TypePromise)
                    this.functionReturnsData[scopeId] = determinedType;
            } else {
                this.functionReturnsData[scopeId] = "void";
            }
        }
        else if (node.kind == ts.SyntaxKind.ArrayLiteralExpression) {
            if (!this.arrayLiteralsTypes[node.pos])
                this.determineArrayType(<ts.ArrayLiteralExpression>node);
        }
        else if (node.kind == ts.SyntaxKind.ObjectLiteralExpression) {
            if (!this.objectLiteralsTypes[node.pos]) {
                let type = this.generateStructure(this.typeChecker.getTypeAtLocation(node));
                this.objectLiteralsTypes[node.pos] = type;
            }
        }
        else if (node.kind == ts.SyntaxKind.Identifier) {
            let symbol = this.typeChecker.getSymbolAtLocation(node);
            if (symbol) {

                let varPos = symbol.valueDeclaration.pos;
                if (!this.variables[varPos]) {
                    this.variables[varPos] = new VariableInfo();
                    this.variablesData[varPos] = new VariableData();
                    this.variables[varPos].name = node.getText();
                    this.variables[varPos].declaration = <ts.VariableDeclaration>symbol.declarations[0];
                    this.variablesData[varPos].tsType = this.typeChecker.getTypeAtLocation(node);
                }
                let varInfo = this.variables[varPos];
                let varData = this.variablesData[varPos];
                varInfo.references.push(node);

                if (node.parent && node.parent.kind == ts.SyntaxKind.VariableDeclaration) {
                    let varDecl = <ts.VariableDeclaration>node.parent;
                    if (varDecl.name.getText() == node.getText()) {
                        this.addTypeToVariable(varPos, <ts.Identifier>varDecl.name, varDecl.initializer);
                        if (varDecl.initializer && varDecl.initializer.kind == ts.SyntaxKind.ObjectLiteralExpression)
                            varData.objLiteralAssigned = true;
                        if (varDecl.parent && varDecl.parent.parent && varDecl.parent.parent.kind == ts.SyntaxKind.ForOfStatement) {
                            let forOfStatement = <ts.ForOfStatement>varDecl.parent.parent;
                            if (forOfStatement.initializer.kind == ts.SyntaxKind.VariableDeclarationList) {
                                let forOfInitializer = <ts.VariableDeclarationList>forOfStatement.initializer;
                                if (forOfInitializer.declarations[0].pos == varDecl.pos) {
                                    varData.typePromises.push(new TypePromise(forOfStatement.expression, true));
                                }
                            }
                        }
                    }
                }
                else if (node.parent && node.parent.kind == ts.SyntaxKind.Parameter) {
                    let funcDecl = <ts.FunctionDeclaration>node.parent.parent;
                    for (let i = 0; i < funcDecl.parameters.length; i++) {
                        if (funcDecl.parameters[i].pos == node.pos) {
                            let param = funcDecl.parameters[i];
                            varData.parameterIndex = i;
                            varData.parameterFuncDeclPos = funcDecl.pos + 1;
                            this.addTypeToVariable(varPos, <ts.Identifier>node, param.initializer);
                            break;
                        }
                    }
                }
                else if (node.parent && node.parent.kind == ts.SyntaxKind.BinaryExpression) {
                    let binExpr = <ts.BinaryExpression>node.parent;
                    if (binExpr.left.kind == ts.SyntaxKind.Identifier
                        && binExpr.left.getText() == node.getText()
                        && binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken) {
                        this.addTypeToVariable(varPos, <ts.Identifier>binExpr.left, binExpr.right);
                        if (binExpr.right && binExpr.right.kind == ts.SyntaxKind.ObjectLiteralExpression)
                            varData.objLiteralAssigned = true;
                    }
                }
                else if (node.parent && node.parent.kind == ts.SyntaxKind.PropertyAccessExpression) {
                    let propAccess = <ts.PropertyAccessExpression>node.parent;
                    if (propAccess.expression.pos == node.pos && propAccess.parent.kind == ts.SyntaxKind.BinaryExpression) {
                        let binExpr = <ts.BinaryExpression>propAccess.parent;
                        if (binExpr.left.pos == propAccess.pos && binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken) {
                            let determinedType = this.determineType(<ts.Identifier>propAccess.name, binExpr.right);
                            if (!(determinedType instanceof TypePromise))
                                varData.addedProperties[propAccess.name.getText()] = determinedType;
                        }
                    }
                    if (propAccess.expression.kind == ts.SyntaxKind.Identifier && propAccess.name.getText() == "push") {
                        varData.isDynamicArray = true;
                        let determinedType: CType | TypePromise = UniversalVarType;
                        if (propAccess.parent && propAccess.parent.kind == ts.SyntaxKind.CallExpression) {
                            let call = <ts.CallExpression>propAccess.parent;
                            if (call.arguments.length == 1)
                                determinedType = this.determineType(<ts.Identifier>propAccess.expression, call.arguments[0]);
                        }
                        if (determinedType instanceof TypePromise) {
                            determinedType.arrayOf = true;
                            varData.typePromises.push(determinedType)
                        }
                        else {
                            if (determinedType instanceof ArrayType)
                                determinedType.isDynamicArray = true;

                            let dtString = typeof determinedType === 'string' ? determinedType : determinedType.getText();
                            let found = false;
                            for (let tk of Object.keys(varData.assignmentTypes)) {
                                let at = varData.assignmentTypes[tk];
                                if (at instanceof ArrayType) {
                                    let atElementType = at.elementType;
                                    let atElementTypeString = typeof atElementType === 'string' ? atElementType : atElementType.getText();
                                    if (atElementTypeString === dtString) {
                                        found = true;
                                        break;
                                    }
                                }
                            }

                            if (!found) {
                                let arrayOfType = new ArrayType(determinedType, 0, true);
                                varData.assignmentTypes[arrayOfType.getText()] = arrayOfType;
                            }
                        }
                    }
                    if (propAccess.expression.kind == ts.SyntaxKind.Identifier && propAccess.name.getText() == "pop") {
                        varData.isDynamicArray = true;
                    }
                }
                else if (node.parent && node.parent.kind == ts.SyntaxKind.ElementAccessExpression) {
                    let elemAccess = <ts.ElementAccessExpression>node.parent;
                    if (elemAccess.expression.pos == node.pos) {
                        let determinedType: CType | TypePromise = UniversalVarType;
                        if (elemAccess.parent && elemAccess.parent.kind == ts.SyntaxKind.BinaryExpression) {
                            let binExpr = <ts.BinaryExpression>elemAccess.parent;
                            if (binExpr.left.pos == elemAccess.pos && binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken) {
                                determinedType = this.determineType(<ts.Identifier>elemAccess.expression, binExpr.right);
                            }
                        }

                        if (elemAccess.argumentExpression.kind == ts.SyntaxKind.StringLiteral) {
                            let propName = elemAccess.argumentExpression.getText().slice(1, -1);
                            if (determinedType instanceof TypePromise) {
                                determinedType.associatedProperty = propName;
                                varData.typePromises.push(determinedType);
                            }
                            varData.addedProperties[propName] = varData.addedProperties[propName] || UniversalVarType;
                            if (!(determinedType instanceof TypePromise) && varData.addedProperties[propName] == UniversalVarType)
                                varData.addedProperties[propName] = determinedType;

                        }
                        else if (elemAccess.argumentExpression.kind == ts.SyntaxKind.NumericLiteral) {
                            if (determinedType instanceof TypePromise) {
                                determinedType.arrayOf = true;
                                varData.typePromises.push(determinedType);
                            }
                            else {
                                for (let atKey in varData.assignmentTypes) {
                                    let at = varData.assignmentTypes[atKey];
                                    if (at instanceof ArrayType && at.elementType == UniversalVarType)
                                        at.elementType = determinedType;
                                }
                            }
                        }
                        else {
                            varData.isDict = true;
                            if (determinedType instanceof TypePromise) {
                                determinedType.arrayOf = true;
                                varData.typePromises.push(determinedType);
                            }
                            else {
                                for (let atKey in varData.assignmentTypes) {
                                    let at = varData.assignmentTypes[atKey];
                                    if (at instanceof StructType) {
                                        delete varData.assignmentTypes[atKey];
                                        var dictType = new DictType(determinedType);
                                        varData.assignmentTypes[dictType.getText()] = dictType;
                                    }
                                }
                            }
                        }
                    }
                }
                else if (node.parent && node.parent.kind == ts.SyntaxKind.ForOfStatement) {
                    let forOfStatement = <ts.ForOfStatement>node.parent;
                    if (forOfStatement.initializer.kind == ts.SyntaxKind.Identifier && forOfStatement.initializer.pos == node.pos) {
                        varData.typePromises.push(new TypePromise(forOfStatement.expression, true));
                    }
                }
            }
        }
        node.getChildren().forEach(c => this.findVariablesRecursively(c));
    }


    private resolvePromisesAndFinalizeTypes() {

        let somePromisesAreResolved: boolean;

        do {

            somePromisesAreResolved = false;

            for (let k of Object.keys(this.variables).map(k => +k)) {

                let types = Object.keys(this.variablesData[k].assignmentTypes).filter(t => t != PointerVarType && t != UniversalVarType);
                if (types.length == 1) {
                    let varType = this.variablesData[k].assignmentTypes[types[0]];
                    if (varType instanceof ArrayType) {
                        varType.isDynamicArray = varType.isDynamicArray || this.variablesData[k].isDynamicArray;
                        if (this.variablesData[k].isDynamicArray)
                            this.variables[k].requiresAllocation = true;
                    } else if (varType instanceof StructType && this.variablesData[k].objLiteralAssigned) {
                        this.variables[k].requiresAllocation = true;
                    } else if (varType instanceof DictType) {
                        this.variables[k].requiresAllocation = true;
                    }
                    if (varType instanceof StructType) {
                        for (let addPropKey in this.variablesData[k].addedProperties) {
                            let addPropType = this.variablesData[k].addedProperties[addPropKey];
                            if (!(addPropType instanceof TypePromise))
                                varType.properties[addPropKey] = addPropType;
                        }
                    }
                    this.variables[k].type = varType;
                }
                else if (types.length == 0) {
                    this.variables[k].type = PointerVarType;
                }
                else {
                    this.variables[k].requiresAllocation = true;
                    this.variables[k].type = UniversalVarType;
                }

                somePromisesAreResolved = somePromisesAreResolved || this.tryResolvePromises(k);

            }

        } while (somePromisesAreResolved);

    }

    private tryResolvePromises(varPos: number) {
        let somePromisesAreResolved = false;

        let funcDeclPos = this.variablesData[varPos].parameterFuncDeclPos;
        if (funcDeclPos && this.functionCallsData[funcDeclPos]) {
            let paramIndex = this.variablesData[varPos].parameterIndex;
            let type = this.functionCallsData[funcDeclPos][paramIndex];
            let finalType = !(type instanceof TypePromise) && type;

            if (type instanceof TypePromise) {
                finalType = this.getCType(type.associatedNode) || finalType;
                if (finalType)
                    type.resolved = true;
            }

            if (finalType && !this.variablesData[varPos].assignmentTypes[this.getTypeString(finalType)]) {
                somePromisesAreResolved = true;
                this.variablesData[varPos].assignmentTypes[this.getTypeString(finalType)] = finalType;
            }
        }

        for (let funcDeclPos in this.functionReturnsData) {
            let type = this.functionReturnsData[funcDeclPos];
            let finalType = !(type instanceof TypePromise) && type;

            if (type instanceof TypePromise) {
                finalType = this.getCType(type.associatedNode) || finalType;
                if (finalType)
                    type.resolved = true;
            }

            if (!this.functionReturnTypes[funcDeclPos])
                this.functionReturnTypes[funcDeclPos] = PointerVarType; 
            
            if (finalType && finalType != PointerVarType && this.functionReturnTypes[funcDeclPos] == PointerVarType) {
                this.functionReturnTypes[funcDeclPos] = finalType;
                somePromisesAreResolved = true;
            }
        }

        if (this.variablesData[varPos].typePromises.length > 0) {
            let promises = this.variablesData[varPos].typePromises.filter(p => !p.resolved);
            for (let promise of promises) {
                let resolvedType = this.getCType(promise.associatedNode);
                if (resolvedType != null) {
                    let finalType = resolvedType;
                    promise.resolved = true;
                    somePromisesAreResolved = true;
                    if (promise.arrayOf)
                        finalType = new ArrayType(resolvedType, 0, true);
                    else if (resolvedType instanceof StructType && promise.element) {
                        let propName = promise.element;
                        if (typeof propName === 'string') {
                            finalType = resolvedType.properties[propName];
                        }
                    }
                    else if (resolvedType instanceof ArrayType && promise.element) {
                        finalType = resolvedType.elementType;
                    }

                    if (promise.associatedProperty) {
                        this.variablesData[varPos].addedProperties[promise.associatedProperty] = finalType;
                    }
                    else {
                        if (typeof finalType === 'string')
                            this.variablesData[varPos].assignmentTypes[finalType] = finalType;
                        else
                            this.variablesData[varPos].assignmentTypes[finalType.getText()] = finalType;
                    }

                }
            }
        }

        return somePromisesAreResolved;

    }

    private addTypeToVariable(varPos: number, left: ts.Identifier, right: ts.Node) {
        let determinedType = this.determineType(left, right);
        if (determinedType instanceof TypePromise)
            this.variablesData[varPos].typePromises.push(determinedType);
        else
            this.variablesData[varPos].assignmentTypes[this.getTypeString(determinedType)] = determinedType;

    }

    private determineType(left: ts.Identifier, right: ts.Node): CType | TypePromise {
        let tsType = right ? this.typeChecker.getTypeAtLocation(right) : this.typeChecker.getTypeAtLocation(left);
        if (right && right.kind == ts.SyntaxKind.ObjectLiteralExpression) {
            let type = this.generateStructure(tsType, left);
            this.objectLiteralsTypes[right.pos] = type;
            return type;
        }
        else if (right && right.kind == ts.SyntaxKind.ArrayLiteralExpression)
            return this.determineArrayType(<ts.ArrayLiteralExpression>right);
        else {
            let type = this.convertType(tsType, left);
            if ((type == PointerVarType || type == UniversalVarType) && right && 
                (right.kind == ts.SyntaxKind.PropertyAccessExpression
                || right.kind == ts.SyntaxKind.ElementAccessExpression
                || right.kind == ts.SyntaxKind.Identifier
                || right.kind == ts.SyntaxKind.CallExpression)) {
                return new TypePromise(right, false);
            }
            else
                return type;
        }
    }

    private generateStructure(tsType: ts.Type, ident?: ts.Identifier): StructType {
        var structName = "struct_" + Object.keys(this.userStructs).length + "_t";
        var varName = ident && ident.getText();
        if (varName) {
            if (this.userStructs[varName + "_t"] == null)
                structName = varName + "_t";
            else {
                let i = 2;
                while (this.userStructs[varName + "_" + i + "_t"] != null)
                    i++;
                structName = varName + "_" + i + "_t";
            }
        }
        let userStructInfo: PropertiesDictionary = {};
        for (let prop of tsType.getProperties()) {
            let propTsType = this.typeChecker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration);
            let propType = this.convertType(propTsType, <ts.Identifier>prop.valueDeclaration.name);
            if (propType == UniversalVarType && prop.valueDeclaration.kind == ts.SyntaxKind.PropertyAssignment) {
                let propAssignment = <ts.PropertyAssignment>prop.valueDeclaration;
                if (propAssignment.initializer && propAssignment.initializer.kind == ts.SyntaxKind.ArrayLiteralExpression)
                    propType = this.determineArrayType(<ts.ArrayLiteralExpression>propAssignment.initializer);
            }
            userStructInfo[prop.name] = propType;
        }

        let userStructCode = this.getStructureBodyString(userStructInfo);

        var found = false;
        if (Object.keys(userStructInfo).length > 0) {
            for (var s in this.userStructs) {
                if (this.getStructureBodyString(this.userStructs[s].properties) == userStructCode) {
                    structName = s;
                    found = true;
                    break;
                }
            }
        }

        if (!found)
            this.userStructs[structName] = new StructType('struct ' + structName + ' *', userStructInfo);
        return this.userStructs[structName];
    }

    private getStructureBodyString(properties: PropertiesDictionary) {
        let userStructCode = '{\n';
        for (let propName in properties) {
            let propType = properties[propName];
            if (typeof propType === 'string') {
                userStructCode += '    ' + propType + ' ' + propName + ';\n';
            } else if (propType instanceof ArrayType) {
                let propTypeText = propType.getText();
                if (propTypeText.indexOf("{var}") > -1)
                    userStructCode += '    ' + propTypeText.replace(/^static /, '').replace("{var}", propName) + ';\n';
                else
                    userStructCode += '    ' + propTypeText + ' ' + propName + ';\n';
            } else {
                userStructCode += '    ' + propType.getText() + ' ' + propName + ';\n';
            }
        }
        userStructCode += "};\n"
        return userStructCode;
    }

    private determineArrayType(arrLiteral: ts.ArrayLiteralExpression): ArrayType | string {
        var elementType;
        if (arrLiteral.elements.length > 0)
            elementType = this.convertType(this.typeChecker.getTypeAtLocation(arrLiteral.elements[0]));
        else
            return UniversalVarType;

        let cap = arrLiteral.elements.length;
        let type = new ArrayType(elementType, cap, false);
        this.arrayLiteralsTypes[arrLiteral.pos] = type;
        return type;
    }

}