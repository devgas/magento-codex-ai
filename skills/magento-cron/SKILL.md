---
name: magento-cron
description: "Configure, diagnose, and tune Magento 2 cron — crontab.xml, cron_groups.xml, the cron_schedule lifecycle, consumer-runner, distributed-cron, and Adobe Commerce Cloud crons. Use when scheduling jobs, debugging stuck/missed runs, or tuning history retention."
license: MIT
metadata:
  author: mage-os
---

# Skill: magento-cron

**Purpose**: Configure, schedule, and tune Magento 2 cron jobs end-to-end — `crontab.xml` job declarations, `cron_groups.xml` per-group tuning, the `cron_schedule` table lifecycle, the consumer runner, distributed/multi-node cron, and the Adobe Commerce Cloud `crons:` model.
**Compatible with**: Any LLM (Codex, ChatGPT, Gemini, local models)
**Usage**: Paste this file as a system prompt, then describe the job you need to schedule, the symptom you are debugging, or the cron group you are tuning.

---

## System Prompt

You are a Magento 2 cron specialist. You declare jobs in `crontab.xml`, tune groups in `cron_groups.xml`, understand the `pending → running → success | error | missed` lifecycle in the `cron_schedule` table, and know how the consumer runner spawns RabbitMQ consumers via cron. You always identify whether the environment is on-prem (OS crontab via `bin/magento cron:install`) or Adobe Commerce Cloud (`crons:` block in `.magento.app.yaml`) before recommending a fix. You never recommend `TRUNCATE cron_schedule` as a remediation — bloat is solved by tuning `history_*_lifetime`.

---

## When Cron is the Right Tool

Use Magento cron for:

- Recurring background work (nightly imports, hourly syncs, end-of-day rollups)
- Maintenance tasks Magento ships (`indexer_reindex_all_invalid`, `newsletter_send_all`, `captcha_delete_old_attempts`, `outdated_authentication_failures_cleanup`, `sales_clean_quotes`, `sitemap_generate`, `magento_logging_clean`)
- Spawning queue consumers in environments without Supervisor/systemd (`cron_consumers_runner`)
- Anything admin-editable schedule (`config_path` instead of literal `<schedule>`)

Don't use cron for:

- Anything that must fire within the minute — minimum granularity is 1 minute, and `default_run_interval` (60 s) gates how often the dispatcher checks. Use queue + consumer for sub-minute work.
- Long-running jobs that exceed the group's `schedule_lifetime` — they will be marked `missed`. Either raise the lifetime or split the job and queue it.
- Anything that must run on every node — only one node should run cron in a multi-node deploy (see "Distributed cron" below).

---

## The Two-File Model — `crontab.xml` + `cron_groups.xml`

Every cron implementation involves two config files:

| File | Location | Declares |
|------|----------|----------|
| `crontab.xml` | `etc/` | Individual jobs — id, group, schedule, instance, method |
| `cron_groups.xml` | `etc/` | Per-group tuning — schedule generation, lifetime, retention, separate process |

A job's `group` attribute selects which group's tuning applies. Built-in groups are `default`, `index`, `consumers`, and (Adobe Commerce) `staging`. You can declare your own group if it needs different retention or a separate PHP process.

---

## Step 1 — Declare a Job (`etc/crontab.xml`)

```xml
<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Cron:etc/crontab.xsd">

    <group id="default">

        <!-- Literal cron expression -->
        <job name="vendor_module_nightly_export"
             instance="Vendor\Module\Cron\NightlyExport"
             method="execute">
            <schedule>0 2 * * *</schedule>   <!-- 02:00 daily -->
        </job>

        <!-- Admin-editable schedule via system.xml + config.xml -->
        <job name="vendor_module_inventory_sync"
             instance="Vendor\Module\Cron\InventorySync"
             method="execute">
            <config_path>vendor_module/cron/inventory_sync_schedule</config_path>
        </job>

    </group>

</config>
```

### Required attributes

| Attribute | Purpose |
|-----------|---------|
| `name` | Unique job code — appears in `cron_schedule.job_code` and CLI |
| `instance` | Fully-qualified class name; constructor-injected (no `ObjectManager`) |
| `method` | Public method on `instance` — receives no arguments |

### `<schedule>` vs `<config_path>` (mutually exclusive)

- `<schedule>` — literal 5-field cron expression (`m h dom mon dow`). Compiled into the job at `bin/magento setup:upgrade` time. Editing it requires a deploy.
- `<config_path>` — points to a config path resolved at runtime. Lets admins edit the schedule without a deploy. Pair with a `system.xml` field (string, validated against cron syntax) and a `config.xml` default.

