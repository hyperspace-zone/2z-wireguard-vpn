# Измерения в MongoDB, операционные данные и очередь в PostgreSQL

## Границы

Core PostgreSQL `hyperspace:5432` не меняется: пользователи, авторизация,
wallets/payments/ledger, VPN sessions/assignments, reconcile/deployment jobs.
Его ежедневные backups и weekly restore drill обязательны.

Probes PostgreSQL `hyperspace_probes:5433` остаётся для synthetic queue,
leases/heartbeat, mirror каталога/targets/tokens и небольшого scheduler state.
MongoDB хранит **только** измерения. Она не участвует в финансовой транзакции,
core startup/health или применении WireGuard assignments.

## Доставка

Отчёт агента в одной локальной probes PG transaction завершает job/attempt,
обновляет `probe_measurement_schedule` и вставляет `measurement_delivery_outbox`.
Scheduler работает с этими сроками и очередью, без обращения к MongoDB.
Attempts в Mongo-режиме не дублируют подробные результаты измерений.

Отдельный bounded loop probes worker отправляет outbox в Mongo. После
подтверждения удаляет только конкретный event из PG. При сбое/краше повторяет:
Mongo event ID уникален, latest обновляется только более новым measuredAt,
rollup — по стабильному ключу пятиминутного bucket. Дубликаты не увеличивают
счётчики и не создают повторный benchmark-цикл. Нет PG↔Mongo transaction.
Запись подтверждается с `w:1,j:true` (journal fsync); replica set/HA здесь нет.

Это at-least-once доставка, не exactly-once. Временный журнал — не архив.
Повтор после частичной записи восстанавливает latest/rollup. При полной потере
Mongo уже подтверждённые данные не восстанавливаются из очищенного outbox:
новые измерения заново наполнят dashboards, потеря истории допустима.

При недоступной Mongo dashboards могут показывать явно stale cache либо 503;
они не должны выдавать устаревшее за live. Обычный VPN работает. Выбор нового
trading preset по-прежнему требует свежих измерений до оплаты.

## Коллекции и retention

- `benchmark_results`, `trading_results`: compact summaries, TTL 24 часа.
- `benchmark_latest`: два последних разных события на route/transport;
  сохраняет старое measuredAt для stale alerts, не переписывает его временем
  доставки. Same DZ metro исключается при построении matrix/metrics.
- `trading_latest`: одна запись node/target/network profile, без TTL;
  старые значения не становятся fresh от переподключения Mongo.
- `trading_rollups`: последняя summary в пятиминутном bucket, TTL 14 дней.
  Это существующая семантика проекта, не точный объединённый percentile по всем
  пакетам/запросам bucket.

Используются обычные collections с unique `_id`, а не time-series: нужны
идемпотентные upserts. Samples/response bodies не сохраняются, error message
ограничено 512 символами. TTL асинхронен и не гарантирует размер базы в байтах.
Disk/логические bytes/index bytes и рост delivery backlog мониторятся отдельно.

## Production host и безопасность

