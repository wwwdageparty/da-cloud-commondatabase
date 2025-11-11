

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    G_CTX = ctx

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/api") {
      return await handleApi(request, env);
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

async function handleApiRequest(action, payload) {
  const db = G_DB;
  if (payload.table_name && payload.table_name !== "") {
    G_tableName = payload.table_name;
  }

  const keys = Object.keys(payload).filter(key => key !== "table_name");
  const invalidKeys = keys.filter(key => !allowedColumns.includes(key));
  if (invalidKeys.length > 0) {
    await errDelegate(`Invalid columns in payload: ${invalidKeys.join(", ")}`);
    return { error: `Invalid columns: ${invalidKeys.join(", ")}` };
  }

  try {
    switch (action) {
      case "post": {
        const placeholders = keys.map(() => "?").join(",");
        const sql = `INSERT INTO ${G_tableName} (${keys.join(",")}) VALUES (${placeholders})`;
        const values = keys.map(k => payload[k]);
        await db.prepare(sql).bind(...values).run();
        return null; // ✅ success
      }

      case "put": {
        if (!payload.id) {
          await errDelegate("Missing 'id' for update");
          return { error: "Missing 'id' for update" };
        }
        if (keys.length === 0) {
          await errDelegate("No fields to update");
          return { error: "No fields to update" };
        }

        const { id, ...fields } = payload;
        const setClause = keys.map(k => `${k} = ?`).join(", ");
        const sql = `UPDATE ${G_tableName} SET ${setClause}, v2 = CURRENT_TIMESTAMP WHERE id = ?`;
        const values = [...keys.map(k => fields[k]), id];
        await db.prepare(sql).bind(...values).run();
        return null;
      }

      case "get": {
        let sql = `SELECT * FROM ${G_tableName}`;
        let values = [];
        if (keys.length > 0) {
          const where = keys.map(k => `${k} = ?`).join(" AND ");
          sql += ` WHERE ${where}`;
          values = keys.map(k => payload[k]);
        }
        const stmt = db.prepare(sql).bind(...values);
        const rows = await stmt.all();
        if (!rows.results || rows.results.length === 0) {
          await errDelegate(`No data found in ${G_tableName}`);
          return { error: "No data found" };
        }
        return null;
      }

      case "delete": {
        if (keys.length === 0) {
          await errDelegate("No condition provided for delete");
          return { error: "Need at least one condition to delete" };
        }
        const where = keys.map(k => `${k} = ?`).join(" AND ");
        const sql = `DELETE FROM ${G_tableName} WHERE ${where}`;
        const values = keys.map(k => payload[k]);
        await db.prepare(sql).bind(...values).run();
        return null;
      }

      default:
        await errDelegate(`Unknown action: ${action}`);
        return { error: "Unknown action" };
    }
  } catch (err) {
    await errDelegate(`DB operation failed: ${err.message}`);
    return { error: err.message };
  }
}


async function handleApi(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return nack("unknown", "UNAUTHORIZED", "Missing or invalid Authorization header");
  }

  const token = auth.split(" ")[1];
  if (token !== env.DA_WRITETOKEN) {
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
    return nack(requestId, "INVALID_FIELD", "Missing required field: payload");
  }
  const action = body.action || "";

  G_ENV = env;
  G_DB = env.DB;

  try {
    const ret = await handleApiRequest(action, body.payload);
    
    if (ret == null) {
      return ack(requestId);
    } else {
      return nack(requestId, "REQUEST_FAILED", JSON.stringify(ret, null, 2)); 
    }

  } catch (err) {
    await errDelegate(`handleApiRequest exception: ${err.message}`);
    return nack(requestId, "DB_ERROR", err.message);
  }
}

// ---------- HELPERS ----------
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
    headers: { "Content-Type": "application/json" }
  });
}

// ---------- LOGGING ----------
async function errDelegate(msg) {
  console.error(msg);
  G_CTX.waitUntil(postLogToGateway("11", 11, `❌ *Error*\n${msg}`));
}
async function postLogToGateway(request_id, level, message) {
  const url = C_LogServiceUrl;
  const body = {
    version: "v1",
    request_id,
    service: "log",
    action: "append",
    payload: {
      service: C_ServiceID,
      instance: C_InstanceID,
      level,
      message
    }
  };

  try {
    const resp1 = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${C_LogServiceToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await resp1.text();
    console.log("Log service response:", text);

  } catch (err) {
    console.error("❌ Error posting log:", err.message);
  }
}


let G_ENV = null;
let G_DB = null;
let G_CTX = null;
let G_tableName = "data1";
const allowedColumns = [
  "c1", "c2", "c3", "i1", "i2", "i3", "d1", "d2", "d3", "t1", "t2", "t3", "v1", "v2", "v3"
];
