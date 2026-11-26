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

/** "undecided" for a bare run collection, "decided" once it went through runsByOrigin. */
function runCollection(node: Node): "undecided" | "decided" | undefined {
  const expression = unwrap(node);
  if (expression.type === "Identifier") {
    return RUN_COLLECTION_NAME.test(expression.name) ? "undecided" : undefined;
  }
  if (expression.type === "MemberExpression") {
    const name = memberName(expression);
    return name !== undefined && RUN_COLLECTION_NAME.test(name) ? "undecided" : undefined;
  }
  if (expression.type === "CallExpression") {
    const callee = unwrap(expression.callee as Node);
    if (callee.type === "Identifier" && callee.name === ORIGIN_SELECTOR) return "decided";
    const method = memberName(callee);
    if (callee.type === "MemberExpression" && method && RUN_PRESERVING_METHODS.has(method)) {
      return runCollection(callee.object as Node);
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
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee as Node);
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        if (method === undefined) return;
        if (runCollection(callee.object as Node) !== "undecided") return;
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
        if (!node.computed || runCollection(node.object as Node) !== "undecided") return;
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
        if (runCollection(node.right as Node) !== "undecided") return;
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
        const subqueries = text.split(/(?=FROM\s+orchestration_v2_projection_runs\b)/u).slice(1);
        for (const subquery of subqueries) {
          const end = subquery.search(/\bLIMIT\s+1\b/u);
          if (end === -1) continue;
          const scope = subquery.slice(0, end);
          if (!/\bORDER\s+BY\b/u.test(scope) || scope.includes("\u0000ORIGIN\u0000")) continue;
          context.report({ node, message: SQL_MESSAGE });
          return;
        }
      },
    };
  },
});
