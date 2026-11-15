import { relative, resolve } from "node:path";
import ts from "typescript";
import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import type {
  BinOp, ClassDecl, DispatchTarget, Expr, FieldDecl, FunctionDecl, Hat, IrType, ListDecl, ListOp,
  Module, RoleRef, Script, Stmt, VarDecl,
} from "@typescratch/ir";
import { MATH_INTRINSICS } from "@typescratch/language";

const HAT_NAMES: ReadonlySet<string> = new Set([
  "onFlag", "onKey", "onSpriteClicked", "onClone", "onBackdrop", "onBroadcast", "onGreaterThan",
]);

const HAT_HANDLER_INDEX: Readonly<Record<string, number>> = {
  onFlag: 0,
  onSpriteClicked: 0,
  onClone: 0,
  onKey: 1,
  onBackdrop: 1,
  onBroadcast: 1,
  onGreaterThan: 2,
};

export interface FrontendConfig {
  entry: string;
  projectRoot: string;
  runtimeDts: string;
  bag: DiagnosticBag;
  role?: RoleRef;
}

export interface TypedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  source: ts.SourceFile;
}

const BIN_OP_MAP: Partial<Record<ts.SyntaxKind, BinOp>> = {
  [ts.SyntaxKind.PlusToken]: "add",
  [ts.SyntaxKind.MinusToken]: "sub",
  [ts.SyntaxKind.AsteriskToken]: "mul",
  [ts.SyntaxKind.SlashToken]: "div",
  [ts.SyntaxKind.PercentToken]: "mod",
  [ts.SyntaxKind.LessThanToken]: "lt",
  [ts.SyntaxKind.GreaterThanToken]: "gt",
  [ts.SyntaxKind.LessThanEqualsToken]: "le",
  [ts.SyntaxKind.GreaterThanEqualsToken]: "ge",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "eq",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "ne",
  [ts.SyntaxKind.EqualsEqualsToken]: "eq",
  [ts.SyntaxKind.ExclamationEqualsToken]: "ne",
};

const COMPOUND_ASSIGNMENTS: Partial<Record<ts.SyntaxKind, BinOp>> = {
  [ts.SyntaxKind.EqualsToken]: "add",
  [ts.SyntaxKind.PlusEqualsToken]: "add",
  [ts.SyntaxKind.MinusEqualsToken]: "sub",
  [ts.SyntaxKind.AsteriskEqualsToken]: "mul",
  [ts.SyntaxKind.SlashEqualsToken]: "div",
  [ts.SyntaxKind.PercentEqualsToken]: "mod",
};

const LIST_COMMANDS: ReadonlySet<string> = new Set([
  "push", "insert", "replace", "deleteAt", "clear",
]);

function diagnosticSpan(diagnostic: ts.Diagnostic, root: string): SourceSpan | undefined {
  if (!diagnostic.file || diagnostic.start === undefined) return undefined;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    file: relative(root, diagnostic.file.fileName),
    start: diagnostic.start,
    end: diagnostic.start + (diagnostic.length ?? 0),
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function createTypedProgram(config: FrontendConfig): TypedProgram | undefined {
  const entry = resolve(config.projectRoot, config.entry);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    paths: { "@typescratch/runtime": [resolve(config.runtimeDts)] },
    types: [],
  };
  const program = ts.createProgram([entry], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      config.bag.error(
        CODES.TS_TYPE,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        diagnosticSpan(diagnostic, config.projectRoot),
      );
    }
    return undefined;
  }
  const source = program.getSourceFile(entry);
  if (!source) {
    config.bag.error(CODES.TS_TYPE, `entry file not found: ${config.entry}`);
    return undefined;
  }
  return { program, checker: program.getTypeChecker(), source };
}

class Lowerer {
  private readonly checker: ts.TypeChecker;
  private readonly source: ts.SourceFile;
  private readonly root: string;
  private readonly runtimeDts: string;
  private readonly bag: DiagnosticBag;
  private readonly roleName: string;
  private readonly vars: VarDecl[] = [];
  private readonly lists: ListDecl[] = [];
  private readonly scripts: Script[] = [];
  private readonly functions: FunctionDecl[] = [];
  private readonly functionSymbols = new Map<ts.Symbol, FunctionDecl>();
  private readonly functionNodes = new Map<ts.FunctionDeclaration, FunctionDecl>();
  private readonly callEdges = new Map<string, Set<string>>();
  private readonly symbolVars = new Map<ts.Symbol, VarDecl>();
  private currentFunction: FunctionDecl | undefined;
  private functionCounter = 0;
  private readonly handleVars = new Map<ts.Symbol, VarDecl>();
  private readonly handleLists = new Map<ts.Symbol, ListDecl>();
  private readonly classes: ClassDecl[] = [];
  private readonly classByName = new Map<string, ClassDecl>();
  private readonly methodNodes = new Map<ts.MethodDeclaration, FunctionDecl>();
  private readonly arrayVars = new Map<ts.Symbol, { type: IrType }>();
  private currentThisVar: VarDecl | undefined;
  private classCounter = 0;
  private readonly compileTime = new Map<ts.Symbol, string | number | boolean>();
  private current: Stmt[] = [];
  private counter = 0;
  private listCounter = 0;
  private scriptIndex = -1;
  private loopDepth = 0;
  private forLoopDepth = 0;
  private warnedModulo = false;
  private warnedLooseEquality = false;

