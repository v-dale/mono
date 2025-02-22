import {assert} from '../../../shared/src/asserts.js';
import type {JSONValue} from '../../../shared/src/json.js';
import {must} from '../../../shared/src/must.js';
import type {
  AST,
  ColumnReference,
  CompoundKey,
  Condition,
  Conjunction,
  CorrelatedSubquery,
  CorrelatedSubqueryCondition,
  Disjunction,
  LiteralValue,
  Ordering,
  Parameter,
  SimpleCondition,
  ValuePosition,
} from '../../../zero-protocol/src/ast.js';
import type {Row} from '../../../zero-protocol/src/data.js';
import type {PrimaryKey} from '../../../zero-protocol/src/primary-key.js';
import {Exists} from '../ivm/exists.js';
import {FanIn} from '../ivm/fan-in.js';
import {FanOut} from '../ivm/fan-out.js';
import {Filter} from '../ivm/filter.js';
import {Join} from '../ivm/join.js';
import type {Input, Storage} from '../ivm/operator.js';
import {Skip} from '../ivm/skip.js';
import type {Source} from '../ivm/source.js';
import {Take} from '../ivm/take.js';
import {createPredicate, type NoSubqueryCondition} from './filter.js';

export type StaticQueryParameters = {
  authData: Record<string, JSONValue>;
  preMutationRow?: Row | undefined;
};

/**
 * Interface required of caller to buildPipeline. Connects to constructed
 * pipeline to delegate environment to provide sources and storage.
 */
export interface BuilderDelegate {
  /**
   * Called once for each source needed by the AST.
   * Might be called multiple times with same tableName. It is OK to return
   * same storage instance in that case.
   */
  getSource(tableName: string): Source | undefined;

  /**
   * Called once for each operator that requires storage. Should return a new
   * unique storage object for each call.
   */
  createStorage(): Storage;
}

/**
 * Builds a pipeline from an AST. Caller must provide a delegate to create source
 * and storage interfaces as necessary.
 *
 * Usage:
 *
 * ```ts
 * class MySink implements Output {
 *   readonly #input: Input;
 *
 *   constructor(input: Input) {
 *     this.#input = input;
 *     input.setOutput(this);
 *   }
 *
 *   push(change: Change, _: Operator) {
 *     console.log(change);
 *   }
 * }
 *
 * const input = buildPipeline(ast, myDelegate);
 * const sink = new MySink(input);
 * ```
 */
export function buildPipeline(ast: AST, delegate: BuilderDelegate): Input {
  return buildPipelineInternal(ast, delegate);
}

export function bindStaticParameters(
  ast: AST,
  staticQueryParameters: StaticQueryParameters | undefined,
) {
  const visit = (node: AST): AST => ({
    ...node,
    where: node.where ? bindCondition(node.where) : undefined,
    related: node.related?.map(sq => ({
      ...sq,
      subquery: visit(sq.subquery),
    })),
  });

  function bindCondition(condition: Condition): Condition {
    if (condition.type === 'simple') {
      return {
        ...condition,
        left: bindValue(condition.left),
        right: bindValue(condition.right) as Exclude<
          ValuePosition,
          ColumnReference
        >,
      };
    }
    if (condition.type === 'correlatedSubquery') {
      return {
        ...condition,
        related: {
          ...condition.related,
          subquery: visit(condition.related.subquery),
        },
      };
    }
    return {
      ...condition,
      conditions: condition.conditions.map(bindCondition),
    };
  }

  const bindValue = (value: ValuePosition): ValuePosition => {
    if (isParameter(value)) {
      const anchor = must(
        staticQueryParameters,
        'Static query params do not exist',
      )[value.anchor];
      const resolvedValue = resolveField(anchor, value.field);
      return {
        type: 'literal',
        value: resolvedValue as LiteralValue,
      };
    }
    return value;
  };

  return visit(ast);
}

function resolveField(
  anchor: Record<string, JSONValue> | Row | undefined,
  field: string | string[],
): unknown {
  if (anchor === undefined) {
    return null;
  }

  if (Array.isArray(field)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return field.reduce((acc, f) => (acc as any)?.[f], anchor) ?? null;
  }

  return anchor[field] ?? null;
}

