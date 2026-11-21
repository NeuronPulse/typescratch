import { basename, relative, resolve } from "node:path";
import ts from "typescript";
import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import type {
  BinOp, ClassDecl, DispatchTarget, Expr, FieldDecl, FunctionDecl, Hat, IrType, ListDecl, ListOp,
  Module, RoleRef, Script, Stmt, VarDecl,
} from "@typescratch/ir";
import { MATH_INTRINSICS, MATH_RADIAN_IN, MATH_RADIAN_OUT, YIELDING_COMMANDS } from "@typescratch/language";

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

  // Imports are merged into a single flat module; a cycle would need
  // forward declarations the IR has no concept of. Reject it early.
  const edges = new Map<string, string[]>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes("node_modules")) continue;
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const resolved = ts.resolveModuleName(
        statement.moduleSpecifier.text, file.fileName, options, ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const from = resolve(file.fileName);
      edges.set(from, [...(edges.get(from) ?? []), resolve(resolved)]);
    }
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | undefined;
  const visit = (file: string): void => {
    state.set(file, 1);
    stack.push(file);
    for (const next of edges.get(file) ?? []) {
      if (state.get(next) === 1 && !cycle) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
      } else if (!state.get(next)) {
        visit(next);
      }
      if (cycle) return;
    }
    stack.pop();
    state.set(file, 2);
  };
  visit(entry);
  if (cycle) {
    config.bag.error(CODES.IMPORT_CYCLE,
      `import cycle: ${cycle.map((file) => relative(config.projectRoot, file)).join(" -> ")}`,
      { file: relative(config.projectRoot, source.fileName), start: 0, end: 0, line: 1, column: 1 });
    return undefined;
  }

  return { program, checker: program.getTypeChecker(), source };
}

class Lowerer {
  private readonly checker: ts.TypeChecker;
  private readonly typed: TypedProgram;
  private readonly source: ts.SourceFile;
  private readonly sources: ts.SourceFile[] = [];
  private currentSource: ts.SourceFile | undefined;
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
  /** A dictionary is two parallel lists (keys, values) plus its value type. */
  /** Static members are plain globals/functions; IR needs no "static" concept. */
  private readonly staticFieldVars = new Map<ts.Symbol, VarDecl>();
  private readonly staticMethodFns = new Map<ts.Symbol, FunctionDecl>();
  /** get/set accessors lower to virtual methods named __get_x / __set_x. */
  private readonly accessorSymbols = new Map<string, { classId: string; method: string }>();
  private readonly mapHandles = new Map<ts.Symbol, {
    keys: ListDecl; values: ListDecl; keyType: IrType; valueType: IrType;
  }>();
  private readonly classes: ClassDecl[] = [];
  private readonly classByName = new Map<string, ClassDecl>();
  private readonly classBySymbol = new Map<ts.Symbol, ClassDecl>();
  private readonly classById = new Map<string, ClassDecl>();
  private readonly methodNodes = new Map<ts.MethodDeclaration | ts.ConstructorDeclaration | ts.AccessorDeclaration, FunctionDecl>();
  private readonly arrayVars = new Map<ts.Symbol, { type: IrType }>();
  private currentThisVar: VarDecl | undefined;
  private classCounter = 0;
  private readonly compileTime = new Map<ts.Symbol, string | number | boolean>();
  /** Top-level variable storage chosen by @global / @local decorators. */
  private readonly varStorage = new Map<ts.VariableStatement, "global" | "local">();
  private current: Stmt[] = [];
  private counter = 0;
  private listCounter = 0;
  private scriptIndex = -1;
  private loopDepth = 0;
  private forLoopDepth = 0;
  private warnedModulo = false;
  private warnedLooseEquality = false;

  constructor(typed: TypedProgram, config: FrontendConfig) {
    this.typed = typed;
    this.checker = typed.checker;
    this.source = typed.source;
    this.root = config.projectRoot;
    this.runtimeDts = resolve(config.runtimeDts);
    this.roleName = config.role?.name ?? "Sprite1";
    this.bag = config.bag;
    const others = this.typed.program.getSourceFiles()
      .filter((file) => !file.isDeclarationFile
        && !file.fileName.includes("node_modules")
        && resolve(file.fileName) !== resolve(this.source.fileName))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    // Entry first keeps single-file golden artifacts byte-identical; imports
    // follow a frozen sorted order for reproducible multi-file builds.
    this.sources = [this.source, ...others];
  }

