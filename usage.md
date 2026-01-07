# 7️ D1 Management Rack API (v0.0.1)

A secure, remote-access API for Cloudflare D1. This "Rack" allows you to manage multiple tables, handle indices, and execute raw SQL through a JSON interface.

---

## 💚 Connection Details
- **Endpoint:** `https://<your-worker>.<your-subdomain>.workers.dev/api`
L 
**Method:** `POST`
- **Header:** `Authorization: Bearer <YOUR_DA_WRITE_TOKEN>`

---

## 🚵 Table & Schema Management

### 1. Create Table
Initializes a new table with the fixed schema and default indices.

```Json
{
  "action": "create_table",
  "payload":{
    "table_name": "sensor_logs",
    "c1_unique": true
  }
}
```

### 2. List All Tables
Discover all tables currently in your D1 instance.


```Json
{
  "action": "list_tables",
  "payload": { "table_name": "any" }
}
```

### 3. Drop Table
Permanently deletes a table and its data.


```Json
{
  "action": "drop_table",
  "payload": { "table_name": "old_data_backup" }
}
```

---

## 💝 Data Operations (CRUD)

### 4. Batch Post (Insert Multiple)
**Quota Efficient.** Inserts many rows in one single transaction.


```json
{
  "action": "batch_post",
  "payload": {
    "table_name": "sensor_logs",
    "data": [
      { "c1": "device_A", "i1": 42, "t1": "Normal status" },
      {  "c1": "device_B", "i1": 99, "t1": "Warning triggered" }
    ]
  }
}
```

### 5. Get (Query with Filters)
Supports whitelisted column filtering and pagination.


```Json
{
  "action": "get",
  "payload": {
    "table_name": "sensor_logs",
    "c1": "device_A",
    "orderby": "v",
    "order": "desc",
    "limit": 50
  }
}
```

### 6. Put (Update by ID)
Updates specific columns by primary key. Updates `v2` timestamp automatically.

```Json
{
  "action": "put",
  "payload":{
    "table_name": "sensor_logs",
    "id": 1,
    "i1": 105
  }
}
```

---

## ⚡ Indexing & Performance

### 7. Create Custom Index
Use this to prevent "Full Table Scans" on large datasets. Standardizes name to `idx_<table>_<column>`.

```json
{
  "action": "create_index",
  "payload": {
    "table_name": "sensor_logs",
    "column": "i1"
  }
}
```

### 8. List Active Indices
Verify which indices are protecting your quota.

```Json
{
  "action": "list_indices",
  "payload":{ "table_name": "sensor_logs" }
}
```

---

## 💑 Universal Access

### 9. Exec (Raw SQL)
Allows any SQLite command. Use `params` for security.

```json
{
  "action": "exec",
  "payload":{
    "query": "SELECT c1, AVG(i1) FROM sensor_logs GROUP BY c1 HAVING AVG(i1) > ?",
    "params": [50]
  }
}
```

---

## ⚡ Quota Management (Free Tier)
- **Daily Read Limit:** ~166,000 rows.
- **Critical:** Never run a `get` or `exec` on a column that is not indexed if your table is large (e.g., your 160k rows), or yous will hit your daily limit in 1 second.
- **Batching:** Always use `batch_post` for high-volume data to minimize transaction overhead.
