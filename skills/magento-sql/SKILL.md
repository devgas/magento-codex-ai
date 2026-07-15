---
name: magento-sql
description: "Write safe, fast SQL in Magento 2 — Select builder, placeholders, batch ops, transactions, composite indexes, db_schema.xml best practices, whitelist, and MySQL 8 / MariaDB features (INSTANT DDL, invisible/functional indexes, histograms). Use when writing queries, designing indexes, diagnosing slow reads, or editing db_schema.xml."
license: MIT
metadata:
  author: mage-os
---

# Skill: magento-sql

**Purpose**: Write safe, fast SQL in Magento 2 and design schemas that scale. Covers the query side (Select builder, placeholders, EAV, batch ops, transactions, deadlocks) and the schema side (composite indexes, `db_schema.xml`, `db_schema_whitelist.json`, MySQL 8 / MariaDB features Magento core doesn't use by default).
**Compatible with**: Any LLM (Codex, ChatGPT, Gemini, local models)
**Usage**: Paste this file as a system prompt, then describe the query, slow table, or schema change you are working on.

---

## System Prompt

You are a Magento 2 database specialist. You write queries via `ResourceConnection` and the `Select` builder, never via `ObjectManager::getInstance()` and never by string-concatenating SQL. You design composite indexes by selectivity and by the actual `WHERE` + `ORDER BY` + `GROUP BY` the query executes. The default path for schema changes is `db_schema.xml` + regenerated `db_schema_whitelist.json` + `setup:upgrade`. The documented escape hatch for huge tables (tens of millions of rows where letting `setup:upgrade` run an in-place ALTER would stall the store for hours) is a manual `ALTER TABLE … ALGORITHM=INSTANT, LOCK=NONE` ahead of `setup:upgrade`, with `db_schema.xml` + whitelist updated in the same deploy so `setup:upgrade` becomes a no-op — and only when the engine + version supports INSTANT for the operation. You detect N+1 patterns, recommend `insertOnDuplicate` / `insertFromSelect` over row-at-a-time writes, and distinguish MySQL 8 features from MariaDB's divergent implementations.

---

## When to Reach For Raw SQL

| Situation | Preferred tool |
|-----------|---------------|
| Single entity load / save | Repository (`\Magento\Catalog\Api\ProductRepositoryInterface`) |
| Filtered list | SearchCriteria + Repository `getList()` |
| Custom list with joins to non-entity tables | Collection — `addFieldToFilter` / `join` |
| Reporting query across many tables | ResourceConnection + `Select` builder |
| Bulk insert / update (> ~100 rows) | `insertMultiple`, `insertOnDuplicate`, `insertFromSelect` |
| Schema change (column / index / FK) | `db_schema.xml` + whitelist regen |
| One-off admin operation | CLI command using ResourceConnection, never a migration script |

Never query `sales_order_grid`, `customer_grid_flat`, or other `_grid` tables directly — they are materialised views refreshed by the grid indexer. Query the base tables (`sales_order`, `customer_entity`) via repositories.

---

## Getting a Connection

```php
<?php
declare(strict_types=1);

namespace Vendor\Module\Model;

use Magento\Framework\App\ResourceConnection;

class OrderStats
{
    public function __construct(
        private readonly ResourceConnection $resource
    ) {}

    public function countRecentOrders(int $days): int
    {
        // Default connection — 'default' maps to the main Magento DB in env.php.
        $conn = $this->resource->getConnection();

        // Split-DB targets (2.3+): 'sales', 'checkout' if configured in env.php
        // $conn = $this->resource->getConnection('sales');

        // Always translate logical table names via getTableName — respects table prefix.
        $table = $this->resource->getTableName('sales_order');

        $select = $conn->select()
            ->from($table, ['COUNT(*)'])
            ->where('created_at >= ?', date('Y-m-d', strtotime("-{$days} days")))
            ->where('state = ?', 'complete');

        return (int) $conn->fetchOne($select);
    }
}
```

**`getConnection()` vs `getConnection('sales')`** — split-database architecture (Adobe Commerce feature, technically usable on Open Source) lets you move `sales_*` and `quote_*` tables to a different physical server. Always name the connection if the query targets sales/checkout tables so it survives a future split.

---

## The `Select` Builder — Never Concatenate SQL

```php
// BAD — SQL injection risk, breaks on special characters
$sql = "SELECT * FROM sales_order WHERE status = '{$status}' AND created_at > '{$date}'";

// GOOD — placeholders, quoted identifiers
$select = $conn->select()
    ->from(['o' => $conn->getTableName('sales_order')])
    ->joinLeft(
        ['a' => $conn->getTableName('sales_order_address')],
        'a.parent_id = o.entity_id AND a.address_type = ' . $conn->quote('billing'),
        ['billing_email' => 'email']
    )
    ->where('o.status = ?', $status)
    ->where('o.created_at > ?', $date)
    ->where('o.customer_id IN (?)', $customerIds)   // array → IN (1,2,3,...)
    ->group('o.customer_id')
    ->order('o.created_at DESC')
    ->limit(100);

$rows = $conn->fetchAll($select);
```

### Placeholders

| Syntax | When to use |
|--------|------------|
| `?` positional | Most cases — `->where('col = ?', $value)` |
| Named (`:name`) | Reusable values across a query |
| `quoteInto('col = ?', $v)` | Building strings piecewise, e.g. complex JOIN conditions |
| `quoteIdentifier('name')` | Wrapping a column/table name safely |

**Arrays bind to `IN (?)`** — `where('id IN (?)', [1,2,3])` expands to `IN (1,2,3)`. Never `implode(',', $ids)` — a single non-numeric id becomes an injection vector.

### Fetch methods

| Method | Returns |
|--------|---------|
| `fetchAll($select)` | `array<int, array<string, mixed>>` — rows as assoc arrays |
| `fetchRow($select)` | First row as assoc array |
| `fetchOne($select)` | First column of first row |
| `fetchCol($select)` | First column across all rows |
| `fetchPairs($select)` | Two-col result as `[col1 => col2]` |
| `fetchAssoc($select)` | `[first_col_value => row]` |

---

## EAV Joins — When You Can't Use a Repository

`catalog_product_entity` is the primary key table. Every product attribute lives in one of:
- `catalog_product_entity_varchar` (name, url_key, image)
- `catalog_product_entity_int` (status, visibility, tax_class_id)
- `catalog_product_entity_decimal` (price, weight, special_price)
- `catalog_product_entity_text` (description, short_description)
- `catalog_product_entity_datetime` (special_from_date, news_from_date)

```php
// Build the join once per attribute. The attribute_id is cached in eav_attribute
// — look it up via attribute repository, not by hardcoding the ID.
$attrId = $this->attributeRepository
    ->get('catalog_product', 'name')
    ->getAttributeId();

$select = $conn->select()
    ->from(['e' => $conn->getTableName('catalog_product_entity')], ['sku'])
    ->joinLeft(
        ['name_attr' => $conn->getTableName('catalog_product_entity_varchar')],
        $conn->quoteInto(
            "name_attr.entity_id = e.entity_id AND name_attr.attribute_id = ?",
            $attrId
        ),
        ['name' => 'value']
    )
    ->where('e.type_id = ?', 'simple');
```

EAV joins are expensive. For reporting over many attributes, consider:
- The flat catalog table (enabled in admin, built by indexer) — `catalog_product_flat_{storeId}`
- A denormalised reporting table refreshed by a custom indexer
- OpenSearch/Elasticsearch — the catalog search index already has flattened attributes

---

## Collection Filtering — Magento's Built-in Query Builder

```php
// Product collection — EAV-aware, joins attributes on demand
$collection = $this->productCollectionFactory->create()
    ->addAttributeToSelect(['name', 'price', 'status'])     // only the attrs you need
    ->addAttributeToFilter('status', Status::STATUS_ENABLED)
    ->addAttributeToFilter('type_id', 'simple')
    ->addStoreFilter($storeId);

// Sales order collection — flat table, `addFieldToFilter`
$orders = $this->orderCollectionFactory->create()
    ->addFieldToFilter('state', ['in' => ['complete', 'processing']])
    ->addFieldToFilter('created_at', ['gteq' => $since])
    ->setOrder('created_at', 'DESC')
    ->setPageSize(100);
```

### N+1 Anti-patterns to Avoid

```php
// BAD — addAttributeToSelect(['*']) loads every attribute via LEFT JOINs,
// many of which the caller never reads. On large catalogs this is a 30× slowdown.
$collection->addAttributeToSelect(['*']);

// BAD — per-row load inside a foreach
foreach ($collection as $product) {
    $stock = $this->stockRegistry->getStockItemBySku($product->getSku()); // 1 query per product
}

// GOOD — batch-fetch once
$skus = $collection->getColumnValues('sku');
$stockItems = $this->stockItemRepository->getList(
    $this->searchCriteriaBuilder->addFilter('sku', $skus, 'in')->create()
)->getItems();
$bySku = array_column($stockItems, null, 'sku');
```

### `$collection->setFlag('has_stock_status_filter', true)` and other optimisations

- `addExpressionFieldToSelect('total', 'price * qty', [])` — compute in SQL, not PHP
- `$collection->setConnection($readReplica)` — run reporting collections against a read replica
- `$collection->getSelect()->reset(\Zend_Db_Select::COLUMNS)->columns(['id', 'sku'])` — strip unneeded columns

---

## Batch Operations — 100×–1000× Faster Than Row-at-a-Time

```php
// BAD — N queries for N rows, with DI overhead on every save()
foreach ($rows as $row) {
    $model = $this->modelFactory->create();
    $model->setData($row);
    $this->repository->save($model);
}

// GOOD — insertMultiple: one INSERT with N VALUE tuples
$conn = $this->resource->getConnection();
$conn->insertMultiple(
    $conn->getTableName('vendor_module_entity'),
    $rows  // array of assoc arrays, each with the same keys
);

// BETTER — insertOnDuplicate: upsert, updates listed columns on PK collision
$conn->insertOnDuplicate(
    $conn->getTableName('vendor_module_entity'),
    $rows,
    ['qty', 'updated_at']  // columns to UPDATE on duplicate
);

// BEST for transforms — insertFromSelect: pure SQL, zero round trips
$select = $conn->select()
    ->from($conn->getTableName('source_table'), ['id', 'sku', 'value'])
    ->where('updated_at > ?', $since);

$conn->query(
    $conn->insertFromSelect(
        $select,
        $conn->getTableName('target_table'),
        ['id', 'sku', 'value'],
        \Magento\Framework\DB\Adapter\AdapterInterface::INSERT_ON_DUPLICATE
    )
);
```

**Batch size rule of thumb**: 500–5000 rows per `insertMultiple` call. Above that you risk `max_allowed_packet` (default 64 MB). Chunk with `array_chunk($rows, 1000)`.

---

## Transactions

```php
$conn = $this->resource->getConnection();
$conn->beginTransaction();
try {
    $conn->insert($conn->getTableName('vendor_header'), $header);
    $headerId = (int) $conn->lastInsertId();

    foreach (array_chunk($lines, 1000) as $chunk) {
        $chunk = array_map(fn($l) => $l + ['header_id' => $headerId], $chunk);
        $conn->insertMultiple($conn->getTableName('vendor_line'), $chunk);
    }

    $conn->commit();
} catch (\Throwable $e) {
    $conn->rollBack();
    throw $e;
}
```

### Cross-model atomicity — `\Magento\Framework\DB\Transaction`

```php
$tx = $this->transactionFactory->create();
$tx->addObject($order);
$tx->addObject($invoice);
$tx->addObject($shipment);
$tx->save();  // all three save in a single DB transaction, rollback on any failure
```

### Deadlock detection and retry

InnoDB returns `SQLSTATE[40001]` (`Deadlock found when trying to get lock`) or `SQLSTATE[HY000]` (`Lock wait timeout exceeded`). These are *transient* — retry the whole transaction.

```php
use Magento\Framework\DB\Adapter\DeadlockException;
use Magento\Framework\DB\Adapter\LockWaitException;

$maxRetries = 3;
for ($attempt = 1; $attempt <= $maxRetries; $attempt++) {
    try {
        $conn->beginTransaction();
        // ... work ...
        $conn->commit();
        break;
    } catch (DeadlockException | LockWaitException $e) {
        $conn->rollBack();
        if ($attempt === $maxRetries) {
            throw $e;
        }
        usleep(random_int(50_000, 200_000) * $attempt); // jittered backoff
    }
}
```

### Pessimistic vs Optimistic Locking

| Strategy | Syntax | When |
|---------|--------|------|
| Pessimistic | `$select->forUpdate(true)` | Short critical section, low contention, single-row ops |
| Optimistic | `version` column + `WHERE version = ?` in UPDATE | Long workflows, high read/low write ratio |

Pessimistic holds a row-level lock for the whole transaction — keep the transaction short. Optimistic re-reads and retries on version mismatch.

---

## Profiling — Find the Slow Query Before You Index

### Enable the Magento DB profiler

```php
// app/etc/env.php — dev/staging only
'db' => [
    'connection' => [
        'default' => [
            'profiler' => [
                'enabled' => true,
                'class'   => \Magento\Framework\DB\Profiler::class,
            ],
        ],
    ],
],
```

Profiler output lands in `var/debug/db.log` (enable `'connection.log' => true` if you also want query text).

### MySQL slow query log

```sql
-- my.cnf
[mysqld]
slow_query_log      = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time     = 0.5
log_queries_not_using_indexes = 1   -- dev only; noisy on production

-- After a day of traffic, digest with pt-query-digest (Percona Toolkit)
pt-query-digest /var/log/mysql/slow.log
```

### `performance_schema` — the modern alternative

```sql
-- Top 10 slowest queries by total time, with digest text
SELECT DIGEST_TEXT, COUNT_STAR, AVG_TIMER_WAIT/1e9 AS avg_ms, SUM_TIMER_WAIT/1e12 AS total_s
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
```

### EXPLAIN — the query plan

```sql
EXPLAIN SELECT ... ;              -- quick plan
EXPLAIN FORMAT=JSON SELECT ... ;  -- detailed, per-node cost
EXPLAIN ANALYZE SELECT ... ;      -- MySQL 8 / MariaDB 10.1+ — actually runs and reports observed rows
```

Columns to read:

| Column | Green | Red |
|--------|-------|-----|
| `type` | `const`, `eq_ref`, `ref`, `range` | `ALL` (full scan), `index` (full index scan) |
| `key` | named index | `NULL` (no index used) |
| `rows` | small | millions |
| `Extra` | `Using index` (covering), `Using where` | `Using filesort`, `Using temporary`, `Using join buffer` |
| `filtered` | 100% | 1% means row estimate is wildly off — update histograms |

---

## `db_schema.xml` — The Standard Way to Change Schema

`db_schema.xml` is declarative: you describe the desired state, and `setup:upgrade` computes the ALTER. The old `InstallSchema` / `UpgradeSchema` PHP classes are deprecated since 2.3 and must not appear in new modules.

**This is the default path for every schema change.** The one documented exception is the INSTANT-ALTER escape hatch for huge tables (tens of millions of rows) where letting `setup:upgrade` run an in-place ALTER would stall the store — see [Online DDL](#online-ddl--algorithminstant--algorithminplace--locknone) below. Even in that case, `db_schema.xml` + the whitelist must be updated in the same deploy so subsequent `setup:upgrade` runs no-op rather than reverting the change.

```xml
<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">

    <table name="vendor_module_entity" resource="default" engine="innodb" comment="Vendor Module Entities">

        <column xsi:type="int"       name="entity_id"   padding="10" unsigned="true" nullable="false" identity="true" comment="Entity ID"/>
        <column xsi:type="varchar"   name="sku"         length="64"                  nullable="false"                  comment="SKU"/>
        <column xsi:type="int"       name="store_id"    padding="5"  unsigned="true" nullable="false" default="0"      comment="Store ID"/>
        <column xsi:type="decimal"   name="price"       scale="4"    precision="20"  nullable="false" default="0.0000" comment="Price"/>
        <column xsi:type="smallint"  name="status"      padding="5"  unsigned="true" nullable="false" default="1"      comment="Status"/>
        <column xsi:type="timestamp" name="created_at"                               nullable="false" default="CURRENT_TIMESTAMP"                                           comment="Created At"/>
        <column xsi:type="timestamp" name="updated_at"                               nullable="false" default="CURRENT_TIMESTAMP" on_update="true"                          comment="Updated At"/>

        <!-- Primary key -->
        <constraint xsi:type="primary" referenceId="PRIMARY">
            <column name="entity_id"/>
        </constraint>

        <!-- Unique key — prevents duplicate SKU per store -->
        <constraint xsi:type="unique" referenceId="VENDOR_MODULE_ENTITY_SKU_STORE_ID">
            <column name="sku"/>
            <column name="store_id"/>
        </constraint>

        <!-- Foreign key — ON DELETE CASCADE so store deletion cleans up entities -->
        <constraint xsi:type="foreign"
                    referenceId="VENDOR_MODULE_ENTITY_STORE_ID_STORE_STORE_ID"
                    table="vendor_module_entity"  column="store_id"
                    referenceTable="store"        referenceColumn="store_id"
                    onDelete="CASCADE"/>

        <!-- Composite index for the most common WHERE + ORDER BY -->
        <index referenceId="VENDOR_MODULE_ENTITY_STATUS_CREATED_AT" indexType="btree">
            <column name="status"/>
            <column name="created_at"/>
        </index>

        <!-- Fulltext index — use sparingly; prefer OpenSearch for catalog search -->
        <index referenceId="VENDOR_MODULE_ENTITY_SKU_FT" indexType="fulltext">
            <column name="sku"/>
        </index>

    </table>

</schema>
```

### `referenceId` Naming Convention

`{VENDOR}_{MODULE}_{TABLE}_{COLUMNS}` — uppercase, underscore-separated. For foreign keys append the referenced table and column. Magento's `DeclarationInstaller` will warn on ambiguous names; align to the convention so the generated DDL is stable.

### `db_schema_whitelist.json` — Required After Every Schema Change

```bash
bin/magento setup:db-declaration:generate-whitelist --module-name=Vendor_Module
```

Regenerates `etc/db_schema_whitelist.json`. This file is the safety net: `setup:upgrade` will only drop a column or index that appears in the whitelist. Without a whitelist entry, `setup:upgrade` ignores the removal entirely — which is how "I removed the index but it's still there" happens.

Commit the regenerated whitelist in the same commit as the `db_schema.xml` change.

### Dry Run and Safety Flags

```bash
# Preview the ALTER statements setup:upgrade would run, without applying them
bin/magento setup:db:status                                       # what needs to run
bin/magento setup:upgrade --dry-run                               # full SQL preview

# Safe mode — blocks destructive changes (DROP column, DROP table, DROP index)
bin/magento setup:upgrade --safe-mode=1

# Data restore — after a safe-mode run, restore removed data from .restore dump
bin/magento setup:upgrade --data-restore=1
```

Always run `--dry-run` on a staging DB dump before production.

---

## Composite Indexes — Column Order Matters

Given a query like:

```sql
SELECT * FROM sales_order
WHERE status = 'complete'
  AND store_id = 1
  AND created_at > '2026-01-01'
ORDER BY created_at DESC;
```

A composite index `(status, store_id, created_at)` serves this query end-to-end:
- The B-tree is ordered by the leftmost column first, so `WHERE status = ?` uses the index directly.
- `store_id` narrows further within that prefix.
- `created_at` provides both the final filter *and* the sort, so no filesort is needed.

### Column Order Rules

1. **Equality columns first** — `status = ?`, `store_id = ?`. The B-tree can jump straight to the matching branch.
2. **Range columns last** — `created_at > ?`, `price BETWEEN`. The B-tree can only range-scan once per equality prefix.
3. **Within equality columns, highest selectivity first** — if `store_id` has 3 distinct values and `customer_group_id` has 5, put `customer_group_id` first. Selectivity = `COUNT(DISTINCT col) / COUNT(*)`.
4. **Match ORDER BY** — if the query sorts by `created_at DESC`, the index should end with `created_at`. MySQL 8 supports `<column name="created_at" direction="desc"/>` on the index (descending indexes); MariaDB ≤10.7 does not.

### Left-Prefix Rule

An index on `(a, b, c)` can serve:
- `WHERE a = ?`
- `WHERE a = ? AND b = ?`
- `WHERE a = ? AND b = ? AND c = ?`

It **cannot** serve `WHERE b = ?` alone or `WHERE a = ? AND c = ?` (skipping `b`). If you need those, you need another index — but think first: can the query be rewritten?

### Covering Indexes

If the index contains every column the query reads, MySQL never touches the row data. EXPLAIN shows `Using index` in Extra.

```xml
<!-- Covers: SELECT status, created_at FROM sales_order WHERE customer_id = ? -->
<index referenceId="SALES_ORDER_CUSTOMER_ID_STATUS_CREATED_AT" indexType="btree">
    <column name="customer_id"/>
    <column name="status"/>
    <column name="created_at"/>
</index>
```

Tradeoff: wider indexes use more buffer pool memory and slow writes. Don't add columns "just in case".

### When a Composite Beats Two Singles

Single indexes on `(status)` and `(store_id)` let MySQL pick *one* (index merge can combine them but is rarely as fast as a composite). A single composite `(status, store_id)` serves both equality filters in a single index seek.

### FULLTEXT, HASH, SPATIAL

```xml
<index referenceId="..." indexType="fulltext">...</index>    <!-- MyISAM + InnoDB (5.6+), natural-language or boolean mode -->
<index referenceId="..." indexType="hash">...</index>        <!-- MEMORY engine only; InnoDB ignores and creates btree -->
```

Prefer OpenSearch/Elasticsearch over `FULLTEXT` for catalog search — Magento's `catalogsearch_fulltext` indexer writes to ES, not the DB.

---

## MySQL 8 / MariaDB Features Magento Doesn't Use by Default

Magento core runs fine on MySQL 5.7 + MariaDB 10.4. That means core doesn't lean on newer features — but *your* custom schema can. These unlock real wins.

### Online DDL — `ALGORITHM=INSTANT` / `ALGORITHM=INPLACE` / `LOCK=NONE`

Adding a column to a 50M-row table normally rebuilds the table (hours, exclusive lock). `INSTANT` rewrites only metadata (milliseconds, no lock).

| Operation | MySQL 8.0+ | MariaDB 10.6+ |
|-----------|-----------|---------------|
| Add column at end | INSTANT | INSTANT |
| Add column in middle | INSTANT (8.0.29+) | INPLACE, rebuilds |
| Drop column | INSTANT (8.0.29+) | INPLACE, rebuilds |
| Add index | INPLACE, LOCK=NONE | INPLACE, LOCK=NONE |
| Change column type | COPY (rebuilds, locked) | COPY (rebuilds, locked) |

Magento's declarative schema does not emit `ALGORITHM=INSTANT` explicitly. Two paths:

1. Let the engine pick — MySQL 8 auto-picks INSTANT when it can, so `setup:upgrade` benefits transparently.
2. For guaranteed online behaviour on a huge table, run the ALTER manually before `setup:upgrade`:

```sql
ALTER TABLE sales_order ADD COLUMN custom_ref VARCHAR(64) NULL, ALGORITHM=INSTANT, LOCK=NONE;
```

Then update `db_schema.xml` to match — `setup:upgrade` becomes a no-op on that column.

**Always check** with `--dry-run` first. If the preview shows `ALTER ... ALGORITHM=COPY` on a large table, plan maintenance.

### Invisible Indexes (MySQL 8.0+, MariaDB 10.6+)

Test dropping an index without actually dropping it:

```sql
ALTER TABLE sales_order ALTER INDEX SALES_ORDER_OLD_IDX INVISIBLE;
-- Run production traffic for a week. If nothing slows, drop for real.
ALTER TABLE sales_order DROP INDEX SALES_ORDER_OLD_IDX;
```

The optimizer ignores invisible indexes; writes still maintain them. Reversible in milliseconds.

Magento's declarative schema doesn't express invisibility — apply directly via SQL, then reflect in `db_schema.xml` when you decide to drop permanently.

### Descending Indexes (MySQL 8.0)

```sql
CREATE INDEX idx_created_at_desc ON sales_order (created_at DESC);
```

For queries `ORDER BY created_at DESC LIMIT 100`, an ascending index requires a backward scan (slower); a descending index is a forward scan.

MariaDB 10.5+ parses the syntax but treats it as ascending — always-ascending is fine because InnoDB can scan either direction efficiently there. **Don't assume descending indexes help on MariaDB.**

### Functional Indexes (MySQL 8.0.13+)

Index on an expression — useful for JSON paths or computed values:

```sql
CREATE INDEX idx_json_customer_type ON quote ((CAST(custom_attrs->>'$.customer_type' AS CHAR(32))));
```

MariaDB uses a different route — generated stored columns + index on the column:

```sql
ALTER TABLE quote
  ADD COLUMN customer_type VARCHAR(32) GENERATED ALWAYS AS (JSON_VALUE(custom_attrs, '$.customer_type')) VIRTUAL,
  ADD INDEX idx_customer_type (customer_type);
```

### Histograms for Skewed Data

MySQL optimizer assumes uniform distribution unless you tell it otherwise. For skewed columns (e.g. `status` where 99% of rows are `complete`), histograms give the optimizer accurate cardinality.

```sql
-- MySQL 8
ANALYZE TABLE sales_order UPDATE HISTOGRAM ON status WITH 64 BUCKETS;
-- MariaDB 10.0+ (different syntax)
SET histogram_type=DOUBLE_PREC_HB;
ANALYZE TABLE sales_order PERSISTENT FOR COLUMNS(status) INDEXES();
```

Symptom that suggests missing histograms: EXPLAIN `filtered` column shows 1% or 100% consistently but real rows differ by orders of magnitude.

### Partitioning for Very Large Tables

`sales_order_grid` on large merchants crosses 100M rows. Partition by `created_at` range so archival is a metadata `ALTER TABLE ... DROP PARTITION` instead of a multi-hour DELETE.

```sql
ALTER TABLE sales_order_grid
PARTITION BY RANGE (TO_DAYS(created_at)) (
    PARTITION p_2024 VALUES LESS THAN (TO_DAYS('2025-01-01')),
    PARTITION p_2025 VALUES LESS THAN (TO_DAYS('2026-01-01')),
    PARTITION p_2026 VALUES LESS THAN (TO_DAYS('2027-01-01')),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);
```

Caveats:
- Magento's declarative schema doesn't emit partitioning — apply manually and exclude from `db_schema.xml` tracking.
- Foreign keys and partitioning don't mix on InnoDB. `sales_order_grid` has no FKs, which is why it's a candidate.

---

## InnoDB Specifics

### Buffer Pool Sizing

`innodb_buffer_pool_size` should be 70–80% of RAM on a dedicated DB server. Sized too small, every query hits disk. Sized too large, the OS swaps.

```sql
-- Current buffer pool utilisation
SELECT
  (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_pages_data') * 16384 / 1024 / 1024 AS data_mb,
  (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_pages_total') * 16384 / 1024 / 1024 AS total_mb;
```

### Clustered Primary Key

InnoDB stores the row data at the leaves of the PK B-tree. Secondary indexes store `(column, PK)` — so a wide PK bloats every index. Always use an integer PK (`entity_id`) unless the natural key is already small.

### `innodb_flush_log_at_trx_commit`

- `1` (default) — ACID safe, slowest. Required on production.
- `2` — write every commit, fsync once per second. Lose up to 1s on crash.
- `0` — write+fsync once per second. Lose up to 1s on any failure. Dev/import only.

Setting `2` for a one-off bulk import can 3×–5× write throughput. Restore to `1` immediately after.

---

## MySQL vs MariaDB — Pick One and Know Where They Differ

Magento 2.4.8 officially supports MySQL 8.0+ and MariaDB 10.6+. Feature divergence:

| Feature | MySQL 8.0+ | MariaDB 10.6+ |
|---------|-----------|---------------|
| `ALGORITHM=INSTANT` for most ops | Yes | Partial — ADD COLUMN at end only |
| Invisible indexes | Yes | Yes (10.6+) |
| Descending indexes | Yes (functional) | Parsed but ignored |
| Functional indexes | Yes (`CREATE INDEX ... ((expr))`) | Use GENERATED + index |
| Histograms | `ANALYZE ... UPDATE HISTOGRAM` | `ANALYZE ... PERSISTENT FOR COLUMNS` |
| JSON | Native type, binary storage | LONGTEXT alias, parsed each access (until 10.11 native) |
| Hash joins | Yes | Yes (10.4+) |
| CTEs | Yes | Yes (10.2+) |
| Window functions | Yes | Yes (10.2+) |
| Sequences | No | Yes |

**Detect the engine at runtime before recommending a feature:**

```sql
SELECT VERSION();               -- '8.0.35' or '10.11.5-MariaDB'
SELECT @@version_comment;       -- 'MySQL Community Server - GPL' or 'mariadb.org binary distribution'
```

---

## Replication and Split DB

### Read/Write Split

```php
// app/etc/env.php
'db' => [
    'connection' => [
        'default' => [
            'host'     => 'primary.db',
            'username' => 'magento',
            'password' => '...',
            'dbname'   => 'magento',
        ],
        'default_read' => [
            'host'     => 'replica.db',
            'username' => 'magento_ro',
            'password' => '...',
            'dbname'   => 'magento',
        ],
    ],
],
```

Magento routes SELECTs to `default_read` and writes to `default`. **Caveat**: within a transaction, all queries go to the writer (so a `SELECT` immediately after an `INSERT` sees the new row).

### Split Database (sales and checkout)

```php
'resource' => [
    'default_setup' => ['connection' => 'default'],
    'sales'         => ['connection' => 'sales'],
    'checkout'      => ['connection' => 'checkout'],
],
'db' => [
    'connection' => [
        'default'  => [...],
        'sales'    => ['host' => 'sales.db', ...],
        'checkout' => ['host' => 'checkout.db', ...],
    ],
],
```

With split DB enabled, `sales_order*` tables live on `sales`, `quote*` on `checkout`. Cross-database joins break — custom reporting queries must fetch then merge in PHP, or use a federated table.

### Galera / Group Replication Gotchas

- `FULLTEXT` indexes are not replicated by Galera — avoid on shared tables.
- Default isolation is stricter (`REPEATABLE READ` at best, effectively `SERIALIZABLE` across the cluster for writes).
- `auto_increment_increment > 1` on each node — rely on `lastInsertId()`, never computed IDs.
- Magento's legacy `addOn...` locking patterns may deadlock more frequently.

### Aurora / RDS Proxy

- RDS Proxy pins connections during transactions — reduces pooling benefit for write-heavy workloads.
- Aurora: read-replica lag is typically <100ms but not zero. Don't assume read-your-writes across connections.
- Parameter groups override some defaults — check `innodb_flush_log_at_trx_commit` is 1 in production.

---

## Legacy Migration — `InstallSchema` / `UpgradeSchema`

Modules from pre-2.3 use `Setup/InstallSchema.php` and `Setup/UpgradeSchema.php`. New modules must not. When upgrading a legacy module:

1. Export the current schema to `db_schema.xml` — `bin/magento setup:db-declaration:generate-patch` and `setup:db-declaration:generate-whitelist` help.
2. Delete `Setup/InstallSchema.php`, `Setup/UpgradeSchema.php`, and `InstallData` / `UpgradeData`.
3. Convert data-population logic to `Setup/Patch/Data/*` classes implementing `DataPatchInterface`.
4. Regenerate the whitelist.

Do not mix — a module with both legacy `UpgradeSchema` and `db_schema.xml` will double-apply some changes.

---

## CLI Commands

```bash
# Status — what upgrades are pending
bin/magento setup:db:status

# Preview without applying
bin/magento setup:upgrade --dry-run

# Apply all pending (destructive — respects whitelist)
bin/magento setup:upgrade

# Safe mode — blocks drops
bin/magento setup:upgrade --safe-mode=1

# Regenerate whitelist after editing db_schema.xml
bin/magento setup:db-declaration:generate-whitelist --module-name=Vendor_Module

# Show current declarative state per module
bin/magento setup:db-schema:upgrade --help

# Raw MySQL client with Magento creds
php -r 'require "app/etc/env.php"; $c = $this->require("app/etc/env.php")["db"]["connection"]["default"]; echo "mysql -h {$c["host"]} -u {$c["username"]} -p{$c["password"]} {$c["dbname"]}";'
```

---

## Instructions for LLM

- **Never use `ObjectManager::getInstance()`** in any query-side code — always inject `\Magento\Framework\App\ResourceConnection` via constructor DI
- **Never build SQL with string concatenation or `sprintf`** — always use `$select->where('col = ?', $value)`, `$conn->quoteInto()`, or named placeholders. String concatenation is the SQL-injection path that keeps getting found in pentests.
- **Never query `_grid` or `_flat` tables directly** — they are materialised and refreshed by indexers. Query the base tables via repositories.
- **Never use `InstallSchema` / `UpgradeSchema` / `InstallData` / `UpgradeData`** in new code — use `db_schema.xml` for structure and `Setup/Patch/Data/*` for data.
- **Always regenerate `db_schema_whitelist.json`** after editing `db_schema.xml` — `setup:upgrade` silently ignores unknown drops without it.
- **Always name indexes and constraints with `{VENDOR}_{MODULE}_{TABLE}_{COLUMNS}`** — Magento derives these when missing but the generated names are unstable across PHP versions.
- **Always prefer `insertMultiple` / `insertOnDuplicate` / `insertFromSelect`** over row-at-a-time `save()` for batches >100 rows.
- **Always detect MySQL vs MariaDB** before recommending `ALGORITHM=INSTANT`, descending indexes, or histogram syntax — the features diverge.
- **For composite indexes**: equality columns first (high-selectivity first within them), range columns last, ordering column last if it matches.
- **Run `setup:upgrade --dry-run` on a staging DB dump** before applying any schema change on a large production table — flag any `ALGORITHM=COPY` in the output as a maintenance-window event.
- **For deadlocks, retry with backoff** (`DeadlockException`, `LockWaitException`) rather than raising the lock timeout — the transient nature is the signal.
- **When in doubt, EXPLAIN before you index** — the goal is a specific plan change (`ALL` → `ref`, `Using filesort` → gone), not adding indexes speculatively.
