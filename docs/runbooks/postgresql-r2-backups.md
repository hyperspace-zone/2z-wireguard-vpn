# PostgreSQL: бэкапы и архивы в R2

## Production после переноса 19 октября 2026

Операционная БД работает в Neon, PostgreSQL 18, AWS Frankfurt. MongoDB Atlas
хранит измерения и probe jobs; эта процедура MongoDB не меняет.

Задачи backup, restore drill, SQL history archive и мониторинг PostgreSQL
исполняются на **observability.hyperspace.zone — 63.186.214.137** (AWS Lightsail).
Сервер PostgreSQL там не установлен: нужен только `postgresql-client-18`.
API/control-plane не выполняет компрессию, загрузку архивов или restore drills.

Хранилище: приватный EU bucket `hyperspace-production-db-backups`, Standard.
Endpoint: `https://8aa2884a007033305a6e676660f9bb18.eu.r2.cloudflarestorage.com`,
S3 region `auto`. Не добавлять имя bucket к endpoint. Не включать public URL,
custom domain или CORS. Токен: Object Read & Write **только для этого bucket**.
Уточнить исходящие IPv4 в allowlist; клиент принудительно использует IPv4.

| Префикс R2 | Содержимое | Retention |
|---|---|---|
| `legacy/cherry-20261019/postgresql/` | Все исходные NFS dumps, ручные снимки, SHA-256, globals, зашифрованные recovery-конфиги | Не удаляется автоматически |
| `legacy/cherry-20261019/migration-inventory/` | Полная опись переноса с размерами и SHA-256 | Не удаляется автоматически |
| `history-archive/<cluster>/<dataset>/<UTC-day>/` | Старые и новые JSONL.zst-архивы | Не удаляется автоматически |
| `backups/mainnet/hyperspace/<UTC-timestamp>/` | Новые дампы Neon, globals и SHA-256 | Две последние проверенные генерации |

Каждый bundle получает `_VERIFIED.json` **после** загрузки и полного чтения всех
его объектов обратно с проверкой SHA-256 и размера. ETag не используется вместо
SHA-256. При повторе существующий объект с другим содержимым не перезаписывается.
403/timeout не считаются отсутствием backup. Credentials и signed URLs не
попадают в логи. Старые исходники на Cherry при переносе не удаляются.

## Расписание и ограничения

- Еженедельный backup: воскресенье 02:15 UTC, jitter до 15 минут.
- Архивация: каждый час, jitter до 10 минут; operational jobs — 30 дней,
  assignment samples/deltas — 90 дней. Ledger, пользователи и VPN state не чистятся.
- Полный restore drill: первое число каждого месяца 04:30 UTC, jitter до 15 минут.
- SQL/R2 health: каждую минуту.

С 20.10.2026 R2 installer устанавливает timer drop-ins `r2-schedule.conf`:
они сбрасывают базовый `OnCalendar` перед новым расписанием. Базовые daily/weekly
timers для иных установок не меняются. `Persistent=true` сохраняется.
Для существующей установки дополнительно обновить `/etc/hyperspace/r2-maintenance.env`
(installer не перезаписывает существующий env):

```dotenv
HS_DB_BACKUP_KEEP_LAST=2
HS_DB_BACKUP_MAX_AGE_SECONDS=691200
HS_DB_BACKUP_CRITICAL_MAX_AGE_SECONDS=864000
HS_DB_OFFSITE_BACKUP_MAX_AGE_SECONDS=691200
HS_DB_RESTORE_CHECK_MAX_AGE_SECONDS=3024000
```

Health exporter публикует эти лимиты для Prometheus: warning по локальному
dump после 8 суток, critical после 10; critical по R2 после 8 суток; critical
по restore drill после 35 суток. Missing backup/R2 unavailable alerts не
ослабляются. При отсутствии новых метрик правила используют прежние лимиты
36/72 часа и 9 суток. После обновления exporter/rules выполнить health collection,
проверить `promtool`, reload Prometheus и перезапустить только два timer.
Почасовая архивация и 7-дневный PITR Neon остаются без изменений.

Все три тяжёлые задачи используют общий `flock`, поэтому не выполняются
одновременно. Лимит клиентского CPU — 25% одного ядра, MemoryHigh 256 MiB,
MemoryMax 512 MiB, low I/O priority, timeout 2 часа. **CPUQuota не ограничивает
удалённый Neon**: там остаются небольшой batch (1000 строк), максимум 100 batches,
одна дневная порция на dataset, ожидание при >4 активных запросах и отсутствие
parallel restore/export. Диапазон Neon compute эта процедура не меняет.

Локально: `/var/backups/hyperspace` — два последних dump и временный архивный spool.
Архиватор удаляет строки из SQL только после проверки локального файла и копии
в R2. При R2 failure не удаляет SQL-строки. Если удалена только часть дня, следующий
запуск продолжает по исходному архиву, при необходимости скачивая его из R2.
После завершения удаления публикуется `COMPLETE`; только после проверки этого
bundle локальный дневной spool очищается. Отдельно контролируется запас места
локального spool (15%/10 GiB). Не задавать expiry lifecycle на весь bucket:
это уничтожило бы бессрочные архивы и ручные снимки.

## Установка на новом maintenance host

1. Установить из подписанного PGDG `postgresql-client-18` (не server), а также
   `python3-boto3`, `zstd`, `prometheus-postgres-exporter`. Exporter слушает только
   `127.0.0.1:9187`. Его подключение к Neon — отдельная monitor role.
