import { defineRule, type ESTree } from "@oxlint/plugins";

// Runs read back from a provider transcript (`nativeOrigin`) are shown but never steer T3, so every place that orders runs or picks one by order states which runs it reads. Name-based: a collection is a run collection when its identifier or property is named `runs` or ends in `Runs`.
const RUN_COLLECTION_NAME = /^(?:runs|\w+Runs)$/u;
const ORIGIN_SELECTOR = "runsByOrigin";
const SQL_ORIGIN_SELECTOR = "runOriginSql";
// The module that defines the selectors orders runs to implement them.
const SELECTOR_MODULE = /(?:^|\/)packages\/shared\/src\/orchestrationV2ThreadError\.ts$/u;
const TEST_FILE = /\.(?:test|spec|testkit|browser\.test)\.tsx?$|\/test(?:kit|Fixtures)?\//u;
// Calls that keep each element a run, so an order taken after them still orders runs.
const RUN_PRESERVING_METHODS = new Set([
  "filter",
  "toSorted",
  "sort",
  "slice",
  "toReversed",
  "reverse",
]);
// Calls whose elements are built from runs: ordering or picking among them still orders runs.
const RUN_DERIVING_METHODS = new Set(["map", "flatMap"]);
const PICK_LAST_METHODS = new Set(["findLast", "findLastIndex"]);
const ORDERING_METHODS = new Set(["toSorted", "sort"]);
const CALLBACK_METHODS = new Set([
  "reduce",
  "filter",
  "some",
  "find",
  "findIndex",
  "every",
  "flatMap",
  "forEach",
  "map",
]);
const RELATIONAL = new Set(["<", ">", "<=", ">="]);

const MESSAGE =
  'Say which runs this orders or picks from: pass the collection through runsByOrigin(runs, "t3") when T3 acts on the result, or runsByOrigin(runs, "any") when it only shows it. A run read back from a provider transcript must never steer T3, and must still be shown.';
const LATEST_RUN_ID_MESSAGE =
  "A thread shell's latestRunId is the run it presents, which can be one read back from a provider transcript. To act on T3's latest run, load it with getThreadRecords and includePresentedRun: \"t3\" (or another T3 selector); if this only shows or passes on the presented run, suppress with the reason.";
// Server code acts on runs; the shell builder itself defines latestRunId.
const SERVER_FILE = /(?:^|\/)apps\/server\/src\//u;
const SHELL_BUILDER = /(?:^|\/)apps\/server\/src\/orchestration-v2\/ProjectionStore\.ts$/u;
const SQL_MESSAGE =
  'This subquery picks one run by order. Add ${runOriginSql(alias, "t3" | "any")} to its conditions so it says whether runs read back from a provider transcript count.';

type Node = ESTree.Node;

function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === "ChainExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression as Node;
  }
  return current;
}

function memberName(node: Node): string | undefined {
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  return node.property.type === "Identifier" ? node.property.name : undefined;
}

/**
 * "undecided" for a bare run collection, "decided" once it went through runsByOrigin, directly or
 * through a variable initialised from it (`decided` holds those names for the file).
 */
/** What the pre-pass learned: variables in scope that hold decided runs, and functions returning them. */
interface Decided {
  readonly variable: (identifier: Node & { readonly name: string }) => boolean;
  readonly functions: ReadonlySet<string>;
}

function runCollection(
  node: Node,
  decided: Decided,
  throughDerived = false,
): "undecided" | "decided" | undefined {
  const expression = unwrap(node);
  // An empty array, or no collection at all, holds no runs to choose among.
  if (
    (expression.type === "ArrayExpression" && expression.elements.length === 0) ||
    (expression.type === "Identifier" && expression.name === "undefined") ||
    (expression.type === "Literal" && expression.value === null)
  ) {
    return "decided";
  }
  if (expression.type === "Identifier") {
    if (decided.variable(expression)) return "decided";
    return RUN_COLLECTION_NAME.test(expression.name) ? "undecided" : undefined;
  }
  if (expression.type === "MemberExpression") {
    const name = memberName(expression);
    return name !== undefined && RUN_COLLECTION_NAME.test(name) ? "undecided" : undefined;
  }
  if (expression.type === "ConditionalExpression" || expression.type === "LogicalExpression") {
    const branches =
      expression.type === "ConditionalExpression"
        ? [expression.consequent, expression.alternate]
        : [expression.left, expression.right];
    const states = branches.map((branch) => runCollection(branch as Node, decided, throughDerived));
    if (states.includes("undecided")) return "undecided";
    return states.every((state) => state === "decided") ? "decided" : undefined;
  }
  if (expression.type === "CallExpression") {
    const callee = unwrap(expression.callee as Node);
    if (
      callee.type === "Identifier" &&
      (callee.name === ORIGIN_SELECTOR || decided.functions.has(callee.name))
    ) {
      return "decided";
    }
    const method = memberName(callee);
    if (
      callee.type === "MemberExpression" &&
      method &&
      (RUN_PRESERVING_METHODS.has(method) || (throughDerived && RUN_DERIVING_METHODS.has(method)))
    ) {
      return runCollection(callee.object as Node, decided, throughDerived);
    }
  }
  return undefined;
}

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "object" && item !== null && typeof item.type === "string") {
        found.push(item as Node);
      }
    }
  }
  return found;
}