  constructor(typed: TypedProgram, config: FrontendConfig) {
    this.checker = typed.checker;
    this.source = typed.source;
    this.root = config.projectRoot;
    this.runtimeDts = resolve(config.runtimeDts);
    this.roleName = config.role?.name ?? "Sprite1";
    this.bag = config.bag;
  }

  lower(): Module {
    for (const statement of this.source.statements) {
      if (ts.isFunctionDeclaration(statement)) this.declareFunction(statement);
      if (ts.isClassDeclaration(statement)) this.declareClass(statement);
    }
    for (const statement of this.source.statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          this.lowerVariableDeclaration(declaration, statement.declarationList.flags, true);
        }
        continue;
      }
      if (ts.isExpressionStatement(statement) && this.lowerHatStatement(statement)) continue;
      this.unsupported(statement, "top-level statements may only declare resources, classes or register event hats");
    }
    for (const [node, fn] of this.functionNodes) this.lowerFunction(node, fn);
    for (const [node, fn] of this.methodNodes) this.lowerMethod(node, fn);
    const module: Module = {
      entry: relative(this.root, this.source.fileName),
      scripts: this.scripts,
      vars: this.vars,
      lists: this.lists,
    };
    if (this.functions.length > 0) module.functions = this.functions;
    if (this.classes.length > 0) module.classes = this.classes;
    return module;
  }

  private declareClass(node: ts.ClassDeclaration): void {
    const name = node.name?.text ?? `Anonymous${++this.classCounter}`;
    const fields: FieldDecl[] = [];
    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const type = member.type
        ? this.irTypeOf(this.checker.getTypeFromTypeNode(member.type))
        : "number";
      if (type !== "number" && type !== "string") {
        this.unsupported(member, `field ${member.name.text} must be number or string in v0.2`);
        continue;
      }
      const field: FieldDecl = { name: member.name.text, type };
      const initial = member.initializer ? this.literalValue(member.initializer) : undefined;
      if (initial !== undefined) field.initial = initial;
      fields.push(field);
    }
    const cls: ClassDecl = { id: name, name, fields, methodIds: [], span: this.span(node) };
    this.classes.push(cls);
    this.classByName.set(name, cls);
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const fn = this.declareMethod(member, cls);
      cls.methodIds.push(fn.id);
      this.methodNodes.set(member, fn);
    }
  }

  private declareMethod(node: ts.MethodDeclaration, cls: ClassDecl): FunctionDecl {
    const name = ts.isIdentifier(node.name) ? node.name.text : `anonymous${++this.functionCounter}`;
    const id = `fn_${cls.name}_${name}_${++this.functionCounter}`;
    const returnType = node.type
      ? this.irTypeOf(this.checker.getTypeFromTypeNode(node.type))
      : "number";
    const span = this.span(node);
    const callId = this.newVar(`${name}_callId`, "number", "temp", span, 0);
    const returnValue = this.newVar(`${name}_ret`, returnType, "temp", span, 0);
    const returning = this.newVar(`${name}_returning`, "number", "temp", span, 0);
    const thisDecl = this.newVar("this", "number", "temp", span, 0);
    thisDecl.parameter = true;
    const params: VarDecl[] = [thisDecl];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        this.unsupported(parameter, "destructured method parameters are not supported");
        continue;
      }
      const type = this.typeOf(parameter.name);
      if (type !== "number" && type !== "string" && type !== "boolean") {
        this.unsupported(parameter, `method parameter ${parameter.name.text} must be number, string or boolean`);
        continue;
      }
      const decl = this.newVar(parameter.name.text, type, "temp", this.span(parameter), 0);
      decl.parameter = true;
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      if (symbol) this.symbolVars.set(symbol, decl);
      params.push(decl);
    }
    const fn: FunctionDecl = {
      id, name, params, returnType, body: [],
      callId: callId.id, returnValue: returnValue.id, returning: returning.id,
      thisVar: thisDecl.id, classId: cls.id, span,
    };
    this.functions.push(fn);
    this.callEdges.set(id, new Set());
    return fn;
  }

  private lowerMethod(node: ts.MethodDeclaration, fn: FunctionDecl): void {
    this.currentFunction = fn;
    this.currentThisVar = fn.thisVar
      ? this.vars.find((decl) => decl.id === fn.thisVar)
      : undefined;
    this.scriptIndex = -1;
    fn.body = this.withBlock(() => {
      if (node.body) this.lowerStatement(node.body);
    });
    this.currentFunction = undefined;
    this.currentThisVar = undefined;
    this.scriptIndex = -1;
  }

  private dispatchTargets(method: string): DispatchTarget[] {
    const targets: DispatchTarget[] = [];
    for (const cls of this.classes) {
      for (const id of cls.methodIds) {
        const fn = this.functions.find((item) => item.id === id);
        if (fn?.name === method) targets.push({ classId: cls.id, function: fn.id });
      }
    }
    return targets;
  }

  private objectClassOf(node: ts.Expression): string | undefined {
    if (node.kind === ts.SyntaxKind.ThisKeyword) return this.currentFunction?.classId;
    const type = this.checker.getTypeAtLocation(node);
    const name = (type.getSymbol() ?? type.aliasSymbol)?.getName();
    return name && this.classByName.has(name) ? name : undefined;
  }

  private fieldType(field: string, classHint?: string): IrType {
    const known = classHint ? this.classByName.get(classHint) : undefined;
    for (const cls of known ? [known] : this.classes) {
      const found = cls.fields.find((item) => item.name === field);
      if (found) return found.type;
    }
    return "number";
  }

  private methodReturnType(functionId: string): IrType {
    return this.functions.find((fn) => fn.id === functionId)?.returnType ?? "number";
  }

  private lowerArrayCall(node: ts.CallExpression): Expr | undefined {
    if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(node.expression.expression);
    const array = symbol ? this.arrayVars.get(symbol) : undefined;
    if (!array) return undefined;
    const method = node.expression.name.text;
    const object = this.lowerExpr(node.expression.expression);
    if (method === "get" && node.arguments[0]) {
      return {
        k: "arrayRead",
        array: object,
        index: this.lowerExpr(node.arguments[0]),
        type: array.type,
        span: this.span(node),
      };
    }
    if (method === "length") {
      return { k: "arrayLength", array: object, type: "number", span: this.span(node) };
    }
    if (method === "set" && node.arguments[0] && node.arguments[1]) {
      this.emit({
        k: "arrayWrite",
        array: object,
        index: this.lowerExpr(node.arguments[0]),
        value: this.lowerExpr(node.arguments[1]),
        span: this.span(node),
      });
      return this.voidConst(node);
    }
    this.unsupported(node, `unsupported array method ${method}`);
    return this.voidConst(node);
  }

  private declareFunction(node: ts.FunctionDeclaration): void {
    const name = node.name?.text ?? `anonymous${++this.functionCounter}`;
    const id = `fn_${name}_${++this.functionCounter}`;
    const returnType = node.type ? this.irTypeOf(this.checker.getTypeFromTypeNode(node.type)) : "number";
    const span = this.span(node);
    const callId = this.newVar(`${name}_callId`, "number", "temp", span, 0);
    const returnValue = this.newVar(`${name}_ret`, returnType, "temp", span, 0);
    const returning = this.newVar(`${name}_returning`, "number", "temp", span, 0);
    const params: VarDecl[] = [];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        this.unsupported(parameter, "destructured function parameters are not supported");
        continue;
      }
      const type = this.typeOf(parameter.name);
      if (type !== "number" && type !== "string" && type !== "boolean") {
        this.unsupported(parameter, `function parameter ${parameter.name.text} must be number, string or boolean in v0.1`);
        continue;
      }
      const decl = this.newVar(parameter.name.text, type, "temp", this.span(parameter), 0);
      decl.parameter = true;
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      if (symbol) this.symbolVars.set(symbol, decl);
      params.push(decl);
    }
    const fn: FunctionDecl = {
      id, name, params, returnType, body: [],
      callId: callId.id, returnValue: returnValue.id, returning: returning.id, span,
    };
    this.functions.push(fn);
    this.functionNodes.set(node, fn);
    this.callEdges.set(id, new Set());
    const symbol = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    if (symbol) this.functionSymbols.set(symbol, fn);
  }

  private lowerFunction(node: ts.FunctionDeclaration, fn: FunctionDecl): void {
    this.currentFunction = fn;
    this.scriptIndex = -1;
    fn.body = this.withBlock(() => {
      if (node.body) this.lowerStatement(node.body);
    });
    this.currentFunction = undefined;
    this.scriptIndex = -1;
  }

  private lowerHatStatement(statement: ts.ExpressionStatement): boolean {
    const call = statement.expression;
    if (!ts.isCallExpression(call)) return false;
    const name = this.runtimeNameOf(call);
    if (!name || !HAT_NAMES.has(name)) return false;
    const handlerIndex = HAT_HANDLER_INDEX[name] ?? 0;
    const handler = call.arguments[handlerIndex];
    if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) {
      this.unsupported(statement, `${name}() expects a handler arrow function`);
      return true;
    }
    const argument = handlerIndex > 0 ? call.arguments[0] : undefined;
    if (handlerIndex > 0 && (!argument || !ts.isStringLiteral(argument))) {
      this.unsupported(statement, `${name}() expects a string literal argument`);
      return true;
    }
    const text = argument && ts.isStringLiteral(argument) ? argument.text : "";
    let hat: Hat;
    if (name === "onGreaterThan") {
      const sensor = call.arguments[0];
      const threshold = call.arguments[1] ? this.literalValue(call.arguments[1]) : undefined;
      if (!sensor || !ts.isStringLiteral(sensor)
        || (sensor.text !== "timer" && sensor.text !== "loudness")) {
        this.unsupported(statement, "onGreaterThan() expects 'timer' or 'loudness' as its sensor");
        return true;
      }
      if (typeof threshold !== "number") {
        this.unsupported(statement, "onGreaterThan() expects a numeric literal threshold");
        return true;
      }
      hat = { kind: "greaterThan", sensor: sensor.text, value: threshold };
    } else {
      switch (name) {
        case "onFlag": hat = { kind: "flag" }; break;
        case "onKey": hat = { kind: "key", key: text }; break;
        case "onSpriteClicked": hat = { kind: "spriteClicked" }; break;
        case "onClone": hat = { kind: "clone" }; break;
        case "onBackdrop": hat = { kind: "backdrop", name: text }; break;
        case "onBroadcast": hat = { kind: "broadcast", name: text }; break;
        default: return false;
      }
    }
    this.scriptIndex = this.scripts.length;
    const body = this.withBlock(() => {
      if (ts.isBlock(handler.body)) this.lowerStatement(handler.body);
      else this.lowerExpr(handler.body);
    });
    this.scripts.push({ hat, body, span: this.span(statement) });
    return true;
  }

  private span(node: ts.Node): SourceSpan {
    const start = node.getStart(this.source);
    const position = this.source.getLineAndCharacterOfPosition(start);
    return {
      file: relative(this.root, this.source.fileName),
      start,
      end: node.getEnd(),
      line: position.line + 1,
      column: position.character + 1,
    };
  }

  private unsupported(node: ts.Node, message: string): void {
    this.bag.error(CODES.UNSUPPORTED, message, this.span(node), [
      "TypeScratch v0.1 supports a restricted TypeScript subset; see LANGUAGE-SUBSET.",
    ]);
  }

  private unknown(node: ts.Node, message: string): void {
    this.bag.error(CODES.UNKNOWN_API, message, this.span(node));
  }

  private voidConst(node: ts.Node): Expr {
    return { k: "const", value: 0, type: "void", span: this.span(node) };
  }

  private withBlock(visit: () => void): Stmt[] {
    const saved = this.current;
    const list: Stmt[] = [];
    this.current = list;
    visit();
    this.current = saved;
    return list;
  }

  private emit(stmt: Stmt): void {
    this.current.push(stmt);
  }

  private newVar(name: string, type: IrType, storage: VarDecl["storage"], span: SourceSpan, initial?: string | number | boolean): VarDecl {
    const index = Math.max(this.scriptIndex, 0);
    const id = `v${storage === "temp" ? `s${index}` : "g"}_${++this.counter}`;
    const decl: VarDecl = {
      id,
      name: storage === "temp" ? `_tscr_s${index}_${name}` : name,
      type,
      storage,
      span,
    };
    if (storage === "temp") decl.script = index;
    if (initial !== undefined) decl.initial = initial;
    this.vars.push(decl);
    return decl;
  }

  private newList(name: string, type: IrType, span: SourceSpan): ListDecl {
    const decl: ListDecl = {
      id: `l${this.roleName}_${++this.listCounter}`,
      name,
      type,
      span,
    };
    this.lists.push(decl);
    return decl;
  }

  private irTypeOf(type: ts.Type): IrType {
    if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.TemplateLiteral)) return "string";
    if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) return "number";
    if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
    return "void";
  }

  private typeOf(node: ts.Node): IrType {
    return this.irTypeOf(this.checker.getTypeAtLocation(node));
  }

  private runtimeNameOf(call: ts.CallExpression): string | undefined {
    const symbol = this.checker.getSymbolAtLocation(call.expression);
    if (!symbol) return undefined;
    const declarations = symbol.getDeclarations() ?? [];
    const fromRuntime = declarations.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === this.runtimeDts,
    );
    return fromRuntime ? symbol.getName() : undefined;
  }

  private mathNameOf(call: ts.CallExpression): string | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "Math") return undefined;
    const symbol = this.checker.getSymbolAtLocation(expression);
    const declarations = symbol?.getDeclarations() ?? [];
    const fromLib = declarations.some((declaration) =>
      /[\\/]lib\.[^\\/]*\.d\.ts$/.test(declaration.getSourceFile().fileName),
    );
    return fromLib ? expression.name.text : undefined;
  }

  private stringMethodOf(call: ts.CallExpression): string | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const method = expression.name.text;
    if (method !== "toUpperCase" && method !== "toLowerCase") return undefined;
    if (this.typeOf(expression.expression) !== "string") return undefined;
    const symbol = this.checker.getSymbolAtLocation(expression);
    const declarations = symbol?.getDeclarations() ?? [];
    const fromLib = declarations.some((declaration) =>
      /[\\/]lib\.[^\\/]*\.d\.ts$/.test(declaration.getSourceFile().fileName),
    );
    return fromLib ? `ext.String.${method}` : undefined;
  }

  private handleOf(call: ts.CallExpression): VarDecl | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(expression.expression);
    return symbol ? this.handleVars.get(symbol) : undefined;
  }

  private listOf(call: ts.CallExpression): ListDecl | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(expression.expression);
    return symbol ? this.handleLists.get(symbol) : undefined;
  }

  private varFor(identifier: ts.Identifier): VarDecl | undefined {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    const decl = symbol ? this.symbolVars.get(symbol) : undefined;
    if (!decl) this.unsupported(identifier, `unresolved variable ${identifier.text}`);
    return decl;
  }

  private literalValue(node: ts.Expression): string | number | boolean | undefined {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
      return -Number(node.operand.text);
    }
    return undefined;
  }

  private negativeLiteral(node: ts.Expression): boolean {
    return ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken
      && (ts.isNumericLiteral(node.operand) || this.negativeLiteral(node.operand));
  }

  private readInitial(argument: ts.Expression | undefined): string | number | boolean | undefined {
    if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
    for (const property of argument.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "initial") {
        return this.literalValue(property.initializer);
      }
    }
    return undefined;
  }

  private lowerVariableDeclaration(
    declaration: ts.VariableDeclaration,
    flags: ts.NodeFlags,
    topLevel: boolean,
  ): void {
    if (!ts.isIdentifier(declaration.name)) {
      this.unsupported(declaration, "destructuring declarations are not supported");
      return;
    }
    const symbol = this.checker.getSymbolAtLocation(declaration.name);
    const initializer = declaration.initializer;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;

    if (initializer && ts.isCallExpression(initializer)) {
      const runtimeName = this.runtimeNameOf(initializer);
      if (runtimeName === "global" || runtimeName === "local" || runtimeName === "list") {
        const nameArgument = initializer.arguments[0];
        if (!nameArgument || !ts.isStringLiteral(nameArgument)) {
          this.unsupported(initializer, `${runtimeName}() requires a string literal name`);
          return;
        }
        const handleType = this.checker.getTypeAtLocation(initializer) as ts.TypeReference;
        const typeArguments = this.checker.getTypeArguments(handleType);
        const inner = typeArguments[0];
        const type = inner ? this.irTypeOf(inner) : "number";
        if (runtimeName === "list") {
          const list = this.newList(nameArgument.text, type, this.span(declaration));
          if (symbol) this.handleLists.set(symbol, list);
          return;
        }
        const decl = this.newVar(
          nameArgument.text,
          type,
          runtimeName === "global" ? "global" : "local",
          this.span(declaration),
          this.readInitial(initializer.arguments[1]),
        );
        if (symbol) this.handleVars.set(symbol, decl);
        return;
      }
      if (runtimeName === "array") {
        if (topLevel) {
          this.unsupported(initializer, "array() must be declared inside a script or function");
          return;
        }
        const sizeArg = initializer.arguments[0];
        if (!sizeArg || !ts.isNumericLiteral(sizeArg)) {
          this.unsupported(initializer, "array() size must be a numeric literal");
          return;
        }
        const handleType = this.checker.getTypeAtLocation(initializer) as ts.TypeReference;
        const inner = this.checker.getTypeArguments(handleType)[0];
        const type = inner ? this.irTypeOf(inner) : "number";
        const decl = this.newVar(declaration.name.text, "number", "temp", this.span(declaration), 0);
        decl.arraySize = Number(sizeArg.text);
        if (symbol) {
          this.arrayVars.set(symbol, { type });
          this.symbolVars.set(symbol, decl);
        }
        this.emit({
          k: "declare",
          var: decl.id,
          init: {
            k: "arrayNew",
            size: {
              k: "const", value: Number(sizeArg.text), type: "number", span: this.span(sizeArg),
            },
            type: "number",
            span: this.span(initializer),
          },
          span: this.span(declaration),
        });
        return;
      }
    }

    const literal = initializer ? this.literalValue(initializer) : undefined;
    if (isConst && literal !== undefined) {
      if (symbol) this.compileTime.set(symbol, literal);
      return;
    }

    if (topLevel) {
      this.unsupported(declaration, "top-level let/var declarations are not supported in v0.1");
      return;
    }

    const isObject = initializer && ts.isNewExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && this.classByName.has(initializer.expression.text);
    const decl = this.newVar(
      declaration.name.text,
      isObject ? "number" : this.typeOf(declaration.name),
      "temp",
      this.span(declaration),
    );
    if (isObject && initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
      decl.className = initializer.expression.text;
    }
    if (symbol) this.symbolVars.set(symbol, decl);
    this.emit({
      k: "declare",
      var: decl.id,
      init: initializer ? this.lowerExpr(initializer) : undefined,
      span: this.span(declaration),
    });
  }

  private lowerIncrement(node: ts.PostfixUnaryExpression | ts.PrefixUnaryExpression): Expr {
    const operand = node.operand;
    if (!ts.isIdentifier(operand)) {
      this.unsupported(node, "increment operators require a simple identifier");
      return this.voidConst(node);
    }
    const decl = this.varFor(operand);
    if (!decl) return this.voidConst(node);
    const delta = node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1;
    const current: Expr = { k: "read", var: decl.id, type: "number", span: this.span(node) };
    this.emit({
      k: "assign",
      var: decl.id,
      value: {
        k: "binary", op: "add", l: current,
        r: { k: "const", value: delta, type: "number" },
        type: "number", span: this.span(node),
      },
      span: this.span(node),
    });
    return this.voidConst(node);
  }

  private lowerLogical(node: ts.BinaryExpression, isAnd: boolean): Expr {
    if (this.typeOf(node.left) !== "boolean" || this.typeOf(node.right) !== "boolean") {
      this.unsupported(node, "short-circuit operators are restricted to boolean operands in v0.1");
      return { k: "const", value: false, type: "boolean", span: this.span(node) };
    }
    const span = this.span(node);
    const temp = this.newVar(`logic${this.counter + 1}`, "number", "temp", span, isAnd ? 0 : 1);
    this.emit({
      k: "declare", var: temp.id,
      init: { k: "const", value: isAnd ? 0 : 1, type: "number" },
      span,
    });
    const left = this.lowerExpr(node.left);
    const condition: Expr = isAnd
      ? left
      : { k: "unary", op: "not", value: left, type: "boolean", span };
    const body = this.withBlock(() => {
      const right = this.lowerExpr(node.right);
      this.emit({
        k: "assign",
        var: temp.id,
        value: { k: "convert", to: "number", value: right, type: "number", span },
        span,
      });
    });
    this.emit({ k: "if", cond: condition, then: body, span });
    return {
      k: "convert",
      to: "boolean",
      value: { k: "read", var: temp.id, type: "number", span },
      type: "boolean",
      span,
    };
  }

  private lowerExpr(node: ts.Expression): Expr {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return this.lowerExpr(node.expression);
    }
    if (ts.isPostfixUnaryExpression(node)) return this.lowerIncrement(node);
    if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        return this.lowerIncrement(node);
      }
      if (node.operator === ts.SyntaxKind.ExclamationToken) {
        return { k: "unary", op: "not", value: this.lowerExpr(node.operand), type: "boolean", span: this.span(node) };
      }
      if (node.operator === ts.SyntaxKind.MinusToken) {
        return { k: "unary", op: "neg", value: this.lowerExpr(node.operand), type: "number", span: this.span(node) };
      }
      this.unsupported(node, "unsupported unary operator");
      return this.voidConst(node);
    }
    if (ts.isNumericLiteral(node)) {
      return { k: "const", value: Number(node.text), type: "number", span: this.span(node) };
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { k: "const", value: node.text, type: "string", span: this.span(node) };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return {
        k: "const", value: node.kind === ts.SyntaxKind.TrueKeyword,
        type: "boolean", span: this.span(node),
      };
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (!this.currentThisVar) {
        this.unsupported(node, "this is only valid inside a class method");
        return this.voidConst(node);
      }
      return { k: "read", var: this.currentThisVar.id, type: "number", span: this.span(node) };
    }
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && this.classByName.has(node.expression.text)) {
        return { k: "objectNew", classId: node.expression.text, type: "number", span: this.span(node) };
      }
      this.unsupported(node, "new is only supported for TypeScratch class declarations");
      return this.voidConst(node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const classHint = this.objectClassOf(node.expression);
      if (classHint) {
        return {
          k: "fieldRead",
          object: this.lowerExpr(node.expression),
          field: node.name.text,
          type: this.fieldType(node.name.text, classHint),
          span: this.span(node),
        };
      }
      this.unsupported(node, `unsupported property access ${node.name.text}`);
      return this.voidConst(node);
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (symbol && this.compileTime.has(symbol)) {
        const value = this.compileTime.get(symbol)!;
        const type: IrType = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
        return { k: "const", value, type, span: this.span(node) };
      }
      const decl = symbol ? this.symbolVars.get(symbol) : undefined;
      if (decl) return { k: "read", var: decl.id, type: decl.type, span: this.span(node) };
      if (node.text === "NaN" || node.text === "Infinity") {
        this.bag.error(
          CODES.NUMERIC_PROFILE,
          `${node.text} has no stable representation in a Scratch variable`,
          this.span(node),
          [
            "Scratch casts NaN to 0 and does not preserve Infinity across variable reads.",
            "Use a finite sentinel value instead.",
          ],
        );
        return this.voidConst(node);
      }
      this.unsupported(node, `unresolved identifier ${node.text}`);
      return this.voidConst(node);
    }
    if (ts.isTemplateExpression(node)) {
      const parts: Expr[] = [
        { k: "const", value: node.head.text, type: "string", span: this.span(node.head) },
      ];
      for (const part of node.templateSpans) {
        parts.push(this.lowerExpr(part.expression));
        parts.push({ k: "const", value: part.literal.text, type: "string", span: this.span(part.literal) });
      }
      return { k: "join", parts, type: "string", span: this.span(node) };
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
        return this.lowerLogical(node, kind === ts.SyntaxKind.AmpersandAmpersandToken);
      }
      const op = BIN_OP_MAP[kind];
      if (!op) {
        this.unsupported(node, "unsupported binary operator");
        return this.voidConst(node);
      }
      const left = this.lowerExpr(node.left);
      const right = this.lowerExpr(node.right);
      if (kind === ts.SyntaxKind.PlusToken && (this.typeOf(node.left) === "string" || this.typeOf(node.right) === "string")) {
        return { k: "join", parts: [left, right], type: "string", span: this.span(node) };
      }
      if (op === "eq" || op === "ne") {
        if (left.type !== right.type && left.type !== "void" && right.type !== "void") {
          this.bag.warning(
            CODES.UNSAFE_SEMANTICS,
            "cross-type equality is lowered to Scratch's loose equality reporter",
            this.span(node),
            ["Use explicit conversions to keep TypeScript semantics."],
          );
        }
        if (!this.warnedLooseEquality && (kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken)) {
          this.warnedLooseEquality = true;
          this.bag.warning(CODES.UNSAFE_SEMANTICS, "== and != are lowered to Scratch equality, not JavaScript abstract equality", this.span(node));
        }
      }
      if (op === "mod") {
        if (this.negativeLiteral(node.left) || this.negativeLiteral(node.right)) {
          this.bag.error(
            CODES.NUMERIC_PROFILE,
            "% with a negative literal differs between JavaScript remainder and Scratch mod",
            this.span(node),
            ["Rewrite the expression so both operands are non-negative."],
          );
        } else if (!this.warnedModulo) {
          this.warnedModulo = true;
          this.bag.warning(
            CODES.UNSAFE_SEMANTICS,
            "JS remainder differs from Scratch mod for negative operands; v0.1 restricts % to non-negative integers",
            this.span(node),
          );
        }
      }
      const booleanOp = op === "lt" || op === "gt" || op === "le" || op === "ge" || op === "eq" || op === "ne";
      return {
        k: "binary", op, l: left, r: right,
        type: booleanOp ? "boolean" : this.typeOf(node),
        span: this.span(node),
      };
    }
    if (ts.isCallExpression(node)) {
      const arrayCall = this.lowerArrayCall(node);
      if (arrayCall) return arrayCall;
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const targets = this.dispatchTargets(method);
        const classHint = this.objectClassOf(node.expression.expression);
        if (targets.length > 0 && classHint) {
          return {
            k: "methodCall",
            object: this.lowerExpr(node.expression.expression),
            method,
            args: node.arguments.map((argument) => this.lowerExpr(argument)),
            targets,
            type: this.methodReturnType(targets[0]!.function),
            span: this.span(node),
          };
        }
      }
      const symbol = this.checker.getSymbolAtLocation(node.expression);
      const fn = symbol ? this.functionSymbols.get(symbol) : undefined;
      if (fn) {
        if (this.currentFunction) this.callEdges.get(this.currentFunction.id)?.add(fn.id);
        if (node.arguments.length !== fn.params.length) {
          this.unsupported(node, `${fn.name}() expects ${fn.params.length} argument(s)`);
          return this.voidConst(node);
        }
        return {
          k: "call", function: fn.id,
          args: node.arguments.map((argument) => this.lowerExpr(argument)),
          type: fn.returnType, span: this.span(node),
        };
      }
      const runtimeName = this.runtimeNameOf(node);
      if (runtimeName) {
        const list = this.listOf(node);
        if (list && (runtimeName === "length" || runtimeName === "item")) {
          const index = runtimeName === "item" ? node.arguments[0] : undefined;
          if (runtimeName === "item" && !index) {
            this.unsupported(node, "item() expects an index argument");
            return this.voidConst(node);
          }
          return {
            k: "listRead",
            op: runtimeName,
            list: list.id,
            ...(index ? { index: this.lowerExpr(index) } : {}),
            type: runtimeName === "length" ? "number" : list.type,
            span: this.span(node),
          };
        }
        if (list && LIST_COMMANDS.has(runtimeName)) {
          const expected = runtimeName === "clear" ? 0
            : (runtimeName === "push" || runtimeName === "deleteAt") ? 1 : 2;
          if (node.arguments.length < expected) {
            this.unsupported(node, `${runtimeName}() expects ${expected} argument(s)`);
            return this.voidConst(node);
          }
          this.emit({
            k: "list",
            op: runtimeName as ListOp,
            list: list.id,
            args: node.arguments.map((argument) => this.lowerExpr(argument)),
            span: this.span(node),
          });
          return this.voidConst(node);
        }
        const handle = this.handleOf(node);
        if (runtimeName === "get" && handle) {
          return { k: "read", var: handle.id, type: handle.type, span: this.span(node) };
        }
        if ((runtimeName === "set" || runtimeName === "change") && handle && node.arguments[0]) {
          const value: Expr = runtimeName === "set"
            ? this.lowerExpr(node.arguments[0])
            : {
              k: "binary", op: "add",
              l: { k: "read", var: handle.id, type: handle.type, span: this.span(node) },
              r: this.lowerExpr(node.arguments[0]),
              type: "number", span: this.span(node),
            };
          this.emit({ k: "assign", var: handle.id, value, span: this.span(node) });
          return this.voidConst(node);
        }
        if (runtimeName === "free") {
          const argument = node.arguments[0];
          if (!argument) {
            this.unsupported(node, "free() expects an object reference");
            return this.voidConst(node);
          }
          if (!ts.isIdentifier(argument)) {
            this.unsupported(node, "free() expects a variable name");
            return this.voidConst(node);
          }
          const symbol = this.checker.getSymbolAtLocation(argument);
          const decl = symbol ? this.symbolVars.get(symbol) : undefined;
          this.emit({
            k: "heapFree",
            object: this.lowerExpr(argument),
            ...(decl?.arraySize !== undefined ? { arraySize: decl.arraySize } : {}),
            span: this.span(node),
          });
          return this.voidConst(node);
        }
        if (runtimeName === "global" || runtimeName === "local" || runtimeName === "list") {
          this.unsupported(node, `${runtimeName}() must be bound to a top-level const`);
          return this.voidConst(node);
        }
        if (HAT_NAMES.has(runtimeName)) {
          this.unsupported(node, `${runtimeName}() is only valid as a top-level statement`);
          return this.voidConst(node);
        }
        this.emit({
          k: "expr", name: runtimeName,
          args: node.arguments.map((argument) => this.lowerExpr(argument)),
          span: this.span(node),
        });
        return this.voidConst(node);
      }
      const stringMethod = this.stringMethodOf(node);
      if (stringMethod) {
        const propertyAccess = node.expression as ts.PropertyAccessExpression;
        return {
          k: "intrinsic", name: stringMethod,
          args: [this.lowerExpr(propertyAccess.expression)],
          type: "string", span: this.span(node),
        };
      }
      const mathName = this.mathNameOf(node);
      if (mathName) {
        const intrinsic = MATH_INTRINSICS[mathName] ?? `ext.Math.${mathName}`;
        return {
          k: "intrinsic", name: intrinsic,
          args: node.arguments.map((argument) => this.lowerExpr(argument)),
          type: "number", span: this.span(node),
        };
      }
      this.unknown(node, "call target is not a TypeScratch intrinsic");
      return this.voidConst(node);
    }
    this.unsupported(node, `unsupported expression ${ts.SyntaxKind[node.kind]}`);
    return this.voidConst(node);
  }

  private lowerExpressionStatement(node: ts.ExpressionStatement): void {
    const expression = node.expression;
    if (ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(expression.left)) {
      const access = expression.left;
      const classHint = this.objectClassOf(access.expression);
      if (classHint) {
        this.emit({
          k: "fieldWrite",
          object: this.lowerExpr(access.expression),
          field: access.name.text,
          value: this.lowerExpr(expression.right),
          span: this.span(node),
        });
        return;
      }
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = COMPOUND_ASSIGNMENTS[expression.operatorToken.kind];
      if (operator && ts.isIdentifier(expression.left)) {
        const decl = this.varFor(expression.left);
        if (decl) {
          const right = this.lowerExpr(expression.right);
          const value: Expr = expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? right
            : {
              k: "binary", op: operator,
              l: { k: "read", var: decl.id, type: decl.type, span: this.span(expression) },
              r: right, type: decl.type, span: this.span(expression),
            };
          this.emit({ k: "assign", var: decl.id, value, span: this.span(node) });
          return;
        }
      }
    }
    const value = this.lowerExpr(expression);
    if (value.k === "call" || value.k === "methodCall" || value.k === "objectNew" || value.k === "arrayNew") {
      const type: IrType = value.type === "number" || value.type === "string" ? value.type : "number";
      const temp = this.newVar(`discard${this.counter + 1}`, type, "temp", this.span(expression));
      this.emit({ k: "declare", var: temp.id, init: value, span: this.span(expression) });
    }
  }

  private lowerStatement(node: ts.Statement): void {
    if (ts.isBlock(node)) {
      for (const statement of node.statements) this.lowerStatement(statement);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        this.lowerVariableDeclaration(declaration, node.declarationList.flags, false);
      }
      return;
    }
    if (ts.isExpressionStatement(node)) {
      this.lowerExpressionStatement(node);
      return;
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const keyword = ts.isBreakStatement(node) ? "break" : "continue";
      if (this.loopDepth === 0) {
        this.unsupported(node, `${keyword} outside a loop`);
        return;
      }
      if (this.forLoopDepth > 0) {
        this.unsupported(node, `${keyword} inside a for loop is not supported in v0.1`);
        return;
      }
      if (ts.isBreakStatement(node)) this.emit({ k: "break", span: this.span(node) });
      else this.emit({ k: "continue", span: this.span(node) });
      return;
    }
    if (ts.isIfStatement(node)) {
      const cond = this.lowerExpr(node.expression);
      const elseStatement = node.elseStatement;
      const thenBody = this.withBlock(() => this.lowerStatement(node.thenStatement));
      const elseBody = elseStatement
        ? this.withBlock(() => this.lowerStatement(elseStatement))
        : undefined;
      const stmt: Stmt = { k: "if", cond, then: thenBody, span: this.span(node) };
      if (elseBody) stmt.else = elseBody;
      this.emit(stmt);
      return;
    }
    if (ts.isWhileStatement(node)) {
      const cond = this.lowerExpr(node.expression);
      this.loopDepth += 1;
      const body = this.withBlock(() => this.lowerStatement(node.statement));
      this.loopDepth -= 1;
      this.emit({ k: "while", cond, body, span: this.span(node) });
      return;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) {
            this.lowerVariableDeclaration(declaration, node.initializer.flags, false);
          }
        } else {
          this.lowerExpr(node.initializer);
        }
      }
      const cond: Expr = node.condition
        ? this.lowerExpr(node.condition)
        : { k: "const", value: true, type: "boolean", span: this.span(node) };
      this.loopDepth += 1;
      this.forLoopDepth += 1;
      const body = this.withBlock(() => {
        this.lowerStatement(node.statement);
        if (node.incrementor) this.lowerExpr(node.incrementor);
      });
      this.forLoopDepth -= 1;
      this.loopDepth -= 1;
      this.emit({ k: "while", cond, body, span: this.span(node) });
      return;
    }
    if (ts.isReturnStatement(node)) {
      if (!this.currentFunction) {
        this.unsupported(node, "return is only valid inside a function");
        return;
      }
      const value = node.expression ? this.lowerExpr(node.expression) : undefined;
      this.emit({ k: "return", value, span: this.span(node) });
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      this.unsupported(node, "nested function declarations are not supported in v0.1");
      return;
    }
    if (ts.isEmptyStatement(node)) return;
    this.unsupported(node, `unsupported statement ${ts.SyntaxKind[node.kind]}`);
  }
}

export function lowerToHIR(typed: TypedProgram, config: FrontendConfig): Module {
  const module = new Lowerer(typed, config).lower();
  module.role = config.role ?? { name: "Sprite1", isStage: false };
  return module;
}