### The handler class

```php
<?php
declare(strict_types=1);

namespace Vendor\Module\Cron;

use Psr\Log\LoggerInterface;

class NightlyExport
{
    public function __construct(
        private readonly LoggerInterface $logger
    ) {}

    public function execute(): void
    {
        $this->logger->info('Nightly export started');
        // ... work ...
    }
}
```

A throw inside `execute()` causes Magento to mark the schedule row `error` and record the message in `cron_schedule.messages`. The job will run again on its next schedule.

---

## Step 2 — Tune the Group (`etc/cron_groups.xml`)

```xml
<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Cron:etc/cron_groups.xsd">

    <group id="default">
        <schedule_generate_every>15</schedule_generate_every>
        <schedule_ahead_for>20</schedule_ahead_for>
        <schedule_lifetime>15</schedule_lifetime>
        <history_cleanup_every>10</history_cleanup_every>
        <history_success_lifetime>60</history_success_lifetime>
        <history_failure_lifetime>600</history_failure_lifetime>
        <use_separate_process>0</use_separate_process>
    </group>

</config>
```

### What each knob does (all values in **minutes**)

| Knob | Default | What it controls | When to change |
|------|---------|------------------|----------------|
| `schedule_generate_every` | 15 | How often Magento writes `pending` rows ahead of time | Lower (1–5) for jobs scheduled `* * * * *` so the dispatcher always finds rows |
| `schedule_ahead_for` | 20 | How far in the future to pre-generate `pending` rows | Should be ≥ `schedule_generate_every` |
| `schedule_lifetime` | 15 | A `pending` row older than this is marked `missed` instead of run | Raise for legitimately long-running jobs (e.g. `index` group set higher) |
| `history_cleanup_every` | 10 | How often the cleanup task runs | Rarely changed |
| `history_success_lifetime` | 60 | How long `success` rows stay in `cron_schedule` | Lower to 30 if the table grows fast |
| `history_failure_lifetime` | 600 | How long `error` / `missed` rows stay | Keep high (10 h+) for forensics |
| `use_separate_process` | 0 | Spawn a dedicated PHP process per job in the group | Set 1 for memory-heavy jobs that leak; isolates them from sibling jobs |

### Built-in groups and what lives in them

| Group | Notable jobs | Why it's separate |
|-------|--------------|-------------------|
| `default` | `indexer_reindex_all_invalid`, `newsletter_send_all`, `captcha_delete_old_attempts`, `magento_logging_clean`, `sales_grid_async_insert`, `sales_clean_quotes`, `sitemap_generate`, `system_backup`, `outdated_authentication_failures_cleanup` | The catch-all; most modules drop jobs here |
| `index` | `indexer_reindex_all_invalid`, `indexer_update_all_views`, `indexer_clean_all_changelogs` | Often given longer `schedule_lifetime` because reindexes can run for many minutes |
| `consumers` | `consumers_runner` — spawns RabbitMQ consumers when `cron_consumers_runner` is enabled | Driven by env.php config rather than admin |
| `staging` *(Adobe Commerce)* | `staging_apply_version`, `staging_remove_updates`, `staging_synchronize_entities_period` | EE-only content staging |

---

## Step 3 — Wiring Cron to the OS

Magento doesn't run itself. Something has to call `bin/magento cron:run` every minute.

### On-prem: `bin/magento cron:install`

```bash
# Adds three lines to the user's OS crontab (one per group bucket)
bin/magento cron:install

# Removes them
bin/magento cron:remove

# What it adds (verify with `crontab -l`):
# * * * * * /usr/bin/php /var/www/html/bin/magento cron:run 2>&1 | grep -v "Ran jobs by schedule" >> /var/www/html/var/log/magento.cron.log
# * * * * * /usr/bin/php /var/www/html/update/cron.php >> /var/www/html/var/log/update.cron.log
# * * * * * /usr/bin/php /var/www/html/bin/magento setup:cron:run >> /var/www/html/var/log/setup.cron.log
```

The system crontab is what makes cron run every minute. Without it, `cron_schedule` rows pile up as `pending` and then flip to `missed` when `schedule_lifetime` expires.

### Running a single group

```bash
# All groups — what the OS crontab calls
bin/magento cron:run

# Just one group — useful for triage and load-isolation
bin/magento cron:run --group=index
bin/magento cron:run --group=default
bin/magento cron:run --group=consumers

# Keep the dispatcher quiet in logs
bin/magento cron:run --group=default --bootstrap=standaloneProcessStarted=1
```