function some(node: Node, test: (node: Node) => boolean): boolean {
  if (test(node)) return true;
  return children(node).some((child) => some(child, test));
}

// A run's order: its ordinal or any of its lifecycle times.
const ORDER_FIELDS = new Set([
  "ordinal",
  "requestedAt",
  "startedAt",
  "workStartedAt",
  "completedAt",
]);
const readsOrdinal = (node: Node) =>
  some(node, (child) => {
    const name = memberName(child);
    return name !== undefined && ORDER_FIELDS.has(name);
  });
const DATE_COMPARISONS = new Set([
  "isGreaterThan",
  "isGreaterThanOrEqualTo",
  "isLessThan",
  "isLessThanOrEqualTo",
  "Order",
  "distance",
]);

function calls(node: Node, name: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = unwrap(node.callee as Node);
  return callee.type === "Identifier" && callee.name === name;
}

const callsRunRanAfter = (node: Node) => calls(node, "runRanAfter");

/** Two runs compared by order: a relation or DateTime comparison whose sides both read one, or runRanAfter. */
const comparesRunOrder = (body: Node) =>
  some(body, (node) => {
    if (callsRunRanAfter(node)) return true;
    if (node.type === "BinaryExpression") {
      return (
        RELATIONAL.has(node.operator) &&
        readsOrdinal(node.left as Node) &&
        readsOrdinal(node.right as Node)
      );
    }
    if (node.type !== "CallExpression") return false;
    const name = memberName(unwrap(node.callee as Node));
    const args = node.arguments as Node[];
    return (
      name !== undefined &&
      DATE_COMPARISONS.has(name) &&
      args.length >= 2 &&
      args.slice(0, 2).every((arg) => readsOrdinal(arg))
    );
  });

const isMinusOne = (node: Node | undefined) =>
  node !== undefined &&
  node.type === "UnaryExpression" &&
  node.operator === "-" &&
  node.argument.type === "Literal" &&
  node.argument.value === 1;

const RUNS_FROM = /\bFROM\s+orchestration_v2_projection_runs\b/gu;
const ORIGIN_MARK = "\u0000ORIGIN\u0000";

/**
 * Whether a SELECT over the runs table, at its own nesting level, orders and keeps one row without
 * an origin mark. Clauses inside nested parentheses belong to subqueries and are skipped.
 */
function picksRunWithoutOrigin(text: string): boolean {
  for (const match of text.matchAll(RUNS_FROM)) {
    let depth = 0;
    let ordered = false;
    let marked = false;
    for (let index = match.index; index < text.length; index++) {
      const char = text[index];
      if (char === "(") depth++;
      else if (char === ")" && --depth < 0) break;
      if (depth !== 0) continue;
      const rest = text.slice(index, index + 16);
      if (rest.startsWith(ORIGIN_MARK)) marked = true;
      else if (/^UNION\b/u.test(rest)) break;
      else if (/^ORDER\s+BY\b/u.test(rest)) ordered = true;
      else if (/^LIMIT\s+1\b/u.test(rest)) {
        if (ordered && !marked) return true;
        break;
      }
    }
  }
  return false;
}

// A property that names a run, other than the latest run itself, which is the same value passed on.
const RUN_ID_KEY = /^(?:runId|runIds|\w+RunId|\w+RunIds)$/u;

/**
 * Whether a `latestRunId` read picks or matches a run: compared with an id, or passed as a run id
 * (a `runId` or `*RunId` property, or an element of a `runIds` list). The value is followed up
 * through the nullable-id idioms, `x === null ? [] : [x]` and `x ?? undefined`, to where it lands.
 */