  /** Resolve `import { x as y }` aliases to the declaration's symbol. */
  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    const resolved = symbol.flags & ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(symbol) : symbol;
    // `export const x` has a local symbol and a distinct export symbol;
    // import aliases resolve to the latter. Normalize both sides to it.
    return (resolved as ts.Symbol & { exportSymbol?: ts.Symbol }).exportSymbol ?? resolved;
  }

  lower(): Module {
    for (const source of this.sources) {
      this.currentSource = source;
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement)) this.declareFunction(statement);
        if (ts.isClassDeclaration(statement)) {
          this.parseWarpDecorator(statement, "other");
          this.declareClass(statement);
        }
        if (ts.isVariableStatement(statement)) {
          // TS6 decorators cannot be applied to variables — use JSDoc tags
          // (`/** @global */`, `/** @local */`) as the compile-time annotation.
          const tags = this.jsDocOf(statement).flatMap((doc) => doc.tags ?? [])
            .map((tag) => tag.tagName.getText());
          for (const tag of tags) {
            if (tag === "global" || tag === "local") {
              this.varStorage.set(statement, tag);
            } else if (Lowerer.DECORATORS.has(tag) || tag === "tscr") {
              this.bag.error(CODES.DECORATOR, `@${tag} is not valid on a variable declaration`, this.span(statement));
            }
          }
          if (this.varStorage.has(statement) && tags.includes("global") && tags.includes("local")) {
            this.bag.error(CODES.DECORATOR, "@global and @local cannot be combined", this.span(statement));
          }
        }
      }
    }
    // Register every module's top-level bindings before lowering any script
    // body — a hat in the entry file may reference an imported declaration.
    for (const source of this.sources) {
      this.currentSource = source;
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          this.lowerVariableDeclaration(
            declaration, statement.declarationList.flags, true,
            this.varStorage.get(statement) ?? "local",
          );
        }
      }
    }
    for (const source of this.sources) {
      this.currentSource = source;
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
          || ts.isVariableStatement(statement)) continue;
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          || ts.isEmptyStatement(statement)) continue;
        if (ts.isExpressionStatement(statement) && this.lowerHatStatement(statement)) continue;
        this.unsupported(statement, "top-level statements may only declare resources, classes or register event hats");
      }
    }
    this.currentSource = this.source;
    for (const [node, fn] of this.functionNodes) this.lowerFunction(node, fn);
    for (const [node, fn] of this.methodNodes) this.lowerMethod(node, fn);
    // A warped procedure never yields; warp + recursion changes the VM's
    // scheduling/stack behavior in ways this compiler cannot guarantee.
    for (const fn of this.functions) {
      if (fn.warp !== true) continue;
      const id = fn.id;
      const targets = this.callEdges.get(id);
      if (targets?.has(id)) {
        this.bag.error(CODES.WARP_DECORATOR, `@warp cannot be used on recursive function ${fn.name}`, fn.span, [
          "Warped procedures never yield to the Scratch scheduler; recursion under warp has undefined stack behavior.",
        ]);
      }
    }
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
      if (type !== "number" && type !== "string" && type !== "boolean") {
        this.unsupported(member, `field ${member.name.text} must be number, string or boolean in v0.2`);
        continue;
      }
      const isStatic = (member.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      const initial = member.initializer ? this.literalValue(member.initializer) : undefined;
      if (isStatic) {
        if (initial === undefined) {
          this.bag.error(CODES.UNSUPPORTED,
            `static field ${name}.${member.name.text} needs a literal initializer`, this.span(member));
          continue;
        }
        const decl = this.newVar(`${name}.${member.name.text}`, type, "global", this.span(member), initial);
        const symbol = this.symbolOf(member.name);
        if (symbol) this.staticFieldVars.set(symbol, decl);
        continue;
      }
      const field: FieldDecl = { name: member.name.text, type };
      if (initial !== undefined) field.initial = initial;
      fields.push(field);
    }
    const moduleTag = this.sources.length > 1 && this.currentSource
      ? `${basename(this.currentSource.fileName, ".ts")}__` : "";
    const cls: ClassDecl = { id: `${moduleTag}${name}`, name, fields, methodIds: [], span: this.span(node) };
    this.classes.push(cls);
    this.classByName.set(name, cls);
    this.classById.set(cls.id, cls);
    if (node.name) {
      const symbol = this.symbolOf(node.name);
      if (symbol) this.classBySymbol.set(symbol, cls);
    }
    for (const member of node.members) {
      if (!ts.isConstructorDeclaration(member)) continue;
      if (cls.ctorId) {
        this.bag.error(CODES.UNSUPPORTED, `class ${name} has more than one constructor`, this.span(member));
        continue;
      }
      const ctor = this.declareConstructor(member, cls);
      cls.ctorId = ctor.id;
      this.methodNodes.set(member, ctor);
    }
    for (const member of node.members) {
      if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
        && ts.isIdentifier(member.name)) {
        const isGet = ts.isGetAccessorDeclaration(member);
        const method = `${isGet ? "__get_" : "__set_"}${member.name.text}`;
        const returnType = isGet
          ? this.irTypeOf(this.checker.getTypeAtLocation(member))
          : "void";
        const fn = this.declareFunctionLike(member, cls, method,
          `fn_${cls.name}_${method}_${++this.functionCounter}`, returnType);
        cls.methodIds.push(fn.id);
        this.methodNodes.set(member, fn);
        this.accessorSymbols.set(`${cls.id}.${isGet ? "get" : "set"}.${member.name.text}`, { classId: cls.id, method });
        continue;
      }
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const isStatic = (member.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      const fn = isStatic ? this.declareStaticMethod(member, cls) : this.declareMethod(member, cls);
      if (!isStatic) cls.methodIds.push(fn.id);
      this.methodNodes.set(member, fn);
    }
  }

  private declareMethod(node: ts.MethodDeclaration, cls: ClassDecl): FunctionDecl {
    const warp = this.parseWarpDecorator(node, "function");
    const name = ts.isIdentifier(node.name) ? node.name.text : `anonymous${++this.functionCounter}`;
    const id = `fn_${cls.name}_${name}_${++this.functionCounter}`;
    const returnType = node.type
      ? this.irTypeOf(this.checker.getTypeFromTypeNode(node.type))
      : "number";
    const fn = this.declareFunctionLike(node, cls, name, id, returnType);
    if (warp !== undefined) fn.warp = warp;
    return fn;
  }

  private declareConstructor(node: ts.ConstructorDeclaration, cls: ClassDecl): FunctionDecl {
    for (const modifier of node.modifiers ?? []) {
      if (modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) {
        this.bag.error(CODES.UNSUPPORTED, "private/protected constructors are not supported", this.span(node));
      }
    }
    return this.declareFunctionLike(node, cls, "__ctor", `fn_${cls.name}__ctor_${++this.functionCounter}`, "void");
  }

  private declareStaticMethod(node: ts.MethodDeclaration, cls: ClassDecl): FunctionDecl {
    const name = ts.isIdentifier(node.name) ? node.name.text : `static${++this.functionCounter}`;
    const fn = this.declareFunctionLike(node, cls, name,
      `fn_${cls.name}_static_${name}_${++this.functionCounter}`,
      node.type ? this.irTypeOf(this.checker.getTypeFromTypeNode(node.type)) : "number", false);
    const symbol = this.symbolOf(node.name);
    if (symbol) this.staticMethodFns.set(symbol, fn);
    return fn;
  }

  private declareFunctionLike(
    node: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.AccessorDeclaration,
    cls: ClassDecl, name: string, id: string, returnType: IrType,
    withThis = true,
  ): FunctionDecl {
    const span = this.span(node);
    const callId = this.newVar(`${name}_callId`, "number", "temp", span, 0);
    const returnValue = this.newVar(`${name}_ret`, returnType, "temp", span, 0);
    const returning = this.newVar(`${name}_returning`, "number", "temp", span, 0);
    const thisDecl = this.newVar("this", "number", "temp", span, 0);
    thisDecl.parameter = true;
    const params: VarDecl[] = withThis ? [thisDecl] : [];
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
      const symbol = this.symbolOf(parameter.name);
      if (symbol) this.symbolVars.set(symbol, decl);
      params.push(decl);
    }
    const fn: FunctionDecl = {
      id, name, params, returnType, body: [],
      callId: callId.id, returnValue: returnValue.id, returning: returning.id,
      ...(withThis ? { thisVar: thisDecl.id, classId: cls.id } : {}), span,
    };
    this.functions.push(fn);
    this.callEdges.set(id, new Set());
    return fn;
  }

  private lowerMethod(node: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.AccessorDeclaration, fn: FunctionDecl): void {
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
    const typeSymbol = type.getSymbol() ?? type.aliasSymbol;
    const found = typeSymbol ? this.classBySymbol.get(typeSymbol) : undefined;
    if (found) return found.id;
    const name = typeSymbol?.getName();
    const byName = name ? this.classByName.get(name) : undefined;
    return byName?.id;
  }

  private fieldType(field: string, classHint?: string): IrType {
    const known = classHint ? this.classById.get(classHint) : undefined;
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
    const symbol = this.symbolOf(node.expression.expression);
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
    const warp = this.parseWarpDecorator(node, "function");
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
      const symbol = this.symbolOf(parameter.name);
      if (symbol) this.symbolVars.set(symbol, decl);
      params.push(decl);
    }
    const fn: FunctionDecl = {
      id, name, params, returnType, body: [],
      callId: callId.id, returnValue: returnValue.id, returning: returning.id, span,
      ...(warp !== undefined ? { warp } : {}),
    };
    this.functions.push(fn);
    this.functionNodes.set(node, fn);
    this.callEdges.set(id, new Set());
    const symbol = node.name ? this.symbolOf(node.name) : undefined;
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

  /**
   * Scratch.do(opcode, inputs?, fields?) / Scratch.get(opcode, inputs?, fields?)
   * lowers any Scratch block — including extension blocks — to generic IR.
   */
  private lowerRawBlock(node: ts.CallExpression, command: boolean): Expr {
    const opcodeArg = node.arguments[0];
    if (!opcodeArg || !ts.isStringLiteralLike(opcodeArg)) {
      this.unsupported(node, `${command ? "do" : "get"}() requires a literal opcode string`);
      return this.voidConst(node);
    }
    const opcode = opcodeArg.text;
    const inputsArg = node.arguments[1];
    const fieldsArg = node.arguments[2];
    const inputs: Record<string, Expr> = {};
    const fields: Record<string, string> = {};
    if (inputsArg) {
      if (!ts.isObjectLiteralExpression(inputsArg)) {
        this.unsupported(inputsArg, `${command ? "do" : "get"}() inputs must be an object literal`);
      } else {
        for (const property of inputsArg.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
            this.unsupported(property, "block inputs must be simple name: value properties");
            continue;
          }
          inputs[property.name.text] = this.lowerExpr(property.initializer);
        }
      }
    }
    if (fieldsArg) {
      if (!ts.isObjectLiteralExpression(fieldsArg)) {
        this.unsupported(fieldsArg, `${command ? "do" : "get"}() fields must be an object literal`);
      } else {
        for (const property of fieldsArg.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
            || !ts.isStringLiteralLike(property.initializer)) {
            this.unsupported(property, "block fields must be simple name: 'value' string properties");
            continue;
          }
          fields[property.name.text] = property.initializer.text;
        }
      }
    }
    if (command) {
      this.emit({ k: "rawStmt", opcode, inputs, fields, span: this.span(node) });
      return this.voidConst(node);
    }
    return { k: "raw", opcode, inputs, fields, type: "number", span: this.span(node) };
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

  /** Decorators TypeScratch recognizes as compile-time annotations. */
  private static readonly DECORATORS = new Set([
    "warp", "noWarp", "global", "local", "public", "private", "protected",
  ]);

  /**
   * Parse all decorators on a declaration into a set of recognized names.
   * Unknown decorators, duplicates and mutually exclusive pairs are hard
   * errors (TSCR2010) — a decorator must never be silently ignored.
   */
  private parseDecorators(node: ts.Node): Set<string> {
    const found = new Set<string>();
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (!decorators || decorators.length === 0) return found;
    for (const decorator of decorators) {
      const expr = decorator.expression;
      const name = ts.isIdentifier(expr) ? expr.text : undefined;
      if (!name || !Lowerer.DECORATORS.has(name)) {
        this.bag.error(
          CODES.DECORATOR,
          name ? `unsupported decorator @${name}` : "decorator expressions are not supported",
          this.span(decorator),
          [`Recognized: ${[...Lowerer.DECORATORS].map((d) => "@" + d).join(", ")}.`],
        );
        continue;
      }
      if (found.has(name)) {
        this.bag.error(CODES.DECORATOR, `duplicate @${name} decorator`, this.span(decorator));
        continue;
      }
      found.add(name);
    }
    const conflict = (a: string, b: string): void => {
      if (found.has(a) && found.has(b)) {
        this.bag.error(CODES.DECORATOR, `@${a} and @${b} cannot be combined`, this.span(node));
        found.delete(b);
      }
    };
    conflict("warp", "noWarp");
    conflict("global", "local");
    conflict("public", "private");
    conflict("public", "protected");
    conflict("private", "protected");
    return found;
  }

  /**
   * Warp subset of parseDecorators, kept for the existing call sites.
   */
  private parseWarpDecorator(node: ts.Node, context: "function" | "other"): boolean | undefined {
    const decorators = this.parseDecorators(node);
    const warp = decorators.has("warp");
    const noWarp = decorators.has("noWarp");
    for (const name of ["global", "local", "public", "private", "protected"]) {
      if (decorators.has(name)) {
        this.bag.error(CODES.DECORATOR, `@${name} is not valid here`, this.span(node));
      }
    }
    if (!warp && !noWarp) return undefined;
    if (context !== "function") {
      this.bag.error(CODES.DECORATOR, "@warp/@noWarp are only valid on methods", this.span(node));
      return undefined;
    }
    return warp;
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
    // IDs must be unique across workspace modules: the counter resets per
    // Lowerer (one per source file), so include the role. Names stay readable
    // and carry scope/role so the emitted .sb3 is inspectable, not UUID soup.
    const role = this.roleName.replace(/[^A-Za-z0-9_]/g, "_");
    const seq = ++this.counter;
    const prefix = storage === "temp" ? `t_${role}_s${index}` : storage === "local" ? `l_${role}` : `g_${role}`;
    const id = `${prefix}_${seq}`;
    // Scratch VM indexes variables by NAME, so imported modules sharing a
    // source-level name must get distinct Scratch names. The sequence is
    // already unique; only add it in multi-file builds to keep goldens stable.
    const tag = this.sources.length > 1 ? `_${seq}` : "";
    const decl: VarDecl = {
      id,
      name: storage === "temp" ? `${role}_s${index}_${name}${tag}`
        : storage === "local" ? `${role}.${name}${tag}` : `${name}${tag}`,
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
    const seq = ++this.listCounter;
    const decl: ListDecl = {
      id: `l${this.roleName}_${seq}`,
      name: this.sources.length > 1 ? `${name}_${seq}` : name,
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
    const symbol = this.symbolOf(call.expression);
    if (!symbol) return undefined;
    const declarations = symbol.getDeclarations() ?? [];
    const fromRuntime = declarations.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === this.runtimeDts,
    );
    return fromRuntime ? symbol.getName() : undefined;
  }

  /**
   * Object-call Scratch block metadata, read entirely from the runtime d.ts —
   * no separate block table. The method's `@tscr opcode X` JSDoc gives the
   * opcode, parameter names give Scratch input names, `@tscr field` marks a
   * static menu parameter, and the declared return type decides command
   * (void) vs reporter (number/string/boolean).
   */
  private jsDocOf(node: ts.Node): readonly ts.JSDoc[] {
    return (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [];
  }

  private blockMetaOf(call: ts.CallExpression): {
    opcode: string;
    inputs: string[];
    fields: string[];
    returns: IrType;
    command: boolean;
  } | undefined {
    const access = call.expression;
    if (!ts.isPropertyAccessExpression(access) || !ts.isPropertyAccessExpression(access.expression)) return undefined;
    const owner = access.expression;
    if (!ts.isIdentifier(owner.expression) || owner.expression.text !== "Scratch") return undefined;
    const symbol = this.symbolOf(access);
    const declaration = symbol?.getDeclarations()?.[0];
    if (!declaration || !ts.isMethodSignature(declaration)) return undefined;
    if (resolve(declaration.getSourceFile().fileName) !== this.runtimeDts) return undefined;

    const tag = this.jsDocOf(declaration).flatMap((doc) => doc.tags ?? [])
      .find((t) => t.tagName.getText() === "tscr" && /opcode\s+/.test(String(t.comment ?? "")));
    const opcode = tag ? String(tag.comment).match(/opcode\s+(\S+)/)?.[1] : undefined;
    if (!opcode) return undefined;

    const inputs: string[] = [];
    const fields: string[] = [];
    for (const parameter of declaration.parameters) {
      const name = parameter.name.getText();
      const isField = this.jsDocOf(parameter).some((doc) => doc.tags?.some((t) => t.tagName.getText() === "tscr" && /field/.test(String(t.comment ?? ""))));
      (isField ? fields : inputs).push(name);
    }
    const signature = this.checker.getSignatureFromDeclaration(declaration);
    const returnType = signature ? this.checker.typeToString(signature.getReturnType()) : "void";
    const command = returnType === "void";
    const returns: IrType = command ? "number" : (returnType === "string" || returnType === "boolean" ? returnType : "number");
    return { opcode, inputs, fields, returns, command };
  }

  /** Lower an object-call block whose metadata came from the runtime d.ts. */
  private lowerObjectBlock(call: ts.CallExpression, meta: NonNullable<ReturnType<Lowerer["blockMetaOf"]>>): Expr {
    const args = call.arguments;
    const expected = meta.inputs.length + meta.fields.length;
    if (args.length < expected) {
      this.unsupported(call, `${meta.opcode} expects ${expected} argument(s)`);
      return this.voidConst(call);
    }
    const inputs: Record<string, Expr> = {};
    meta.inputs.forEach((name, index) => { inputs[name] = this.lowerExpr(args[index]!); });
    const fields: Record<string, string> = {};
    meta.fields.forEach((name, i) => {
      const value = args[meta.inputs.length + i]!;
      if (!ts.isStringLiteralLike(value)) {
        this.unsupported(value, "Scratch block field arguments must be string literals");
        return;
      }
      fields[name] = value.text;
    });
    const span = this.span(call);
    if (meta.command) {
      // A command emits a statement and has no value. Using it where a value
      // is expected (`const x = Scratch.looks.say(...)`) is a semantic error,
      // reported here rather than silently yielding a `void` value.
      if (!ts.isExpressionStatement(call.parent)) {
        this.bag.error(
          CODES.UNSUPPORTED,
          `${meta.opcode} is a Scratch command and cannot be used as a value`,
          span,
          ["Commands emit a statement; only reporters return a value."],
        );
      }
      this.emit({ k: "rawStmt", opcode: meta.opcode, inputs, fields, span });
      return this.voidConst(call);
    }
    return { k: "raw", opcode: meta.opcode, inputs, fields, type: meta.returns, span };
  }

  private mathNameOf(call: ts.CallExpression): string | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "Math") return undefined;
    const symbol = this.symbolOf(expression);
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
    const nativeMethods: Record<string, string> = { charAt: "string.charAt", includes: "string.includes" };
    const isNative = method in nativeMethods;
    if (!isNative && method !== "toUpperCase" && method !== "toLowerCase") return undefined;
    if (this.typeOf(expression.expression) !== "string") return undefined;
    const symbol = this.symbolOf(expression);
    const declarations = symbol?.getDeclarations() ?? [];
    const fromLib = declarations.some((declaration) =>
      /[\\/]lib\.[^\\/]*\.d\.ts$/.test(declaration.getSourceFile().fileName),
    );
    if (!fromLib) return undefined;
    return isNative ? nativeMethods[method]! : `ext.String.${method}`;
  }

  private handleOf(call: ts.CallExpression): VarDecl | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const symbol = this.symbolOf(expression.expression);
    return symbol ? this.handleVars.get(symbol) : undefined;
  }

  private listOf(call: ts.CallExpression): ListDecl | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const symbol = this.symbolOf(expression.expression);
    return symbol ? this.handleLists.get(symbol) : undefined;
  }

  private varFor(identifier: ts.Identifier): VarDecl | undefined {
    const symbol = this.symbolOf(identifier);
    const decl = symbol ? this.symbolVars.get(symbol) : undefined;
    if (!decl) this.unsupported(identifier, `unresolved variable ${identifier.text}`);
    return decl;
  }

  private literalValue(node: ts.Expression | undefined): string | number | boolean | undefined {
    if (!node) return undefined;
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      return Number.isFinite(value) ? value : undefined;
    }
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
    storage: "global" | "local" = "local",
  ): void {
    if (!ts.isIdentifier(declaration.name)) {
      this.unsupported(declaration, "destructuring declarations are not supported");
      return;
    }
    const symbol = this.symbolOf(declaration.name);
    const initializer = declaration.initializer;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;

    if (initializer && ts.isCallExpression(initializer)) {
      const runtimeName = this.runtimeNameOf(initializer);
      if (runtimeName === "map") {
        const handleType = this.checker.getTypeAtLocation(initializer) as ts.TypeReference;
        const typeArguments = this.checker.getTypeArguments(handleType);
        const keyType = typeArguments[0] ? this.irTypeOf(typeArguments[0]) : "number";
        const valueType = typeArguments[1] ? this.irTypeOf(typeArguments[1]) : "number";
        if (keyType !== "number") {
          this.unsupported(initializer, "dictionary keys must be number in v1 (Scratch string equality is case-insensitive)");
          return;
        }
        const span = this.span(declaration);
        const name = declaration.name.text;
        const keys = this.newList(`${name}__keys`, keyType, span);
        const values = this.newList(`${name}__values`, valueType, span);
        if (symbol) this.mapHandles.set(symbol, { keys, values, keyType, valueType });
        return;
      }
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
      // A top-level `let` is private to its sprite by default (Scratch local
      // variable). `@global` opts into a Stage variable visible to every
      // role — that is the only cross-sprite storage Scratch provides.
      const decl = this.newVar(
        declaration.name.text,
        initializer ? this.typeOf(declaration.name) : "number",
        storage,
        this.span(declaration),
        this.literalValue(initializer),
      );
      if (symbol) this.symbolVars.set(symbol, decl);
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

  /**
   * Emit a linear scan over the dictionary's parallel lists. Temps are
   * per-script so concurrent hats cannot clobber each other. O(n) by design —
   * Scratch has no associative lookup block.
   */
  private emitMapLookup(
    handle: { keys: ListDecl; values: ListDecl; keyType: IrType; valueType: IrType },
    key: Expr, span: SourceSpan,
  ): { found: VarDecl; result: VarDecl; index: VarDecl } {
    const zero = handle.valueType === "string" ? "" : 0;
    const index = this.newVar("mapIndex", "number", "temp", span, 0);
    const matchIndex = this.newVar("mapMatchIndex", "number", "temp", span, 0);
    const found = this.newVar("mapFound", "number", "temp", span, 0);
    const result = this.newVar("mapResult", handle.valueType, "temp", span, zero);
    const num = (value: number): Expr => ({ k: "const", value, type: "number", span });
    const read = (decl: VarDecl, type: IrType = decl.type): Expr => ({ k: "read", var: decl.id, type, span });
    for (const [decl, value] of [[index, 0], [matchIndex, 0], [found, 0], [result, zero]] as const) {
      this.emit({ k: "declare", var: decl.id, init: { k: "const", value, type: decl.type, span }, span });
    }
    const length: Expr = { k: "listRead", op: "length", list: handle.keys.id, type: "number", span };
    const inBounds: Expr = { k: "binary", op: "lt", l: read(index), r: length, type: "boolean", span };
    const notFound: Expr = { k: "binary", op: "eq", l: read(found), r: num(0), type: "boolean", span };
    const storedKey: Expr = { k: "listRead", op: "item", list: handle.keys.id, index: read(index), type: handle.keyType, span };
    const matches: Expr = { k: "binary", op: "eq", l: storedKey, r: key, type: "boolean", span };
    // No `binary and` — the backend has no such block. Guard the match with
    // `notFound`, but ALWAYS advance the index so the loop terminates even
    // after a hit.
    const body: Stmt[] = this.withBlock(() => {
      this.emit({ k: "if", cond: notFound, then: this.withBlock(() => {
        this.emit({ k: "if", cond: matches, then: this.withBlock(() => {
          this.emit({ k: "assign", var: found.id, value: num(1), span });
          this.emit({ k: "assign", var: matchIndex.id, value: read(index), span });
          this.emit({
            k: "assign", var: result.id,
            value: { k: "listRead", op: "item", list: handle.values.id, index: read(index), type: handle.valueType, span },
            span,
          });
        }), span });
      }), span });
      this.emit({
        k: "assign", var: index.id,
        value: { k: "binary", op: "add", l: read(index), r: num(1), type: "number", span },
        span,
      });
    });
    this.emit({ k: "while", cond: inBounds, body, span });
    return { found, result, index: matchIndex };
  }

  private mapHandleOf(call: ts.CallExpression): {
    keys: ListDecl; values: ListDecl; keyType: IrType; valueType: IrType; method: string;
  } | undefined {
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const symbol = this.symbolOf(expression.expression);
    const handle = symbol ? this.mapHandles.get(symbol) : undefined;
    return handle ? { ...handle, method: expression.name.text } : undefined;
  }

  private accessorOf(
    object: ts.Expression, name: string, kind: "get" | "set",
  ): { classId: string; method: string } | undefined {
    const classId = this.objectClassOf(object);
    return classId ? this.accessorSymbols.get(`${classId}.${kind}.${name}`) : undefined;
  }

  /** private/protected members may only be accessed through `this`. */
  private checkVisibility(symbol: ts.Symbol | undefined, object: ts.Expression, node: ts.Node): void {
    if (!symbol || object.kind === ts.SyntaxKind.ThisKeyword) return;
    const declaration = symbol.declarations?.[0];
    if (!declaration || !ts.canHaveModifiers(declaration)) return;
    const modifiers = ts.getModifiers(declaration) ?? [];
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) {
      this.bag.error(CODES.VISIBILITY,
        `${symbol.name} is private/protected and can only be accessed through this`,
        this.span(node));
    }
  }

  private emitGetterCall(node: ts.Node, object: ts.Expression, method: string): Expr {
    const targets = this.dispatchTargets(method);
    return {
      k: "methodCall", object: this.lowerExpr(object), method, args: [], targets,
      type: targets.length > 0 ? this.methodReturnType(targets[0]!.function) : "number",
      span: this.span(node),
    };
  }

  private lowerMapCall(node: ts.CallExpression): Expr | undefined {
    const meta = this.mapHandleOf(node);
    if (!meta) return undefined;
    const span = this.span(node);
    const args = node.arguments;
    const num = (value: number): Expr => ({ k: "const", value, type: "number", span });
    const read = (decl: VarDecl, type: IrType = decl.type): Expr => ({ k: "read", var: decl.id, type, span });
    const zero = meta.valueType === "string" ? "" : 0;

    if (meta.method === "size") {
      const size = this.newVar("mapSize", "number", "temp", span, 0);
      this.emit({ k: "declare", var: size.id, init: num(0), span });
      this.emit({
        k: "assign", var: size.id,
        value: { k: "listRead", op: "length", list: meta.keys.id, type: "number", span },
        span,
      });
      return read(size);
    }
    if (meta.method === "clear") {
      this.emit({ k: "list", op: "clear", list: meta.keys.id, args: [], span });
      this.emit({ k: "list", op: "clear", list: meta.values.id, args: [], span });
      return this.voidConst(node);
    }

    const key = args[0] ? this.lowerExpr(args[0]) : num(0);
    const lookup = this.emitMapLookup(meta, key, span);
    const foundCond: Expr = {
      k: "binary", op: "eq", l: read(lookup.found), r: num(1), type: "boolean", span,
    };
    if (meta.method === "get") return read(lookup.result);
    if (meta.method === "has") {
      return { k: "convert", to: "boolean", value: read(lookup.found), type: "boolean", span };
    }
    if (meta.method === "set") {
      const value = args[1] ? this.lowerExpr(args[1]) : { k: "const" as const, value: zero, type: meta.valueType, span };
      this.emit({ k: "if", cond: foundCond, then: this.withBlock(() => {
        this.emit({
          k: "list", op: "replace", list: meta.values.id,
          args: [read(lookup.index), value], span,
        });
      }), else: this.withBlock(() => {
        this.emit({ k: "list", op: "push", list: meta.keys.id, args: [key], span });
        this.emit({ k: "list", op: "push", list: meta.values.id, args: [value], span });
      }), span });
      return this.voidConst(node);
    }
    if (meta.method === "delete") {
      this.emit({ k: "if", cond: foundCond, then: this.withBlock(() => {
        this.emit({ k: "list", op: "deleteAt", list: meta.keys.id, args: [read(lookup.index)], span });
        this.emit({ k: "list", op: "deleteAt", list: meta.values.id, args: [read(lookup.index)], span });
      }), span });
      return this.voidConst(node);
    }
    this.unsupported(node, `unsupported dictionary method ${meta.method}`);
    return this.voidConst(node);
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
      const value = Number(node.text);
      if (!Number.isFinite(value)) {
        this.bag.error(
          CODES.NUMERIC_PROFILE,
          `numeric literal ${node.text} is not finite in JavaScript`,
          this.span(node),
          ["Scratch cannot represent Infinity or NaN as a stable variable value."],
        );
        return this.voidConst(node);
      }
      return { k: "const", value, type: "number", span: this.span(node) };
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
      if (ts.isIdentifier(node.expression)) {
        const classSymbol = this.symbolOf(node.expression);
        const cls = (classSymbol ? this.classBySymbol.get(classSymbol) : undefined)
          ?? this.classByName.get(node.expression.text);
        if (cls) {
          const args = node.arguments?.map((arg) => this.lowerExpr(arg)) ?? [];
          if (args.length > 0 && !cls.ctorId) {
            this.bag.error(CODES.UNSUPPORTED,
              `class ${cls.name} has no constructor but new passes ${args.length} argument(s)`, this.span(node));
          }
          return { k: "objectNew", classId: cls.id, args, type: "number", span: this.span(node) };
        }
      }
      this.unsupported(node, "new is only supported for TypeScratch class declarations");
      return this.voidConst(node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const propertySymbol = this.symbolOf(node.name);
      const staticField = propertySymbol ? this.staticFieldVars.get(propertySymbol) : undefined;
      if (staticField) {
        return { k: "read", var: staticField.id, type: staticField.type, span: this.span(node) };
      }
      const accessor = this.accessorOf(node.expression, node.name.text, "get");
      if (accessor) {
        return this.emitGetterCall(node, node.expression, accessor.method);
      }
      const classHint = this.objectClassOf(node.expression);
      if (classHint) {
        this.checkVisibility(propertySymbol, node.expression, node);
        return {
          k: "fieldRead",
          object: this.lowerExpr(node.expression),
          field: node.name.text,
          type: this.fieldType(node.name.text, classHint),
          span: this.span(node),
        };
      }
      if (node.name.text === "length" && this.typeOf(node.expression) === "string") {
        return {
          k: "intrinsic", name: "string.length",
          args: [this.lowerExpr(node.expression)], type: "number", span: this.span(node),
        };
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "Math"
        && (node.name.text === "PI" || node.name.text === "E")) {
        const symbol = this.symbolOf(node);
        const fromLib = symbol?.getDeclarations()?.some((d) => /[\\/]lib\.[^\\/]*\.d\.ts$/.test(d.getSourceFile().fileName));
        if (fromLib) {
          return {
            k: "const", value: node.name.text === "PI" ? Math.PI : Math.E,
            type: "number", span: this.span(node),
          };
        }
      }
      this.unsupported(node, `unsupported property access ${node.name.text}`);
      return this.voidConst(node);
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.symbolOf(node);
      if (symbol && this.compileTime.has(symbol)) {
        const value = this.compileTime.get(symbol)!;
        const type: IrType = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
        return { k: "const", value, type, span: this.span(node) };
      }
      const decl = symbol ? this.symbolVars.get(symbol) : undefined;
      if (decl) return { k: "read", var: decl.id, type: decl.type, span: this.span(node) };
      if (node.text === "undefined") {
        this.unsupported(node, "undefined has no Scratch representation; use a finite sentinel (e.g. -1 or \"\")");
        return this.voidConst(node);
      }
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
      if (kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
        if (!this.warnedLooseEquality) {
          this.warnedLooseEquality = true;
          this.bag.warning(
            CODES.UNSAFE_SEMANTICS,
            "== and != use the Value ABI abstractEquality contract; native Scratch can only approximate ECMAScript ToNumber and strict string comparison",
            this.span(node),
          );
        }
        return {
          k: "abstractEq", l: left, r: right,
          negate: kind === ts.SyntaxKind.ExclamationEqualsToken,
          strictStrings: left.type === "string" && right.type === "string",
          type: "boolean",
          span: this.span(node),
        };
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
      const mapCall = this.lowerMapCall(node);
      if (mapCall) return mapCall;
      if (ts.isPropertyAccessExpression(node.expression)) {
        const methodSymbol = this.symbolOf(node.expression.name);
        const staticFn = methodSymbol ? this.staticMethodFns.get(methodSymbol) : undefined;
        if (staticFn) {
          if (this.currentFunction) this.callEdges.get(this.currentFunction.id)?.add(staticFn.id);
          if (node.arguments.length !== staticFn.params.length) {
            this.unsupported(node, `static method ${staticFn.name}() expects ${staticFn.params.length} argument(s)`);
            return this.voidConst(node);
          }
          return {
            k: "call", function: staticFn.id,
            args: node.arguments.map((argument) => this.lowerExpr(argument)),
            type: staticFn.returnType, span: this.span(node),
          };
        }
        const method = node.expression.name.text;
        const targets = this.dispatchTargets(method);
        const classHint = this.objectClassOf(node.expression.expression);
        if (targets.length > 0 && classHint) {
          this.checkVisibility(methodSymbol, node.expression.expression, node);
          if (this.currentFunction) {
            for (const target of targets) this.callEdges.get(this.currentFunction.id)?.add(target.function);
          }
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
      const symbol = this.symbolOf(node.expression);
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
      const blockMeta = this.blockMetaOf(node);
      if (blockMeta) {
        return this.lowerObjectBlock(node, blockMeta);
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
          const symbol = this.symbolOf(argument);
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
        if (runtimeName === "do" || runtimeName === "get") {
          return this.lowerRawBlock(node, runtimeName === "do");
        }
        if (HAT_NAMES.has(runtimeName)) {
          this.unsupported(node, `${runtimeName}() is only valid as a top-level statement`);
          return this.voidConst(node);
        }
        if (YIELDING_COMMANDS.has(runtimeName) && this.currentFunction?.warp === true) {
          this.bag.error(
            CODES.WARP_YIELD,
            `${runtimeName}() suspends the thread and cannot be used inside a @warp method`,
            this.span(node),
            ["Warp procedures never yield to the Scratch scheduler; a suspension would be silently ignored."],
          );
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
        const span = this.span(node);
        const receiver = this.lowerExpr(propertyAccess.expression);
        let args: Expr[];
        let type: IrType = "string";
        if (stringMethod === "string.charAt") {
          // Scratch operator_letter_of is 1-based; JS charAt is 0-based.
          const index = node.arguments[0] ? this.lowerExpr(node.arguments[0]) : { k: "const" as const, value: 0, type: "number" as const, span };
          args = [{
            k: "binary", op: "add", l: index, r: { k: "const", value: 1, type: "number", span },
            type: "number", span,
          }, receiver];
        } else if (stringMethod === "string.includes") {
          const needle = node.arguments[0] ? this.lowerExpr(node.arguments[0]) : { k: "const" as const, value: "", type: "string" as const, span };
          args = [receiver, needle];
          type = "boolean";
        } else {
          args = [receiver]; // toUpperCase / toLowerCase extension reporters
        }
        return { k: "intrinsic", name: stringMethod, args, type, span };
      }
      const mathName = this.mathNameOf(node);
      if (mathName) {
        const span = this.span(node);
        const intrinsic = MATH_INTRINSICS[mathName] ?? `ext.Math.${mathName}`;
        const num = (value: number): Expr => ({ k: "const", value, type: "number", span });
        const arg0 = node.arguments[0];
        const loweredArg0 = arg0 ? this.lowerExpr(arg0) : num(0);
        // Scratch's trig blocks use degrees; JS Math uses radians. Convert at
        // the boundary so `Math.sin(Math.PI / 2)` really equals 1.
        const arg = MATH_RADIAN_IN.has(mathName)
          ? { k: "binary" as const, op: "mul" as const, l: loweredArg0, r: num(180 / Math.PI), type: "number" as const, span }
          : loweredArg0;
        const args = [arg, ...node.arguments.slice(1).map((argument) => this.lowerExpr(argument))];
        const call: Expr = { k: "intrinsic", name: intrinsic, args, type: "number", span };
        return MATH_RADIAN_OUT.has(mathName)
          ? { k: "binary", op: "mul", l: call, r: num(Math.PI / 180), type: "number", span }
          : call;
      }
      this.unknown(node, "call target is not a TypeScratch intrinsic");
      return this.voidConst(node);
    }
    const isUndefined = ts.isIdentifier(node) && node.text === "undefined";
    if (node.kind === ts.SyntaxKind.NullKeyword || isUndefined) {
      this.unsupported(
        node,
        `${isUndefined ? "undefined" : "null"} has no Scratch representation; use a finite sentinel (e.g. -1 or "")`,
      );
    } else if (ts.isArrayLiteralExpression(node)) {
      this.unsupported(node, "array literals are not supported; use Scratch.array<T>(size) with set()/get()");
    } else if (ts.isObjectLiteralExpression(node)) {
      this.unsupported(node, "object literals are not supported; use a class instance (new) or Scratch.global/local");
    } else {
      this.unsupported(node, `unsupported expression ${ts.SyntaxKind[node.kind]}`);
    }
    return this.voidConst(node);
  }

  private lowerExpressionStatement(node: ts.ExpressionStatement): void {
    const expression = node.expression;
    if (ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(expression.left)) {
      const access = expression.left;
      const propertySymbol = this.symbolOf(access.name);
      const staticField = propertySymbol ? this.staticFieldVars.get(propertySymbol) : undefined;
      if (staticField) {
        this.emit({
          k: "assign", var: staticField.id,
          value: this.lowerExpr(expression.right), span: this.span(node),
        });
        return;
      }
      const accessor = this.accessorOf(access.expression, access.name.text, "set");
      if (accessor) {
        const targets = this.dispatchTargets(accessor.method);
        const value = this.lowerExpr(expression.right);
        const call: Expr = {
          k: "methodCall", object: this.lowerExpr(access.expression),
          method: accessor.method, args: [value], targets, type: "void", span: this.span(node),
        };
        const temp = this.newVar("discardAccessor", "number", "temp", this.span(node));
        this.emit({ k: "declare", var: temp.id, init: call, span: this.span(node) });
        return;
      }
      const classHint = this.objectClassOf(access.expression);
      if (classHint) {
        this.checkVisibility(propertySymbol, access.expression, node);
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
    if (ts.isTryStatement(node)) {
      if (!node.catchClause) {
        this.unsupported(node, "try requires a catch clause; there is no finally in v0.1");
        return;
      }
      const span = this.span(node);
      const catchName = node.catchClause.variableDeclaration?.name;
      if (!catchName || !ts.isIdentifier(catchName)) {
        this.unsupported(node, "catch must bind an identifier (catch (e) { ... })");
        return;
      }
      const errorDecl = this.newVar("error", "string", "temp", span, "");
      const symbol = this.symbolOf(catchName);
      if (symbol) this.symbolVars.set(symbol, errorDecl);
      const body = this.withBlock(() => this.lowerStatement(node.tryBlock));
      const handler = this.withBlock(() => this.lowerStatement(node.catchClause!.block));
      this.emit({ k: "tryCall", body, handler, errorVar: errorDecl.id, span });
      return;
    }
    if (ts.isThrowStatement(node)) {
      const value = this.lowerExpr(node.expression);
      if (value.type !== "string") {
        this.unsupported(node, "throw only supports string expressions in v0.1");
        return;
      }
      this.emit({ k: "raise", value, span: this.span(node) });
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