Mongo host: `88.216.62.149`, Ubuntu 24.04, standalone MongoDB Community 8.2.
HWE `7.0.0-38-generic` содержит upstream Linux **7.0.14** — проверить
`/proc/version_signature`, не только `uname`. Linux 6.19–7.0.13 несовместим
с MongoDB/TCMalloc. MongoDB 8.0.32 также ошибочно блокирует это исправленное
Ubuntu HWE; на этой машине используется 8.2.12, без обхода startup protection.
См. [официальные ограничения ядра](https://www.mongodb.com/docs/manual/release-notes/8.2/).
Новая приватная подсеть `10.184.2.0/24` не доступна старому control-plane private
network `10.179.228.0/24`. Поэтому используется публичное соединение с TLS,
проверкой CA и паролем; UFW разрешает TCP/27017 только от `5.199.161.13`.
TCP/22 сохраняется; TCP/9100 допускается только с observability `84.32.83.71`.
При переводе обеих машин в общую private сеть проверить маршрут и сменить URI.

WiredTiger cache 512 MiB; service MemoryHigh 1280M/Max 1536M, CPUQuota 150%.
Это одна машина без HA: история measurements expendable, Mongo outage
обрабатывается отдельно от core. Не добавлять сюда wallet/payment secrets.

Runtime: `MEASUREMENTS_MONGO_URL` и `MEASUREMENTS_MONGO_CA_FILE` в API и probes
worker; **не** в core worker. На CP credentials:
`/etc/hyperspace/measurements-mongo.env`, mode 0600; CA certificate — readable
для runtime `hyperspace`. URI/пароли не коммитить и не логировать.
После изменения этого env выполнить
`node /opt/2z-wireguard-vpn/scripts/db/configure-mongo-runtime.mjs` и restart
только API/probes worker: значения копируются в их service env. Core worker
не использует Mongo. Сертификат сервера действует год: заранее обновить с тем же CA либо ротировать
CA и runtime files. При Atlas использовать обычную проверку публичного TLS
certificate, убрать self-hosted CA override и заменить URI.

## Выкатка и откат

1. На пустой Mongo host stage `infra/mongodb` и installer/bootstrap scripts;
   выполнить `install-measurements-mongo`. Он отказывается перезаписывать
   существующие credentials.
2. Применить probes migrations (outbox и scheduler state), не core migrations.
3. Выполнить `copy-measurements-mongo.mjs`: 14 дней rollups, последние значения,
   последние две benchmark samples и raw benchmark summaries за 24 часа.
   Source read-only; node/target IDs и measuredAt сохраняются. Исторические
   raw trading reports не создаются искусственно из отсутствующих исходников.
4. Запустить live Mongo integration tests в отдельных временных collections.
   Сохранить старый runtime/env и контрольный probes measurement dump вне git.
5. Включить Mongo URI в API/probes worker, выкатить сборки, повторить copy с
   `--latest-only`: запоздалый final-copy не переписывает новые Mongo results.
   Повторить короткое backfill-окно, например `MEASUREMENTS_COPY_DAYS=0.09`,
   чтобы захватить buckets, созданные во время первоначального keyset-copy.
6. Проверить freshness/матрицу/Trading API, queue/outbox и core health. Сделать
   краткий Mongo outage drill: core health/gates и scheduler живы, outbox растёт,
   после восстановления полностью доставляется.
7. Только после сверки выполнить `finalize-mongo-measurements --mongo-cutover-verified`
   на DB host: он проверяет checksum/readability контрольного dump и здоровую
   доставку, очищает ровно три старых measurement tables и блокирует legacy writes.
   Schema остаётся для rollback; jobs/catalog/outbox не очищаются. Workers/API
   не нужно останавливать для этой короткой transaction.

До очистки PG вернуть старые env/runtime и убрать Mongo URI. После очистки для
точного historical rollback восстановить контрольный measurement dump; для
возобновления новых измерений достаточно пустых SQL tables и legacy runtime.
Перед возвратом SQL writers снять три `mongodb_measurement_storage` triggers;
не удалять каталог, jobs или billing данные. Например:
`DROP TRIGGER mongodb_measurement_storage ON trading_latency_latest;`
и аналогично на `trading_latency_rollups`, `gate_benchmark_results`.
Нельзя очищать недоставленный outbox. Старый runtime не знает outbox: сначала
доставить backlog либо оставить новый delivery worker до его опустошения.

Постоянный backup measurement history не нужен. Credentials/CA/configuration
сохранять отдельно в защищённом recovery archive; core backup не заменяет их.

## Проверки и алерты

Public read filters, snapshots, budgets и настройка Cloudflare:
[Публичные измерения — производительность и защита](public-measurement-performance.md).

Unit tests: local transaction context, no SQL measurements in Mongo mode,
scheduler independent of Mongo, durable retry/backoff, ack-specific deletion,
same-metro N/A и invalid timestamps. Live Mongo: replay/out-of-order/latest-two,
literal `$` strings, expired data и TTL indexes. API/core isolation tests
остаются обязательными.

`HyperspaceMeasurementsMongoUnavailable` и
`HyperspaceMeasurementsDeliveryBacklog` — warning;
`HyperspaceMeasurementsMongoDiskCritical` — critical (<4 GiB **или** <15%).
Host node exporter monitoring также покрывает новую Mongo VM.

## Live production, 7 октября 2026

- SSH по mainnet gatekeeper key проверен. Ubuntu 24.04.4 полностью обновлена;
  HWE `7.0.0-38-generic` (upstream 7.0.14), reboot выполнен, MongoDB 8.2.12.
- Core: **4992 MiB**, users **3054**, sessions **272**, assignments **520**,
  ledger **9** entries / **225310000** minor SOL units — до/после одинаковые.
- Probes PostgreSQL после очистки measurement tables: **501 MiB** вместо
  примерно **1241 MiB**. Его фиксированный loopback filesystem всё ещё 16 GiB;
  это не уменьшение оплачиваемого диска/инстанса. Старые подробные attempt
  summaries выбывают по двухдневному retention, новые attempts содержат только
  минимальный execution status/error, не показатели latency.
- Mongo: **1 731 208** rolling bucket документов в момент сверки; все **960**
  source latest скопированы, missing/behind **0**. Около **865 MiB** logical
  data, **435 MiB** storage+indexes на SSD; TTL продолжает удалять старые данные.
- Публичные API после переключения и очистки SQL: **9** gates, **72** routes,
  trading **9** nodes / **30** enabled targets / **270** measurements.
  Legacy SQL read раньше возвращал также measurements disabled targets; Mongo
  read фильтрует их по текущему каталогу. Последние измерения свежие.
- Краткий outage drill: Mongo остановлена, health/gates **200**, dashboard
  endpoints **503** за ~1.3 секунды, backlog **7→23**, scheduler completion
  продолжал обновляться. После запуска Mongo endpoints **200**, backlog
  доставился (контрольная сверка **0**). Core worker PID **1726341** / uptime
  от 6 октября не менялся. Это не тест потери host или replica-set failover.
- Unit/typecheck/build и live Mongo integration tests прошли; Mongo tests **9/9**,
  DB provisioning/backup helpers **19/19**. Применены 7 DB-isolation alert rules,
  Mongo node exporter target **up=1**.
- Runtime rollback: `/opt/hyperspace-rollbacks/mongo-measurements-20261007T072806Z`.
- Разовый временный migration checkpoint (не ongoing measurement backup):
  `/mnt/hyperspace-backup/postgresql/probes-before-mongo-20261007.dump`
  (**115 MiB**) + `.sha256`. Удалить после окончания rollback window, например
  через 14 дней. Операционные daily backups/weekly full restore drills сохраняются.
- Зашифрованные recovery configs на NFS:
  `core-runtime-20261007.tar.gz.gpg`, `mongo-configuration-20261007.tar.gz.gpg`
  в `/mnt/hyperspace-backup/postgresql/`; passphrase только на dev VM:
  `/root/hyperspace/.provider_creds/db-isolation/core-recovery-passphrase`.
  Администратору обязательно сохранить passphrase офлайн.