### Adobe Commerce Cloud — A Two-File Model

Cloud does not use the OS crontab. **Cron on Cloud is configured in two files, both of which you almost always need to touch together:**

1. **`.magento.app.yaml`** — declares the cron processes Cloud will spawn (the `crons:` block). This is where you add a new cron job on Cloud.
2. **`.magento.env.yaml`** — sets `CRON_CONSUMERS_RUNNER` (cloud-deploy variable equivalent of `cron_consumers_runner` in `env.php`). This controls whether the `consumers_runner` cron job actually starts queue consumers, and with which `max_messages` / `consumers` settings.

Whenever you answer a "how do I configure cron on Cloud" question, mention both files even if the question only asks about adding a job — the two are inseparable in practice.

**File 1 — `.magento.app.yaml`** (declares the cron processes):

```yaml
crons:
    cronrun:
        spec: '* * * * *'
        cmd: 'php bin/magento cron:run'
    consumers_runner:
        spec: '* * * * *'
        cmd: 'php bin/magento queue:consumers:start ... '
```

**File 2 — `.magento.env.yaml`** (sets `CRON_CONSUMERS_RUNNER` for queue consumers):

```yaml
stage:
    global:
        CRON_CONSUMERS_RUNNER:
            cron_run: true
            max_messages: 1000
            consumers: []   # empty = all
```

`bin/magento cron:install` is a no-op on Cloud — never recommend it. Cloud also pins cron to a single container so distributed-cron concerns don't apply.

---

## Step 4 — The `cron_schedule` Lifecycle

Every scheduled run is one row in the `cron_schedule` table. Status transitions:

```
pending  ─►  running  ─►  success
                      └─►  error
            ↘
             missed   (pending row older than schedule_lifetime)
```

| Status | Meaning |
|--------|---------|
| `pending` | Pre-generated by the dispatcher; not yet picked up |
| `running` | A worker has the row locked and is executing the handler |
| `success` | Handler returned cleanly |
| `error` | Handler threw — message captured in `messages` column |
| `missed` | Pending row's scheduled time + `schedule_lifetime` passed without a worker grabbing it |

**Row-level locking**: `cron:run` issues `SELECT ... FOR UPDATE` on the row before flipping it to `running`. Two concurrent `cron:run` invocations cannot both grab the same row, so you can safely run cron from multiple cron daemons against the same DB — but **don't** (see Distributed cron).

**Stuck `running`**: a row that says `running` but the PHP process is gone (OOM-killed, host rebooted, container evicted). Magento 2.4.4+ detects this via `schedule_lifetime` and re-flips the row to `error` on the next dispatch. Older versions need manual intervention:

```sql
UPDATE cron_schedule
   SET status = 'error',
       messages = CONCAT(IFNULL(messages,''), '\n[manual] reset stuck running')
 WHERE status = 'running'
   AND executed_at < NOW() - INTERVAL 1 HOUR;
```

### Triage queries

```sql
-- Status counts per job_code — top-level health check
SELECT job_code, status, COUNT(*) AS n
  FROM cron_schedule
 GROUP BY job_code, status
 ORDER BY n DESC;

-- How far behind is the dispatcher? (Largest pending backlog)
SELECT job_code, MIN(scheduled_at) AS oldest_pending
  FROM cron_schedule
 WHERE status = 'pending'
 GROUP BY job_code
 ORDER BY oldest_pending ASC;

-- Recent errors with messages
SELECT job_code, scheduled_at, executed_at, messages
  FROM cron_schedule
 WHERE status = 'error'
   AND scheduled_at > NOW() - INTERVAL 1 DAY
 ORDER BY scheduled_at DESC
 LIMIT 50;

-- Table bloat indicator — if this is over a million rows, history_*_lifetime is mis-tuned
SELECT COUNT(*) FROM cron_schedule;
```

**Never `TRUNCATE cron_schedule` as a fix.** It's almost never the right call:

- Pending rows you truncate become missed jobs.
- The cleanup task runs on its own schedule — let it. If it isn't running, fix that.
- If the table is genuinely runaway, lower `history_success_lifetime` and let cleanup catch up over a few cycles.

---

## Step 5 — The Consumer Runner

`cron_consumers_runner` in `env.php` makes the `consumers` cron group spawn RabbitMQ consumers. This replaces Supervisor/systemd in environments where you can't run a process supervisor.

```php
// app/etc/env.php
'cron_consumers_runner' => [
    'cron_run' => true,                  // master switch
    'max_messages' => 1000,              // each consumer exits after this many — restart prevents memory creep
    'consumers' => [],                   // [] = all registered consumers; or a list to whitelist
    'multiple_processes' => [
        'product_action_attribute.update' => 4,   // run 4 parallel workers for hot consumers
    ],
],
```

