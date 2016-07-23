import * as ts from 'typescript';
import {CodeTemplate} from '../template';
import {CType, ArrayType, StructType, VariableInfo} from '../types';
import {IScope} from '../program';
import {CExpression, ExpressionProcessor} from './expressions';
import {CVariable} from './variable';

export class PrintfHelper {
    public static createPrintf(scope: IScope, printNode: ts.Expression) {
        let varInfo = scope.root.typeHelper.getVariableInfo(printNode);
        let nodeExpression = ExpressionProcessor.get(scope, printNode);
        let accessor = nodeExpression["resolve"] ? nodeExpression["resolve"]() : nodeExpression;
        let options = {
            isDynamicArray: varInfo && varInfo.isDynamicArray,
            isDict: varInfo && varInfo.isDict,
            emitCR: true
        }
        let type = varInfo && varInfo.type || scope.root.typeHelper.convertType(scope.root.typeChecker.getTypeAtLocation(printNode));
        return new CPrintf(scope, printNode, accessor, type, options);
    }
}

interface PrintfOptions
{
    emitCR?: boolean;
    isDynamicArray?: boolean;
    isDict?: boolean;
    quotedString?: boolean;
    propName?: string; 
}

@CodeTemplate(`
{#if isQuotedCString}
    printf("{propPrefix}\\"%s\\"{CR}", {accessor});
{/if}
{#if isCString}
    printf("%s{CR}", {accessor});
{/if}
{#if isInteger}
    printf("{propPrefix}%d{CR}", {accessor});
{/if}
{#if isBoolean && !propPrefix}
    printf({accessor} ? "true{CR}" : "false{CR}");
{/if}
{#if isBoolean && propPrefix}
    printf("{propPrefix}%s", {accessor} ? "true{CR}" : "false{CR}");
{/if}
{#if isStruct}
    printf("{propPrefix}{ ");
    {elementPrintfs {    printf(", ");\n    }=> {this}}
    printf(" }{CR}");
{/if}
{#if isArray}
    printf("{propPrefix}[ ");
    for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++) {
        if ({iteratorVarName} != 0)
            printf(", ");
        {elementPrintfs}
    }
    printf(" ]{CR}");
{/if}`)
class CPrintf {

    public isQuotedCString: boolean = false;
    public isCString: boolean = false;
    public isInteger: boolean = false;
    public isBoolean: boolean = false;
    public isStruct: boolean = false;
    public isArray: boolean = false;

    public iteratorVarName: string;
    public arraySize: string;
    public elementPrintfs: CPrintf[] = [];
    public propPrefix: string = '';
    public CR: string = '';

    constructor(scope: IScope, printNode: ts.Node, public accessor: string, varType: CType, options: PrintfOptions) {
        this.isQuotedCString = varType == 'char *' && options.quotedString;
        this.isCString = varType == 'char *' && !options.quotedString;
        this.isInteger = varType == 'int16_t';
        this.isBoolean = varType == 'uint8_t';

        if (options.emitCR)
            this.CR = "\\n";

        if (options.propName)
            this.propPrefix = options.propName + ": ";

        if (varType instanceof ArrayType) {
            this.isArray = true;
            this.iteratorVarName = scope.root.typeHelper.addNewIteratorVariable(printNode);
            scope.variables.push(new CVariable(scope, this.iteratorVarName, "int16_t"));
            scope.root.headerFlags.int16_t = true;
            this.arraySize = options.isDynamicArray ? accessor + ".size" : varType.capacity + "";
            let elementAccessor = accessor + (options.isDynamicArray ? ".data" : "") + "[" + this.iteratorVarName + "]";
            this.elementPrintfs = [new CPrintf(scope, printNode, elementAccessor, varType.elementType, { quotedString: true })];
        }
        else if (varType instanceof StructType) {
            this.isStruct = true;
            for (let k in varType.properties) {
                let propAccessor = options.isDict ? "DICT_GET(" + accessor + ", \"" + k + "\")" : accessor + "->" + k;
                this.elementPrintfs.push(new CPrintf(scope, printNode, propAccessor, varType.properties[k], { quotedString: true, propName: k }));
            }
        }
    }
}
