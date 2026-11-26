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
function runCollection(
  node: Node,
  decided: ReadonlySet<string>,
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
    if (decided.has(expression.name)) return "decided";
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
    const states = branches.map((branch) => runCollection(branch as Node, decided));
    if (states.includes("undecided")) return "undecided";
    return states.every((state) => state === "decided") ? "decided" : undefined;
  }
  if (expression.type === "CallExpression") {
    const callee = unwrap(expression.callee as Node);
    if (callee.type === "Identifier" && callee.name === ORIGIN_SELECTOR) return "decided";
    const method = memberName(callee);
    if (callee.type === "MemberExpression" && method && RUN_PRESERVING_METHODS.has(method)) {
      return runCollection(callee.object as Node, decided);
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

const readsOrdinal = (node: Node) => some(node, (child) => memberName(child) === "ordinal");

function calls(node: Node, name: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = unwrap(node.callee as Node);
  return callee.type === "Identifier" && callee.name === name;
}

const callsRunRanAfter = (node: Node) => calls(node, "runRanAfter");

/** Two runs compared by order: both sides of a relation read an ordinal, or runRanAfter. */
const comparesRunOrder = (body: Node) =>
  some(
    body,
    (node) =>
      callsRunRanAfter(node) ||
      (node.type === "BinaryExpression" &&
        RELATIONAL.has(node.operator) &&
        readsOrdinal(node.left as Node) &&
        readsOrdinal(node.right as Node)),
  );

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
    const decided = new Set<string>();
    const collectDecided = (node: Node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init != null &&
        runCollection(node.init as Node, decided) === "decided"
      ) {
        decided.add(node.id.name);
      }
      for (const child of children(node)) collectDecided(child);
    };
    return {
      // Runs first, so a variable is known to be decided wherever it is used.
      Program(node) {
        collectDecided(node as Node);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee as Node);
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        if (method === undefined) return;
        if (runCollection(callee.object as Node, decided) !== "undecided") return;
        const [first] = node.arguments as Node[];
        const picksLast = PICK_LAST_METHODS.has(method) || (method === "at" && isMinusOne(first));
        const orders =
          ORDERING_METHODS.has(method) &&
          first !== undefined &&
          (readsOrdinal(first) || comparesRunOrder(first));
        const comparesInCallback =
          CALLBACK_METHODS.has(method) &&
          first !== undefined &&
          (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") &&
          comparesRunOrder(first.body as Node);
        if (picksLast || orders || comparesInCallback) context.report({ node, message: MESSAGE });
      },
      MemberExpression(node) {
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