When `cron_run` is `true`, the `consumers_runner` job in the `consumers` group fires every minute, scans `queue:consumers:list`, and starts any consumer that isn't already running. Consumers exit after `max_messages` and the next cron tick respawns them.

**Common interactions**:

- Cron not running → consumers don't start → `queue_message` backlog or RabbitMQ queue depth grows. Diagnose by checking `cron_schedule` for the `consumers_runner` job before blaming the broker.
- `cron_run: false` and no Supervisor → consumers never start. Either flip the flag or run a supervisor.
- `max_messages: 0` (or absent) → consumers run forever, leak memory, get killed by the kernel. Always set ≥ 1000.
- `multiple_processes` only applies to consumers that explicitly support concurrency (idempotent handlers). Most don't — leave the default.

---

## Step 6 — Disabling a Job Without Removing Code

Set the schedule to a date that never occurs. The classic "Feb 30" trick:

```xml
<!-- system.xml field, then default in config.xml: -->
<default>
    <vendor_module>
        <cron>
            <inventory_sync_schedule>0 0 30 2 *</inventory_sync_schedule>
        </cron>
    </vendor_module>
</default>
```

`30 2` (day 30 of February) never matches, so the job is parsed but never scheduled. Cleaner than commenting out the `<job>` block because the code still ships and admins can re-enable via system config.

For built-in jobs, use `system/cron/{group}/jobs/{job_code}/schedule/cron_expr` overrides in `app/etc/config.php` or `env.php`:

```php
'system' => [
    'default' => [
        'crontab' => [
            'default' => [
                'jobs' => [
                    'newsletter_send_all' => [
                        'schedule' => ['cron_expr' => '0 0 30 2 *'],
                    ],
                ],
            ],
        ],
    ],
],
```

---

## Step 7 — Distributed Cron (Multi-Node Deployments)

In a multi-node deploy (web1, web2, web3 all running Magento), only **one** node should run cron. Two patterns:

### Pattern A — Hostname allowlist (simplest)

Install OS cron on every node, but guard `cron:run` with a hostname check:

```bash
* * * * * [ "$(hostname -s)" = "web1" ] && /usr/bin/php /var/www/html/bin/magento cron:run >> /var/www/html/var/log/magento.cron.log 2>&1
```

If `web1` dies, you have to manually elect another. Adobe Commerce Cloud uses a managed variant of this — the platform pins cron to one container.

### Pattern B — Lease via row locking

Cron's row-level lock means it's *technically* safe to run on every node, but you'll multiply DB load and risk cleanup-vs-dispatch races. Don't rely on this; pick one node.

**Why this matters**: every cron tick reads/writes `cron_schedule`. Three nodes running cron = 3× the dispatcher load and contention on the same rows. Symptoms: lock-wait timeouts on `cron_schedule`, duplicate handler-side state writes if a job has its own non-locking dedupe.

---

## Step 8 — Common Pitfalls and How They Surface

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `cron_schedule` empty | Dispatcher never ran — OS cron not installed, or `MAGE_MODE=production` writeable check is failing | `bin/magento cron:install`; check `crontab -l`; check `var/log/cron.log` |
| Rows pile up as `pending` then flip to `missed` | `bin/magento cron:run` is not being called every minute | Confirm system cron tick: `grep CRON /var/log/syslog` (or systemd `journalctl -u cron`) |
| One job is always `error` | Handler is throwing | `SELECT messages FROM cron_schedule WHERE job_code='X' ORDER BY scheduled_at DESC LIMIT 5;` then fix the handler |
| Most jobs `missed`, one node | OS cron is ticking but `bin/magento cron:run` is taking >1 minute and overlapping with itself | Profile the long job; move it to a group with longer `schedule_lifetime` and `use_separate_process=1` |
| `cron_schedule` table is millions of rows | `history_success_lifetime` too high or cleanup task itself is failing | Lower `history_success_lifetime`; check that the cleanup job is in `success` state |
| Queue not draining despite `cron_consumers_runner: cron_run: true` | The `consumers` cron group itself isn't being dispatched | Check `cron_schedule` for `job_code='consumers_runner'`; ensure no `--group=default` exclusivity in the OS crontab |
| Adobe Commerce Cloud — cron jobs not running | Editing the host crontab instead of `.magento.app.yaml` | On Cloud: only `crons:` in `.magento.app.yaml`. `cron:install` is a no-op |
| Two nodes both running cron | Both have OS crontab installed | Pick one node; use hostname guard or remove crontab on the others |
| Job runs but log says nothing | `bin/magento cron:run` swallows successful job output unless verbose | Add explicit `$logger->info()` in handler; or run with `--bootstrap=standaloneProcessStarted=1` |
| `setup:upgrade` fails after adding `crontab.xml` | Schema cache stale | `bin/magento cache:clean config`; re-run `setup:upgrade` |