2. Защищённо передать root-only, mode `0600`:
   `/etc/hyperspace/neon-backup.env`, `neon-archive.env`, `neon-monitor.env` и
   `/etc/hyperspace/r2-production-backups.env`.
3. R2 env содержит `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `HS_R2_ENDPOINT`,
   `HS_R2_BUCKET=hyperspace-production-db-backups`,
   `HS_R2_BACKUP_PREFIX=backups/mainnet/hyperspace`. Не source env в интерактивной
   сессии с `set -x`, не коммитить и не печатать значения.
4. Остановить старые backup/archive/restore timers и дождаться активных jobs.
   Запустить `bash scripts/db/install-r2-maintenance` из проверенного checkout.
   Installer не включает timers и не изменяет PostgreSQL server.
   Shared textfile collector по умолчанию `/var/lib/prometheus/node-exporter`;
   если node exporter настроен иначе, передать `HS_POSTGRES_METRICS_COLLECTOR_DIR`.
   PostgreSQL пишет в собственную `/var/lib/hyperspace/postgres-metrics`;
   shared collector содержит symlink. Не выдавать postgres права записи на
   общую папку: meta-watcher регулярно приводит её к 0755 и сломает такой вариант.
5. Последовательно выполнить и проверить exit status:

   ```bash
   systemctl start hyperspace-db-backup.service
   systemctl start hyperspace-db-restore-check.service
   systemctl start hyperspace-db-history-archive.service
   systemctl start hyperspace-postgres-health-exporter.service
   ```

6. Prometheus: убрать прежний DB-host node target; PostgreSQL exporter —
   `127.0.0.1:9187`. SQL-метрики получают service_host Neon, backup/archive/R2
   сохраняют service_host observability. Подключить `hyperspace-r2-backups.yml`.
   `HyperspacePostgreSQLR2Unavailable` — critical после 5 минут; существующие
   backup/restore/archive freshness/failure alerts остаются включены.
7. Только после успешных проверок включить timers на новом host и отключить
   старые timers/exporters. Не запускать два архиватора одной БД параллельно.

Dev-копия ключа вне Git:
`/root/hyperspace/.provider_creds/cloudflare_r2/hs-production-postgresql-backups-20261019.env`.
На рабочем host ключ — `/etc/hyperspace/r2-production-backups.env`.
После ротации заменить оба файла; oneshot-задачи читают ключ при следующем запуске.

## Восстановление

Monthly drill **скачивает последнюю подтверждённую генерацию из R2**, не берёт
локальный cached dump. Проверяет SHA-256 и `pg_restore --list`, создаёт новую БД
`hs_core_restore_check_<UTC>`, восстанавливает её полностью, проверяет обязательные
таблицы, constraints, ledger aggregation и права runtime role. Production URI не
меняется. Только после успеха тестовая БД и её локальная загрузка удаляются.
При сбое копия остаётся для анализа; повторные ошибки требуют убрать проверенные
оператором тестовые БД, чтобы не накапливать платное storage.

Для настоящего восстановления создать **новую** БД через
`hyperspace-pg-restore-core DUMP NEW_DATABASE`, проверить данные и права
(`scripts/db/neon-catalog-grants.sql`) и лишь затем отдельно переключать приложение.
Не replay provider-owned globals. Для кошельков и VPN-конфигов дополнительно
нужны encryption keys; SQL dump сам по себе их не заменяет. Сохранены зашифрованные
`core-runtime-*.tar.gz.gpg`; recovery passphrase остаётся отдельно вне Git:
`/root/hyperspace/.provider_creds/db-isolation/core-recovery-passphrase`.
Хранить защищённую независимую копию passphrase: потеря dev-машины не должна
сделать recovery-конфиги невосстановимыми.

7-дневный Neon PITR продолжает работать независимо от R2. Это другой механизм,
не замена проверке независимого dump.

## Тесты изменений

На dev host нужен `python3-boto3`. `npm run test:db-backup` запускает shell/SQL
contract tests и Python-тесты R2 с in-memory S3 (без настоящих credentials).
Проверяются corrupt read-back, 403 vs missing, immutable conflicts, SHA и
path traversal, retention только после успешной загрузки, сохранение spool при
ошибке и запрет SQL DELETE при неуспешной проверке R2.
Prometheus rule tests: `promtool test rules
infra/observability/prometheus/tests/hyperspace-r2-backups.test.yml` и существующие
DB/resource suites. После unit tests обязателен реальный restore drill.

## Удаление старой Cherry VM/NFS

20.10.2026 старые Cherry production VM штатно выключены: control-plane/API
`5.199.161.13`, web `84.32.83.69`, PostgreSQL `84.32.51.45`, observability
`84.32.83.71`. Старый MongoDB `88.216.62.149` был выключен ранее. Не включать
на них фоновые jobs, exporters или alert delivery: production и maintenance
работают на AWS, PostgreSQL — в Neon, MongoDB — в Atlas.
Power off не удаляет данные и не отменяет заказ VM/Backup Storage.

Не считать один успешный upload достаточным. Нужны: полная сверка migration
inventory, свежий backup с нового host, полный restore из R2, успешный archive
run, исправные Prometheus targets/alerts, остановленные старые timers/exporters.
Приложение не должно обращаться к старому IP. После этого VM и NFS можно удалить
отдельным решением оператора. Миграция не удаляет их автоматически.
