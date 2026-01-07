// ================== Cloudflare Worker ==================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    G_CTX = ctx;

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/api") {
      return await handleApi(request, env);
    } else if (url.pathname === "/meta") {
      return handleMeta(env);
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

// ================== Core API ==================
async function handleApiRequest(action, payload, db, ctx) {
  // const db = G_DB;
  const tableName = resolveTableName(payload);

  if (!tableName) {
    await errDelegate("Invalid or missing table_name");
    return { error: "Invalid or missing table_name" };
  }

  try {
    switch (action) {
      // ---------- EXEC (God Mode) ----------
      case "exec": {
        const { query, params } = payload;

        if (!query) {
          return { error: "Missing SQL query" };
        }

        // Safety: Block destructive commands if they target system tables
        const lowerQuery = query.toLowerCase().trim();
        if (lowerQuery.includes("sqlite_master") || lowerQuery.includes("_cf_")) {
          return { error: "Access to system tables via EXEC is forbidden." };
        }

        try {
          const stmt = db.prepare(query);
          
          // Use .bind() if parameters are provided, otherwise just run/all
          const result = params && Array.isArray(params) 
            ? await stmt.bind(...params).all() 
            : await stmt.all();

          return { 
            success: true, 
            results: result.results || [],
            meta: result.meta // Contains rows_read, rows_written, etc.
          };
        } catch (err) {
          return { error: `SQL Execution Error: ${err.message}` };
        }
      }
      // ---------- Create Table ----------
      case "create_table": {
        const c1Unique = !!payload.c1_unique;
        const c1Constraint = c1Unique ? "UNIQUE" : "";
        
        const tableSql = `
          CREATE TABLE IF NOT EXISTS ${tableName} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            c1 VARCHAR(255) ${c1Constraint},
            c2 VARCHAR(255), c3 VARCHAR(255),
            i1 INT, i2 INT, i3 INT,
            d1 DOUBLE, d2 DOUBLE, d3 DOUBLE,
            t1 TEXT, t2 TEXT, t3 TEXT,
            v1 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            v2 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            v3 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;

        const statements = [db.prepare(tableSql)];

        // 1. Index c1 (only if not already UNIQUE, as UNIQUE creates its own index)
        if (!c1Unique) {
          statements.push(
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_${tableName}_c1 ON ${tableName}(c1)`)
          );
        }

        // 2. Index v2 (Always created to speed up "last updated" queries)
        statements.push(
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_${tableName}_v2 ON ${tableName}(v2)`)
        );

        // Execute all in one batch for efficiency
        await db.batch(statements);

        return { 
          message: `Table ${tableName} is ready with indices on ${c1Unique ? 'v2' : 'c1, v2'}.` 
        };
      }

      // ---------- List All Tables ----------
      case "list_tables": {
        // Query sqlite_master for user-created tables
        // Excluding internal SQLite and Cloudflare metadata tables
        const query = `
          SELECT name 
          FROM sqlite_master 
          WHERE type='table' 
            AND name NOT LIKE 'sqlite_%' 
            AND name NOT LIKE '_cf_%'
        `;
        
        const { results } = await db.prepare(query).all();
        const tableNames = results.map(row => row.name);
        
        return { 
          count: tableNames.length,
          tables: tableNames 
        };
      }

      // ---------- Batch Insert ----------
      case "batch_post": {
        const records = payload.data; // Expecting an array of objects
        if (!Array.isArray(records)) return { error: "Payload 'data' must be an array" };

        const statements = records.map(record => {
          const keys = Object.keys(record).filter(k => allowedColumns.includes(k));
          const placeholders = keys.map(() => "?").join(",");
          const sql = `INSERT INTO ${tableName} (${keys.join(",")}) VALUES (${placeholders})`;
          const values = keys.map(k => record[k]);
          return db.prepare(sql).bind(...values);
        });

        const results = await db.batch(statements);
        return { inserted: results.length };
      }

      // ---------- Drop Table (Dangerous/Admin) ----------
      case "drop_table": {
        // Double check resolution and forbidden list
        if (!tableName) return { error: "Invalid table name" };
        
        const sql = `DROP TABLE IF EXISTS ${tableName}`;
        await db.prepare(sql).run();
        
        return { message: `Table ${tableName} has been deleted.` };
      }
      // ---------- Create Index ----------
      case "create_index": {
        const col = payload.column;
        const isUnique = !!payload.unique;

        if (!col || !allowedColumns.includes(col)) {
          return { error: `Invalid or missing column: ${col}` };
        }

        // Standardized naming convention: idx_tablename_column
        const indexName = `idx_${tableName}_${col}`;
        const uniqueStr = isUnique ? "UNIQUE" : "";
        
        const sql = `CREATE ${uniqueStr} INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${col})`;
        
        await db.prepare(sql).run();
        return { message: `Index ${indexName} created.` };
      }
      case "list_indices": {
          const sql = `PRAGMA index_list(${tableName})`;
          const { results } = await db.prepare(sql).all();
          return { indices: results };
        }

      // ---------- Drop Index ----------
      case "drop_index": {
        const col = payload.column;
        if (!col) return { error: "Missing column name to drop index" };

        const indexName = `idx_${tableName}_${col}`;
        const sql = `DROP INDEX IF EXISTS ${indexName}`;
        
        await db.prepare(sql).run();
        return { message: `Index ${indexName} dropped.` };
      }

      // ---------- INSERT ----------
      case "post": {
        const keys = Object.keys(payload).filter(k => k !== "table_name");

        const invalidKeys = keys.filter(k => !allowedColumns.includes(k));
        if (invalidKeys.length > 0) {
          return { error: `Invalid columns: ${invalidKeys.join(", ")}` };
        }

        const placeholders = keys.map(() => "?").join(",");
        const sql = `INSERT INTO ${tableName} (${keys.join(",")}) VALUES (${placeholders})`;
        const values = keys.map(k => payload[k]);

        await db.prepare(sql).bind(...values).run();
        return null;
      }

      // ---------- UPDATE / TOUCH ----------
      case "put": {
        if (!payload.id) {
          return { error: "Missing 'id' for update" };
        }

        const keysPut = Object.keys(payload).filter(
          k => k !== "table_name" && k !== "id"
        );

        const invalidKeys = keysPut.filter(k => !allowedColumns.includes(k));
        if (invalidKeys.length > 0) {
          return { error: `Invalid columns: ${invalidKeys.join(", ")}` };
        }

        let sql;
        let values;

        if (keysPut.length === 0) {
          sql = `UPDATE ${tableName} SET v2 = CURRENT_TIMESTAMP WHERE id = ?`;
          values = [payload.id];
        } else {
          const setClause = keysPut.map(k => `${k} = ?`).join(", ");
          sql = `UPDATE ${tableName} SET ${setClause}, v2 = CURRENT_TIMESTAMP WHERE id = ?`;
          values = [...keysPut.map(k => payload[k]), payload.id];
        }

        const result = await db.prepare(sql).bind(...values).run();
        if (result.changes === 0) {
          return { error: `Record not found: id=${payload.id}` };
        }

        return null;
      }

      // ---------- QUERY ----------
      case "get": {
        const { table_name, ...options } = payload;

        const columnFilters = Object.keys(options).filter(
          k => !allowedQueryOptions.includes(k)
        );

        for (const k of columnFilters) {
          if (!allowedColumns.includes(k)) {
            return { error: `Invalid column in filters: ${k}` };
          }
        }

        let query = `SELECT * FROM ${tableName}`;
        const params = [];
        const conditions = [];

        const order = options.order === "desc" ? "DESC" : "ASC";
        const orderBy = allowedColumns.includes(options.orderby)
          ? options.orderby
          : "id";

        if (options.minId !== undefined && options.offset !== undefined) {
          return { error: "Cannot use both 'minId' and 'offset' together." };
        }

        for (const k of columnFilters) {
          conditions.push(`${k} = ?`);
          params.push(options[k]);
        }

        if (options.offset != null) {
          conditions.push(`${orderBy} ${order === "ASC" ? ">" : "<"} ?`);
          params.push(options.offset);
        } else if (options.minId != null) {
          conditions.push(`${orderBy} ${order === "ASC" ? ">" : "<"} ?`);
          params.push(options.minId);
        }

        if (conditions.length > 0) {
          query += " WHERE " + conditions.join(" AND ");
        }

        query += ` ORDER BY ${orderBy} ${order}`;

        const limit =
          Number.isInteger(options.limit) && options.limit > 0
            ? Math.min(options.limit, 500)
            : 100;

        query += ` LIMIT ${limit}`;

        const result = await db.prepare(query).bind(...params).all();
        return { rows: result.results || [] };
      }

      // ---------- DELETE ----------
      case "delete": {
        const keys = Object.keys(payload).filter(k => k !== "table_name");

        const invalidKeys = keys.filter(k => !allowedColumns.includes(k));
        if (invalidKeys.length > 0) {
          return { error: `Invalid columns: ${invalidKeys.join(", ")}` };
        }

        let sql;
        let values = [];

        if (keys.length === 0) {
          sql = `DELETE FROM ${tableName}`;
          await errDelegate(`DELETE ALL from ${tableName}`);
        } else {
          const where = keys.map(k => `${k} = ?`).join(" AND ");
          sql = `DELETE FROM ${tableName} WHERE ${where}`;
          values = keys.map(k => payload[k]);
        }

        const result = await db.prepare(sql).bind(...values).run();
        return { deleted: result.changes ?? 0 };
      }

      // ---------- CREATE INDEX ----------
      case "index": {
        const col = payload.column;

        if (!col || typeof col !== "string") {
          return { error: "Missing or invalid column for index" };
        }

        if (!allowedColumns.includes(col) || col === "id") {
          return { error: `Index not allowed on column: ${col}` };
        }

        const indexName = `idx_${tableName}__${col}`;
        const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${col})`;

        await db.exec(sql);
        await errDelegate(`INDEX created: ${tableName}.${col}`);

        return { indexed: col };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    await errDelegate(`DB operation failed: ${err.message}`);
    return { error: err.message };
  }
}