function isParameter(value: ValuePosition): value is Parameter {
  return value.type === 'static';
}

function buildPipelineInternal(
  ast: AST,
  delegate: BuilderDelegate,
  partitionKey?: CompoundKey | undefined,
): Input {
  const source = delegate.getSource(ast.table);
  if (!source) {
    throw new Error(`Source not found: ${ast.table}`);
  }
  const conn = source.connect(must(ast.orderBy), ast.where);
  let end: Input = conn;
  const {fullyAppliedFilters} = conn;
  ast = uniquifyCorrelatedSubqueryConditionAliases(ast);

  if (ast.start) {
    end = new Skip(end, ast.start);
  }

  for (const csq of gatherCorrelatedSubqueryQueriesFromCondition(ast.where)) {
    end = applyCorrelatedSubQuery(csq, delegate, end);
  }

  if (ast.where && !fullyAppliedFilters) {
    end = applyWhere(end, ast.where, delegate);
  }

  if (ast.limit) {
    end = new Take(end, delegate.createStorage(), ast.limit, partitionKey);
  }

  if (ast.related) {
    for (const csq of ast.related) {
      end = applyCorrelatedSubQuery(csq, delegate, end);
    }
  }

  return end;
}

function applyWhere(
  input: Input,
  condition: Condition,
  delegate: BuilderDelegate,
): Input {
  switch (condition.type) {
    case 'and':
      return applyAnd(input, condition, delegate);
    case 'or':
      return applyOr(input, condition, delegate);
    case 'correlatedSubquery':
      return applyCorrelatedSubqueryCondition(input, condition, delegate);
    case 'simple':
      return applySimpleCondition(input, condition);
  }
}

function applyAnd(
  input: Input,
  condition: Conjunction,
  delegate: BuilderDelegate,
) {
  for (const subCondition of condition.conditions) {
    input = applyWhere(input, subCondition, delegate);
  }
  return input;
}

export function applyOr(
  input: Input,
  condition: Disjunction,
  delegate: BuilderDelegate,
): Input {
  const [subqueryConditions, otherConditions] =
    groupSubqueryConditions(condition);
  // if there are no subquery conditions, no fan-in / fan-out is needed
  if (subqueryConditions.length === 0) {
    return new Filter(
      input,
      createPredicate({
        type: 'or',
        conditions: otherConditions,
      }),
    );
  }

  const fanOut = new FanOut(input);
  const branches = subqueryConditions.map(subCondition =>
    applyWhere(fanOut, subCondition, delegate),
  );
  if (otherConditions.length > 0) {
    branches.push(
      new Filter(
        fanOut,
        createPredicate({
          type: 'or',
          conditions: otherConditions,
        }),
      ),
    );
  }
  return new FanIn(fanOut, branches);
}

export function groupSubqueryConditions(condition: Disjunction) {
  const partitioned: [
    subqueryConditions: Condition[],
    otherConditions: NoSubqueryCondition[],
  ] = [[], []];
  for (const subCondition of condition.conditions) {
    if (isNotAndDoesNotContainSubquery(subCondition)) {
      partitioned[1].push(subCondition);
    } else {
      partitioned[0].push(subCondition);
    }
  }
  return partitioned;
}

export function isNotAndDoesNotContainSubquery(
  condition: Condition,
): condition is NoSubqueryCondition {
  if (condition.type === 'correlatedSubquery') {
    return false;
  }
  if (condition.type === 'and') {
    return condition.conditions.every(isNotAndDoesNotContainSubquery);
  }
  assert(condition.type !== 'or', 'where conditions are expected to be in DNF');
  return true;
}

function applySimpleCondition(input: Input, condition: SimpleCondition): Input {
  return new Filter(input, createPredicate(condition));
}

