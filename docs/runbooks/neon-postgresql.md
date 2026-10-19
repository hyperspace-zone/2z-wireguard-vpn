# Production PostgreSQL в Neon

## Разделение хранилищ

Операционная БД `hyperspace`: PostgreSQL 18, Neon AWS Frankfurt
(`aws-eu-central-1`), проект `hs-production` / `fancy-bird-44800510`, ветка
`production` / `br-silent-firefly-batnqyb9`. Endpoint:
`ep-small-resonance-bauifcjf.c-8.eu-central-1.aws.neon.tech:5432`.

Здесь остаются пользователи, авторизация, биллинг и кошельки, VPN-сессии,
assignments, reconciliation jobs, каталог gates и оперативный учёт трафика.
Результаты измерений **и задания probes** остаются в MongoDB Atlas. Probes worker
читает SQL-каталог отдельной ролью без доступа к биллингу. Распределённых
транзакций между PostgreSQL и Mongo нет.

Launch, autoscaling **0,25–0,5 CU**: минимум экономит credits, максимум оставляет
ограниченный запас для коротких пиков. Во время bulk restore допустимо временно
поднять compute; после операции вернуть диапазон. Фоновые SQL-циклы поддерживают
compute активным, поэтому рассчитывать на экономию от scale-to-zero нельзя.
История восстановления — **7 суток**. Это rolling PITR, а не семь ежедневных
независимых файлов. Приблизительный месячный расход проверять в Neon Billing:
compute CU-hours + storage + объём истории восстановления, не размер старого VPS.

## Подключения и права

На control-plane используются только:

| Процесс | Настройка | Роль |
|---|---|---|
| API | `/etc/hyperspace/control-plane-api.env`, `DATABASE_URL` | `hyperspace` |
| Core worker | `/etc/hyperspace/control-plane-worker.env`, `DATABASE_URL` | `hyperspace` |
| Probes worker | `/etc/hyperspace/probes-worker.env`, `PROBES_CATALOG_DATABASE_URL` | `hyperspace_catalog_reader` |

`hyperspace` — владелец прикладной БД и схемы для совместимости с migrations,
но **не superuser**, без `CREATEDB`/`CREATEROLE`. `hyperspace_owner` — отдельная
управляющая роль Neon, не runtime identity API. `hyperspace_monitor` имеет
`pg_monitor`. Каталожная роль имеет SELECT только на `gates`, `gate_conditions`,
`gate_leases`, `gate_status`, `trading_probe_auth_tokens`, `trading_probe_nodes`,
`trading_probe_targets`, а также только колонки `id, gate_id, phase` таблицы
`gate_agent_deployments`. Последнее разрешение не видно в `table_privileges`:
проверять также `column_privileges`. Восстанавливать права через
`scripts/db/neon-catalog-grants.sql`, затем проверять **весь** catalog-sync,
а не только `SELECT FROM gates`.

Используется direct endpoint с ограниченными application pools, TLS
`sslmode=verify-full`. Не заменять hostname на IP или CNAME `db.hyperspace.zone`:
сертификат и маршрутизация Neon рассчитаны на endpoint hostname. Не отключать
проверку сертификата. Пароли и URI находятся **вне Git**: на dev-сервере
`/root/hyperspace/.provider_creds/neon/hyperspace-runtime.json` и на control-plane
`/etc/hyperspace/neon-runtime.json`, права `0600`.

`scripts/db/configure-neon-runtime.mjs` проверяет оба URI и все три env-файла,
сохраняет оригиналы в `before-neon-*` и заменяет только SQL-подключения. Он не
трогает ключи шифрования, Solana RPC, Mongo или сервисы. Запускать только в
maintenance-окне после проверки восстановленной БД. Сам по себе этот скрипт
**не выполняет миграцию**.

## Бэкапы и восстановление

**Обновление 19.10.2026:** задачи перенесены на AWS observability, независимые
бэкапы/архивы — в R2. Актуальная установка, retention, проверка восстановления и
порядок отключения старой VM: [PostgreSQL R2 backups](postgresql-r2-backups.md).
Ниже сохранён контекст первоначального переноса PostgreSQL в Neon; ссылки на
Cherry maintenance host/NFS описывают переходный этап, а не текущую зависимость.

1. В Neon включена 7-дневная история для point-in-time recovery. Для аварийного
   восстановления сначала создать **отдельную ветку** от production с выбранным
   `parent_timestamp`, проверить её, и лишь затем переключать приложение.
   Не выполнять разрушительный reset live-ветки для проверки восстановления.
2. Старые dumps и архивы остались на прежнем Cherry NFS
   `/mnt/hyperspace-backup/postgresql` и `/mnt/hyperspace-backup/history-archive`.
   Финальный снимок до миграции имеет имя `hyperspace-pre-neon-*.dump` и SHA-256.
3. Бывшая DB VM `84.32.51.45` временно служит **клиентом** бэкапов, архивации и
   мониторинга Neon, а не PostgreSQL-сервером. Ежедневный dump сохраняется туда же,
   retention — три последних штатных dump. Ручные снимки не удаляются retention.
4. Weekly restore drill создаёт отдельную новую БД, восстанавливает dump,
   проверяет constraints/таблицы/права и только после успеха удаляет тестовую БД.
   Неуспешная копия остаётся для анализа. Это даёт временную дополнительную
   storage/compute-нагрузку; запускать в тихое окно, без parallel restore.

На maintenance host нужен **postgresql-client-18**, не сервер PostgreSQL 18.
Клиент 16 не умеет делать dump сервера 18. Установить из подписанного PGDG
репозитория, не устанавливая пакет `postgresql-18`.