---

## Step 9 — Monitoring Cron in Production

Minimum viable monitoring:

```sql
-- Alarm if any job has > 5 errors in the last hour
SELECT job_code, COUNT(*) AS errs
  FROM cron_schedule
 WHERE status = 'error'
   AND scheduled_at > NOW() - INTERVAL 1 HOUR
 GROUP BY job_code
HAVING errs > 5;

-- Alarm if oldest pending is more than 10 minutes old
SELECT MIN(scheduled_at) AS oldest_pending
  FROM cron_schedule
 WHERE status = 'pending';

-- Alarm if cron table has more than 500k rows (cleanup mis-tuned)
SELECT COUNT(*) FROM cron_schedule;
```

Log files to watch:

| File | What it tells you |
|------|-------------------|
| `var/log/cron.log` | Dispatcher start/stop, per-group summaries |
| `var/log/exception.log` | Handler-side throws |
| `var/log/system.log` | Application-level cron events |
| `var/log/support_report.log` | Adobe support report — includes cron status section |
| OS `journalctl -u cron` / `/var/log/syslog` | Whether the OS-level crontab is even firing |

Adobe Commerce Cloud equivalent: the platform UI has a "Cron Jobs" panel and the `magento-cloud activity:list` CLI; the same SQL queries work against the production DB.

---

## CLI Reference

```bash
# Install/remove the OS crontab entries
bin/magento cron:install
bin/magento cron:remove

# Run cron — one tick of all groups
bin/magento cron:run

# Run a single group (faster for triage)
bin/magento cron:run --group=default
bin/magento cron:run --group=index
bin/magento cron:run --group=consumers

# 2.4.7+ — run a single named job once, ignoring schedule
bin/magento cron:run --group=default --bootstrap=standaloneProcessStarted=1

# Reset stuck running rows (older Magento versions)
mysql -e "UPDATE cron_schedule SET status='error',
                 messages=CONCAT(IFNULL(messages,''),'\n[manual] reset')
           WHERE status='running' AND executed_at < NOW() - INTERVAL 1 HOUR;"
```

---

## File Layout for a New Cron Job

```
app/code/Vendor/Module/
├── etc/
│   ├── crontab.xml              # <job> declaration
│   ├── cron_groups.xml          # only if introducing a new group
│   ├── system.xml               # only if using <config_path>
│   ├── config.xml               # default schedule when using <config_path>
│   └── adminhtml/
│       └── system.xml           # admin UI for the schedule field
├── Cron/
│   └── NightlyExport.php        # handler — strict types, constructor injection
└── etc/module.xml
```

---

## Instructions for LLM

- **Always identify the environment first** — on-prem (OS crontab via `cron:install`) vs Adobe Commerce Cloud (`.magento.app.yaml crons:`) vs containerised with external scheduler (Kubernetes `CronJob`, systemd timer). The fix differs.
- **Never recommend `TRUNCATE cron_schedule`** — pending rows become missed jobs; bloat is a `history_*_lifetime` tuning problem.
- **Always set `max_messages` for `cron_consumers_runner`** in production — long-running consumers leak memory and get OOM-killed.
- **Distributed deploys: only one node runs cron** — running on every node multiplies DB load and contends on `cron_schedule` rows.
- **Pair `<config_path>` with both `system.xml` (admin UI) and `config.xml` (default)** — without the default, the job's schedule is empty until an admin saves the form.
- **Never use `ObjectManager::getInstance()` in cron handlers** — handlers are constructed via DI; inject what you need.
- **Per-job exceptions don't break the dispatcher** — Magento marks the row `error` and moves on. Don't add try/catch that swallows errors silently; let them surface in `cron_schedule.messages`.
- **`schedule_lifetime` must be ≥ the job's actual runtime** — a 20-minute reindex in a group with `schedule_lifetime=15` will get marked `missed` while still running.
- **Adobe Commerce Cloud users should not run `bin/magento cron:install`** — it's a no-op there. Edit `.magento.app.yaml crons:` instead.
- **Default `<schedule>` to literal cron syntax unless admins genuinely need to retune without a deploy** — `<config_path>` is more flexible but adds two more files (system.xml + config.xml).