function applyCorrelatedSubQuery(
  sq: CorrelatedSubquery,
  delegate: BuilderDelegate,
  end: Input,
) {
  assert(sq.subquery.alias, 'Subquery must have an alias');
  const child = buildPipelineInternal(
    sq.subquery,
    delegate,
    sq.correlation.childField,
  );
  end = new Join({
    parent: end,
    child,
    storage: delegate.createStorage(),
    parentKey: sq.correlation.parentField,
    childKey: sq.correlation.childField,
    relationshipName: sq.subquery.alias,
    hidden: sq.hidden ?? false,
    system: sq.system ?? 'client',
  });
  return end;
}

function applyCorrelatedSubqueryCondition(
  input: Input,
  condition: CorrelatedSubqueryCondition,
  delegate: BuilderDelegate,
): Input {
  assert(condition.op === 'EXISTS' || condition.op === 'NOT EXISTS');
  return new Exists(
    input,
    delegate.createStorage(),
    must(condition.related.subquery.alias),
    condition.related.correlation.parentField,
    condition.op,
  );
}

function gatherCorrelatedSubqueryQueriesFromCondition(
  condition: Condition | undefined,
) {
  const csqs: CorrelatedSubquery[] = [];
  const gather = (condition: Condition) => {
    if (condition.type === 'correlatedSubquery') {
      assert(condition.op === 'EXISTS' || condition.op === 'NOT EXISTS');
      csqs.push({
        ...condition.related,
        subquery: {
          ...condition.related.subquery,
          limit:
            condition.related.system === 'permissions'
              ? PERMISSIONS_EXISTS_LIMIT
              : EXISTS_LIMIT,
        },
      });
      return;
    }
    if (condition.type === 'and' || condition.type === 'or') {
      for (const c of condition.conditions) {
        gather(c);
      }
      return;
    }
  };
  if (condition) {
    gather(condition);
  }
  return csqs;
}

const EXISTS_LIMIT = 3;
const PERMISSIONS_EXISTS_LIMIT = 1;

export function assertOrderingIncludesPK(
  ordering: Ordering,
  pk: PrimaryKey,
): void {
  const orderingFields = ordering.map(([field]) => field);
  const missingFields = pk.filter(pkField => !orderingFields.includes(pkField));

  if (missingFields.length > 0) {
    throw new Error(
      `Ordering must include all primary key fields. Missing: ${missingFields.join(
        ', ',
      )}. ZQL automatically appends primary key fields to the ordering if they are missing 
      so a common cause of this error is a casing mismatch between Postgres and ZQL.
      E.g., "userid" vs "userID".
      You may want to add double-quotes around your Postgres column names to prevent Postgres from lower-casing them:
      https://www.postgresql.org/docs/current/sql-syntax-lexical.htm`,
    );
  }
}
function uniquifyCorrelatedSubqueryConditionAliases(ast: AST): AST {
  if (!ast.where) {
    return ast;
  }
  const {where} = ast;
  if (where.type !== 'and' && where.type !== 'or') {
    return ast;
  }
  let count = 0;

  const uniquifyCorrelatedSubquery = (csqc: CorrelatedSubqueryCondition) => ({
    ...csqc,
    related: {
      ...csqc.related,
      subquery: {
        ...csqc.related.subquery,
        alias: (csqc.related.subquery.alias ?? '') + '_' + count++,
      },
    },
  });

  const uniquifyAnd = (and: Conjunction) => {
    const conds = [];
    for (const cond of and.conditions) {
      if (cond.type === 'correlatedSubquery') {
        conds.push(uniquifyCorrelatedSubquery(cond));
      } else {
        conds.push(cond);
      }
    }
    return {
      ...and,
      conditions: conds,
    };
  };
  if (where.type === 'and') {
    return {
      ...ast,
      where: uniquifyAnd(where),
    };
  }
  // or
  const conds = [];
  for (const cond of where.conditions) {
    if (cond.type === 'simple') {
      conds.push(cond);
    } else if (cond.type === 'correlatedSubquery') {
      conds.push(uniquifyCorrelatedSubquery(cond));
    } else if (cond.type === 'and') {
      conds.push(uniquifyAnd(cond));
    }
  }
  return {
    ...ast,
    where: {
      ...where,
      conditions: conds,
    },
  };
}
