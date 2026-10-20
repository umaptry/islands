import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Guards against reading a column the browser is not allowed to select. Postgres
// answers with 42501 "permission denied for table posts" even when the column is
// only used in a filter or an order (the deleted_at filter on posts did exactly that).

const read = (url) => readFile(new URL(url, import.meta.url), 'utf8');
const net = await read('../../web/js/net.js');

// ---- what net.js asks for -------------------------------------------------

/** The text between a bracket and its match; quotes are skipped. */
function balanced(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if ('\'"`'.includes(ch)) quote = ch;
    else if (ch === '{' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced bracket');
}

/** Split at commas that are not inside brackets or quotes. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if ('\'"`'.includes(ch)) quote = ch;
    else if ('{(['.includes(ch)) depth += 1;
    else if ('})]'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const constant = (name) => {
  const match = net.match(new RegExp(`const ${name}\\s*=\\s*((?:'[^']*'\\s*\\+?\\s*)+);`));
  assert.ok(match, `const ${name} not found in net.js`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
};
const EXTRA_COLUMNS = ['prompt', 'recruit_deadline', 'recruit_capacity'];
const substitutions = {
  // The widest form, as sent when features.post_extras is on.
  'postColumns()': `${constant('POST_COLUMNS')},${EXTRA_COLUMNS.join(',')}`,
  ACCOUNT_EMBED: constant('ACCOUNT_EMBED'),
  POST_AUTHOR_EMBED: constant('POST_AUTHOR_EMBED'),
};

/** A select/order value with ${...} filled in. */
function resolve(value) {
  const inner = value.replace(/^[`']|[`']$/g, '');
  return inner.replace(/\$\{([^}]*)\}/g, (_, name) => {
    assert.ok(name in substitutions, `unknown template ${name} in a select`);
    return substitutions[name];
  });
}

/** Every column a GET to the REST API selects, filters by or sorts by. */
function usedColumns() {
  const used = [];
  for (const call of net.matchAll(/restCall\(\s*'([a-z_]+)'\s*,\s*\{/g)) {
    const table = call[1];
    const options = balanced(net, call.index + call[0].length - 1);
    if (/method:\s*'(POST|PATCH|DELETE)'/.test(options)) continue;
    const paramsAt = options.search(/params:\s*\{/);
    if (paramsAt < 0) continue;
    const params = balanced(options, options.indexOf('{', paramsAt));
    for (const entry of splitTop(params)) {
      const at = entry.indexOf(':');
      const key = entry.slice(0, at).trim();
      const value = entry.slice(at + 1).trim();
      if (key === 'select') {
        for (const item of splitTop(resolve(value))) {
          const embed = item.match(/^([a-z_]+)(?:![a-z_]+)?\((.*)\)$/);
          if (embed) used.push({ table: embed[1], columns: embed[2].split(','), where: `${table} select` });
          else used.push({ table, columns: [item], where: `${table} select` });
        }
      } else if (key === 'order') {
        const columns = resolve(value).split(',').map((term) => term.split('.')[0]);
        used.push({ table, columns, where: `${table} order` });
      } else if (!['limit', 'offset', 'or', 'and', 'not'].includes(key)) {
        used.push({ table, columns: [key], where: `${table} filter` });
      }
    }
  }
  return used;
}

// ---- what the database grants ---------------------------------------------

const names = (list) => list.split(',').map((name) => name.trim().replace(/^public\./, '')).filter(Boolean);

/** table -> Set of granted columns, or 'all'; statements are applied in file order. */
function grantsOf(sqlFiles) {
  const grants = new Map();
  for (const sql of sqlFiles) {
    const text = sql.replace(/--.*$/gm, '');
    for (const statement of text.split(';')) {
      const s = statement.replace(/\s+/g, ' ').trim();
      let m = s.match(/^revoke (?:all|select)(?: privileges)?(?:, \w+)* on (?:table )?(public\.[\w., ]+?) from /i);
      if (m && !/^revoke select \(/i.test(s)) {
        for (const table of names(m[1])) grants.delete(table);
        continue;
      }
      m = s.match(/^grant select on (?:table )?(public\.\w+(?:, public\.\w+)*) to /i);
      if (m) {
        for (const table of names(m[1])) grants.set(table, 'all');
        continue;
      }
      m = s.match(/^grant select \(([^)]*)\) on public\.(\w+) to /i);
      if (m) {
        const [, columns, table] = m;
        if (grants.get(table) === 'all') continue;
        const set = grants.get(table) || new Set();
        for (const column of names(columns)) set.add(column);
        grants.set(table, set);
      }
    }
  }
  return grants;
}

const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationDir)).filter((f) => f.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map((f) => readFile(new URL(f, migrationDir), 'utf8')));
const fromMigrations = grantsOf(migrations);
const fromSchema = grantsOf([await read('../../supabase/schema.sql')]);

function missing(grants, skip = () => false) {
  const problems = [];
  for (const { table, columns, where } of usedColumns()) {
    const granted = grants.get(table);
    if (granted === 'all') continue;
    for (const column of columns) {
      if (skip(column)) continue;
      if (column === '*') problems.push(`${where}: * on ${table} needs a table-wide grant`);
      else if (!granted?.has(column)) problems.push(`${where}: ${table}.${column} is not granted`);
    }
  }
  return problems;
}

test('the parser sees the post reads in net.js', () => {
  const used = usedColumns();
  const has = (table, column, where) =>
    used.some((u) => u.table === table && u.columns.includes(column) && u.where === where);
  assert.ok(has('posts', 'body', 'posts select'));
  assert.ok(has('posts', 'recruit_capacity', 'posts select'));
  assert.ok(has('posts', 'author_id', 'posts filter'));
  assert.ok(has('posts', 'created_at', 'posts order'));
  assert.ok(has('accounts', 'avatar_path', 'posts select'), 'embedded accounts columns');
});

test('the grant parser ends with the latest state of posts and accounts', () => {
  const posts = fromMigrations.get('posts');
  assert.ok(posts.has('prompt') && posts.has('body'));
  for (const hidden of ['deleted_at', 'vec', 'vec_c']) assert.ok(!posts.has(hidden), hidden);
  const accounts = fromMigrations.get('accounts');
  assert.ok(accounts instanceof Set && accounts.has('display_name'), 'accounts is column-granted after the revoke');
});

test('every column net.js reads is granted by the migrations (latest state)', () => {
  assert.deepEqual(missing(fromMigrations), []);
});

test('the same holds for schema.sql, apart from the columns added by later migrations', () => {
  assert.deepEqual(missing(fromSchema, (column) => EXTRA_COLUMNS.includes(column)), []);
});

test('net.js never uses deleted_at on posts', () => {
  const bad = usedColumns().filter((u) => u.table === 'posts' && u.columns.includes('deleted_at'));
  assert.deepEqual(bad, []);
});