function selectsRunById(read: Node): boolean {
  const parentOf = (node: Node) => (node as { parent?: Node | null }).parent ?? undefined;
  let node: Node = read;
  let parent = parentOf(node);
  while (parent !== undefined) {
    const carries =
      parent.type === "ChainExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "ArrayExpression" ||
      parent.type === "LogicalExpression" ||
      (parent.type === "ConditionalExpression" && parent.test !== node);
    if (!carries) break;
    node = parent;
    parent = parentOf(node);
  }
  if (parent === undefined) return false;
  if (
    parent.type === "BinaryExpression" &&
    (parent.operator === "===" || parent.operator === "!==")
  ) {
    const other = unwrap((parent.left === node ? parent.right : parent.left) as Node);
    const name = other.type === "Identifier" ? other.name : memberName(other);
    return name !== undefined && (name === "id" || RUN_ID_KEY.test(name));
  }
  if (parent.type !== "Property" || parent.key.type !== "Identifier") return false;
  return parent.key.name !== "latestRunId" && RUN_ID_KEY.test(parent.key.name);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every ordering of runs, and every pick of a latest run, to say whether runs read back from a provider transcript count.",
    },
  },
  create(context) {
    if (TEST_FILE.test(context.filename) || SELECTOR_MODULE.test(context.filename)) return {};
    const checksLatestRunId =
      SERVER_FILE.test(context.filename) && !SHELL_BUILDER.test(context.filename);
    // A variable is decided where its declaring block (or function) encloses the use; the
    // shadowing of a name by an inner declaration is not modelled.
    const scopes = new Map<Node, Set<string>>();
    const functions = new Set<string>();
    const decided: Decided = {
      functions,
      variable: (identifier) => {
        // The root's parent is null.
        for (
          let ancestor = (identifier as { parent?: Node | null }).parent;
          ancestor != null;
          ancestor = (ancestor as { parent?: Node | null }).parent
        ) {
          if (scopes.get(ancestor)?.has(identifier.name) === true) return true;
        }
        return false;
      },
    };
    const isScope = (node: Node) =>
      node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock";
    const isFunction = (node: Node) =>
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    // Every return of a function, outside the functions nested in it.
    const returnsOf = (body: Node): Node[] => {
      const found: Node[] = [];
      const visit = (node: Node) => {
        if (node.type === "ReturnStatement") {
          if (node.argument != null) found.push(node.argument as Node);
          return;
        }
        if (isFunction(node)) return;
        for (const child of children(node)) visit(child);
      };
      for (const child of children(body)) visit(child);
      return found;
    };
    let learned = true;
    const collectDecided = (node: Node, scope: Node) => {
      const inner = isScope(node) ? node : scope;
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init != null &&
        runCollection(node.init as Node, decided) === "decided"
      ) {
        const names = scopes.get(scope) ?? new Set<string>();
        if (!names.has(node.id.name)) {
          names.add(node.id.name);
          scopes.set(scope, names);
          learned = true;
        }
      }
      if (node.type === "FunctionDeclaration" && node.id != null && node.body != null) {
        const returns = returnsOf(node.body as Node);
        if (
          !functions.has(node.id.name) &&
          returns.length > 0 &&
          returns.every((value) => runCollection(value, decided) === "decided")
        ) {
          functions.add(node.id.name);
          learned = true;
        }
      }
      for (const child of children(node)) collectDecided(child, inner);
    };
    return {
      // Runs first, so a variable is known to be decided wherever it is used.
      Program(node) {
        // Repeats until nothing new is learned: a function can return a variable, and the reverse.
        while (learned) {
          learned = false;
          collectDecided(node as Node, node as Node);
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee as Node);
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        if (method === undefined) return;
        const [first] = node.arguments as Node[];
        const picksLast = PICK_LAST_METHODS.has(method) || (method === "at" && isMinusOne(first));
        const orders =
          ORDERING_METHODS.has(method) &&
          first !== undefined &&
          (readsOrdinal(first) || comparesRunOrder(first));
        // Ordering or picking reaches through map and flatMap; a callback compares only runs.
        const state = runCollection(callee.object as Node, decided, picksLast || orders);
        if (state !== "undecided") return;
        const comparesInCallback =
          CALLBACK_METHODS.has(method) &&
          first !== undefined &&
          (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") &&
          comparesRunOrder(first.body as Node);
        if (picksLast || orders || comparesInCallback) context.report({ node, message: MESSAGE });
      },
      MemberExpression(node) {
        if (checksLatestRunId && memberName(node as Node) === "latestRunId") {
          if (selectsRunById(node as Node)) {
            context.report({ node, message: LATEST_RUN_ID_MESSAGE });
          }
          return;
        }
        // runs[runs.length - 1]
        if (!node.computed || runCollection(node.object as Node, decided) !== "undecided") return;
        const index = unwrap(node.property as Node);
        if (
          index.type === "BinaryExpression" &&
          index.operator === "-" &&
          memberName(unwrap(index.left as Node)) === "length"
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
      ForOfStatement(node) {
        if (runCollection(node.right as Node, decided) !== "undecided") return;
        if (comparesRunOrder(node.body as Node)) context.report({ node, message: MESSAGE });
      },
      TaggedTemplateExpression(node) {
        const tag = unwrap(node.tag as Node);
        if (tag.type !== "Identifier" || tag.name !== "sql") return;
        const { quasis, expressions } = node.quasi;
        // Placeholders mark where each interpolation sits, so a subquery can be matched with its own.
        let text = "";
        quasis.forEach((quasi, index) => {
          text += quasi.value.raw;
          const expression = expressions[index] as Node | undefined;
          if (expression === undefined) return;
          const marks = calls(unwrap(expression), SQL_ORIGIN_SELECTOR);
          text += marks ? "\u0000ORIGIN\u0000" : "\u0000VALUE\u0000";
        });
        if (picksRunWithoutOrigin(text)) context.report({ node, message: SQL_MESSAGE });
      },
    };
  },
});