// ================== HTTP Wrapper ==================
async function handleApi(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return nack("unknown", "UNAUTHORIZED", "Missing or invalid Authorization header");
  }

  if (auth.split(" ")[1] !== env.DA_WRITE_TOKEN) {
    return nack("unknown", "INVALID_TOKEN", "Token authentication failed");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return nack("unknown", "INVALID_JSON", "Malformed JSON body");
  }

  const requestId = body.request_id || "unknown";
  if (!body.payload) {
    return nack(requestId, "INVALID_FIELD", "Missing payload");
  }
  
  const ret = await handleApiRequest(
    body.action || "", 
    body.payload, 
    env.DB, 
    request // or a custom context object
  );
  if (ret && ret.error) {
    return nack(requestId, "REQUEST_FAILED", ret.error);
  }

  return ack(requestId, ret || {});
}

// ================== META ==================
function handleMeta(env) {
  return jsonResponse({
    service: C_SERVICE,
    version: C_VERSION,
    instance: env.INSTANCEID || G_INSTANCE,
  });
}

// ================== HELPERS ==================
function ack(requestId, payload = {}) {
  return jsonResponse({ type: "ack", request_id: requestId, payload });
}

function nack(requestId, code, message) {
  return jsonResponse(
    { type: "nack", request_id: requestId, payload: { status: "error", code, message } },
    400
  );
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function errDelegate(msg) {
  console.error(msg);
  G_CTX.waitUntil(Promise.resolve());
}

// ================== TABLE SAFETY ==================
const FORBIDDEN_TABLES = new Set([
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
  "sqlite_sequence",
]);

function resolveTableName(payload) {
  if (!payload.table_name || payload.table_name.trim() === "") return null;
  const name = payload.table_name.trim();
  if (FORBIDDEN_TABLES.has(name)) return null;
  return name;
}

// ================== GLOBALS ==================
let G_CTX = null;

const allowedColumns = [
  "id",
  "c1", "c2", "c3",
  "i1", "i2", "i3",
  "d1", "d2", "d3",
  "t1", "t2", "t3",
  "v1", "v2", "v3",
];

const allowedQueryOptions = [
  "minId",
  "offset",
  "order",
  "orderby",
  "limit",
  "table_name",
];

const C_SERVICE = "da-cloud-cfd1-rack";
const C_VERSION = "0.0.1";
let G_INSTANCE = "default";