Для каждого из `hyperspace-db-backup`, `hyperspace-db-restore-check`,
`hyperspace-db-history-archive`, `hyperspace-postgres-health-exporter` установить
актуальный base unit из репозитория и drop-in из
`infra/systemd/hyperspace-postgres-managed.conf`. Зависимости `Requires=` нельзя
сбросить пустой строкой в systemd drop-in: нужно заменить старый base unit,
ссылавшийся на `postgresql.service`. Новые units не запускают локальный
PostgreSQL, но сохраняют NFS mount checks и лимиты.
В конце drop-in добавить соответствующий root-only `EnvironmentFile`:

| Сервис | Последний env-файл |
|---|---|
| backup, restore-check | `/etc/hyperspace/neon-backup.env` |
| history-archive | `/etc/hyperspace/neon-archive.env` |
| health-exporter | `/etc/hyperspace/neon-monitor.env` |

Эти файлы содержат `PGHOST`, `PGPORT=5432`, `PGDATABASE=hyperspace`, `PGUSER`,
`PGPASSWORD`, `PGSSLMODE=verify-full`,
`PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt`, `PGCONNECT_TIMEOUT=15`,
`HS_POSTGRES_MANAGED=1`. Для restore нужны также
`HS_CORE_DATABASE_OWNER=hyperspace`, `HS_DB_MAINTENANCE_DATABASE=hyperspace`.
Управляющие credentials используются только backup/restore сервисами;
архиватор использует прикладную роль, мониторинг — мониторинговую.

Managed globals dump не содержит password hashes; он служит справкой, а не
SQL-скриптом для слепого replay системных ролей Neon. Restore pre-creates
extensions управляющей ролью, затем восстанавливает application objects от
`hyperspace`, без исходных ACL/owners. Read-only catalog grants восстановить
перед promotion. Секреты wallet/artifact encryption также должны быть сохранены:
одного SQL dump недостаточно для расшифровки кошельков и WireGuard-конфигов.

## Архивирование и мониторинг

Архивирование сохраняет прежние сроки (операционные jobs 30 дней,
traffic samples/deltas 90 дней), формат JSONL+zstd и удаление только после
проверенного архива. Для маленького Neon compute ограничены batch и активные
запросы; CPUQuota на maintenance host ограничивает только клиент/сжатие,
**не удалённый PostgreSQL**. Remote backend PID никогда не используется для
локального `renice`/`ionice`.

`repair-core-probe-guards.sql` исправляет statement-trigger на row-trigger:
пустой FK UPDATE при удалении старой job разрешён, но настоящая INSERT/UPDATE
probe-строки в core по-прежнему запрещена. Repair откажется, если core ещё
содержит probe jobs/measurements.

Prometheus проверяет TCP самого Neon endpoint, а postgres_exporter на maintenance
host подключается к Neon через TLS. `HyperspacePostgreSQLDown` срабатывает и при
`up=0`, и при `pg_up=0`: доступный HTTP exporter не означает доступную БД.
DB-health метрики подписаны hostname Neon; backup/archive/host alerts указывают
реальную Cherry VM. Недоступный `pg_ls_waldir()` не вызывается для managed PG,
WAL-size series не подменяется нулём. При SQL-ошибке health exporter не обновляет
timestamp последнего успешного сбора; сохраняется stale-monitoring alert.

DB pool обрабатывает error events как idle, так и checked-out соединений.
При обрыве внутри транзакции вызывающий код получает исходную ошибку,
непригодное соединение удаляется из pool. Автоматического replay транзакции нет:
при потере ответа на COMMIT результат может быть неопределённым, поэтому
повторять финансовую операцию можно только с её штатным idempotency key.

## Безопасный перенос и граница отката

1. Пробное восстановление в отдельную БД; auth/billing/idempotency и SQL permission
   tests, реальные read-model queries из control-plane. Никаких реальных выплат
   или писем во время rehearsal.
2. Остановить API/core/probes workers и DB maintenance writers. Включить на старой
   БД `default_transaction_read_only=on`, закрыть прежние application connections.
3. Финальный consistent dump, SHA-256, restore в новую БД. Сверить все таблицы,
   sequences, schema, constraints; критичные таблицы дополнительно по checksum.
   Сохранять все записи, не совмещать cutover с очисткой финансовой истории.
4. После сверки переключить три SQL URI; Mongo и encryption keys не менять.
5. **До запуска writers в Neon** разрешён откат env и снятие source read-only.
   **После запуска writers** старый snapshot уже может отставать: слепой откат
   запрещён, иначе потеряются новые платежи/изменения. Сначала fence Neon и
   отдельный согласованный обратный перенос/восстановление.
6. Проверить API, authenticated SQL access, billing state, gate heartbeats,
   benchmarks/trading, бэкап и recovery. Остановить/disable/mask локальные
   `postgresql@16-main`, `postgresql@16-probes`, `postgresql.service` и повторить
   проверки production при закрытых локальных портах 5432/5433.

Старую VM **не выключать автоматически**. Приложение не должно зависеть от неё,
но до удаления нужно перенести или осознанно заменить NFS-бэкапы/архиватор,
мониторинг и recovery scripts, например на R2 и другой maintenance host.
DNS `db.hyperspace.zone` пока обозначает старую VM; перед её удалением убрать
эту A-запись и старые monitoring targets. Не перенаправлять A-запись на IP Neon.

Документация провайдера: [migration](https://neon.com/docs/import/migrate-from-postgres),
[point-in-time branches](https://neon.com/docs/introduction/branching),
[roles](https://neon.com/docs/manage/roles).
