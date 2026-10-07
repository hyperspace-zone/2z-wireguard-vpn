# PostgreSQL: изоляция операционных данных и probes

## Цель и границы

Одна существующая DB VM, два независимых PostgreSQL 16. Core — `16/main`, порт
5432, БД `hyperspace`. Probes — `16/probes`, порт 5433, БД `hyperspace_probes`.
Это изоляция экземпляров, **не HA**: отказ VM/физического SSD затронет оба.

Probes использует полностью выделенный loopback ext4 том 16 GiB, включая data,
WAL и логирование. Выделение через fallocate заранее резервирует размер файла:
рост probes не потребляет оставшееся свободное место root. В systemd: RAM max
1536 MiB, CPU max 150%, низкие CPU/IO weights; в PostgreSQL ограничены connections,
work_mem, temporary files и длительность запросов. Core не перезапускается при
установке probes. На одном SSD нагрузку невозможно изолировать полностью.

При форматировании обязательно `mkfs.ext4 -E nodiscard`: default discard
превратил бы заранее выделенный файл в sparse и снял резервирование root space.
`protect-probes-volume` проверяет фактические allocated blocks, добавляет
`X-fstrim.notrim` в fstab и отключает discard через udev только для этого файла.
После reboot проверять mount, allocated blocks и `discard_max_bytes=0`.

## Владение данными

Core: пользователи, identities/auth, wallets и encryption-dependent данные,
платежи, ledger, VPN sessions/configs/artifacts/assignments, реальные gate
heartbeat/readiness, reconcile/apply/revoke/deployment jobs, usage для биллинга.
Также core хранит небольшую авторитетную конфигурацию trading probe nodes,
их token hashes и targets: она входит в операционный backup.

Probes: synthetic jobs/attempts, benchmarks, trading heartbeat/leases, latest
measurements и rollups. Пользователей, wallets, платежей и assignments там нет.
Очередь jobs допускает только `type=probe`, session_id и assignment_id — NULL.

Каталог копирует отдельный probes worker раз в 10 секунд. Core connection имеет
READ ONLY и SELECT лишь на каталог/статусы и конфигурацию probes. Сначала
завершается read-only core snapshot, затем начинается транзакция в probes:
нет distributed transaction/FDW/синхронной обратной записи. Старые lease expiry
не продлеваются копированием; отсутствие свежей копии делает данные устаревшими.
Ротация/отзыв probe token распространяется с задержкой до следующей успешной
синхронизации. Gate control requests всегда аутентифицируются в core.
В локальной mirror-таблице gate-host probes выключаются, если их gate в core
Disabled: retired hosts не создают synthetic jobs и stale-node alerts. Это не
меняет core config и не выключает standalone/testnode probes. При re-enable gate
заданный в core node state возвращается следующей синхронизацией.

## Приложение

API: `DATABASE_URL` — core, `PROBES_DATABASE_URL` — probes. Startup/health зависит
только от core. Public benchmarks/trading и trading probe agent requests идут в
probes. Core config/admin enrollment — в core. Core job claims/reports никогда не
ждут probes при штатных apply/revoke; synthetic claims идут отдельно. Для reports
старых агентов без lane сначала проверяется job в core, затем в probes, только
если core job не найден. Неизвестный job может ждать ограниченный probes timeout.

Core worker: `PROBES_SEPARATED=true`; synthetic schedulers и measurement snapshot
в этом процессе отключены. `hyperspace-probes-worker.service` запускает отдельный
entrypoint с read-only core catalog URL и probes URL, без wallet/payment secrets.
Сбой probes не меняет состояние core health, gate readiness или выдачу обычных
VPN. Только выбор нового trading preset требует доступных свежих measurements;
это проверяется до платежа, без cross-DB транзакции. Core scheduler повторно
проверяет реальные gates независимо от measurement snapshot.

## История probes

Следующий этап переводит только measurement storage в MongoDB, сохраняя эту
изоляцию очереди. См. [MongoDB measurements](mongodb-measurements.md).

Завершённые jobs/attempts и benchmarks: 2 дня. Rollups: 14 дней. Bounded cleanup
каждые 30 секунд, по 1000 parent rows с каскадным удалением attempts, lock timeout
500ms, без VACUUM FULL. Ни NFS, ни backup probes не нужны для continued operation.
При миграции сохраняются latest, benchmarks и последние 14 дней rollups; старая
история trading jobs остаётся в контрольном pre-cutover dump, не в новой hot DB.

## Backup core

`hyperspace-db-backup.timer` ежедневно. `HS_DB_BACKUP_PROFILE=core` исключает
только data measurement-таблиц; конфигурация probes и операционные данные
сохраняются. Три последних dumps на отдельном NFS, globals для ролей и SHA-256.
Ожидаемый RPO — до 24 часов (расписание ежедневное), это не continuous PITR.
Полный restore drill выполняется в новую временную БД, никогда поверх production.

Для восстановления encrypted wallets/configs требуются исходные значения
`CUSTODIAL_WALLET_ENCRYPTION_KEY`/`ARTIFACT_ENCRYPTION_KEY`, а также остальные
runtime secrets. Их recovery archive хранить шифрованным отдельно от БД;
пароль/ключ расшифровки сохранить вне DB/control-plane VM и не в Git.

## Восстановление core

1. Не менять live БД. Проверить доступность NFS и выбрать dump + checksum.
2. На новой VM установить PostgreSQL 16 и нужные extensions. Воссоздать роли из
   globals, аккуратно не перезаписывая существующие системные роли. Вернуть
   владельцев/права приложения; конфигурацию и encryption keys — из recovery archive.
3. `sudo -u postgres hyperspace-pg-restore-core DUMP hyperspace_recovered_TIMESTAMP`.
   Скрипт запрещает существующую destination, проверяет checksum, восстанавливает
   single transaction и проверяет core таблицы. Он не переключает live services.
4. Проверить ledger/payments/receipts, sessions, assignments и schema_migrations;
   сравнить контрольные totals. Для restored DB настроить application ownership/
   grants, затем применить новые миграции, если версия приложения их требует.
5. Остановить API/worker, направить `DATABASE_URL` в recovered DB, запустить и
   проверить read-only billing, gate heartbeat и reconcile. Не отправлять повторно
   уже подтверждённые платежи: использовать существующие идемпотентные receipts.
6. Исходную БД сохранить для отката до завершения проверки.

## Восстановление probes без backup истории

Создать свежий probes cluster/database, применить
`node packages/db/dist/migrate-probes.js` с `PROBES_DATABASE_URL`. Запустить probes
worker: каталог и token hashes придут из core, агенты начнут heartbeat и новые
jobs. Исторические результаты не восстанавливаются. После обновления схемы
дождаться fresh measurements; не выдавать устаревший trading preset за live.

## Выкатка и дальнейшее обслуживание

1. На DB host с variables `HS_DB_PRIVATE_IPV4`/`HS_CONTROL_PRIVATE_IPV4`
   выполнить `scripts/db/install-probes-instance`.
2. Скопировать `/etc/hyperspace/probes-instance.env` на control-plane с mode 0600.
   Стейджировать builds, обычные `packages/db/migrations`, новую директорию
   `packages/db/probes-migrations` и isolation scripts/unit.
3. Применить `migrate-probes.js`, сделать полный контрольный dump core,
   перенести каталог и online measurement pre-copy `copy-probes-data.mjs`.
4. `cutover-probes-runtime /opt/hyperspace-deploy/db-isolation-TIMESTAMP` останавливает
   API/worker для короткого frozen final-copy, сохраняет исходный runtime/env и
   автоматически возвращает их при ошибке. Старые core data он не удаляет.
5. Проверить `check-production-probes-isolation` и восстановление measurements.
6. После подтверждения `finalize-core-isolation` убирает только synthetic data из
   core, включает запрет synthetic writes и core backup/restore drill. В этом
   production migration helper зафиксированы конкретный pre-cutover dump и SHA;
   для нового контура сначала создать и указать его собственный checkpoint.
7. При следующих releases core выкатывать обычным `restart-after-migrations`,
   probes отдельно `scripts/control-plane/restart-probes-after-migrations`.
   Не добавлять optional probes migration в блокирующий core restart path.

Backup timer — ежедневно; `hyperspace-db-restore-check.timer` — воскресенье
04:30 UTC (+ jitter до 15 минут). Drill проверяет checksum, полное восстановление,
обязательные таблицы/constraints, права чтения и создания таблиц под runtime
ролью (`HS_CORE_DATABASE_OWNER`, default `hyperspace`), выводит ledger totals
для сверки; при успехе удаляет только
свою точную временную БД. При ошибке она остаётся для анализа. Запас свободного
core SSD должен позволять временную полную копию; CPUQuota drill — 50% одного CPU.

Prometheus получает synthetic metrics только с отдельного probes worker :9092
на private IP control-plane. `HyperspaceProbesWorkerDown`,
`HyperspaceProbesLoopUnhealthy`, `HyperspaceProbesFilesystemPressure` — warning.
`HyperspacePostgreSQLRestoreCheckStale` — critical после 9 дней без успешного
drill. Существующие core backup age/failure alerts остаются включены.

## Production: применение 6 октября 2026

- DB host `db.hyperspace.zone`, public `84.32.51.45`, private `10.179.228.12`.
- Core `16/main:5432`, DB `hyperspace`: после удаления только synthetic data
  **4975 MiB** вместо примерно 29 GiB. Core PostgreSQL при миграции не рестартовали.
- Probes `16/probes:5433`, DB `hyperspace_probes`: около **892 MiB**, выделенный
  filesystem 16 GiB; latest и 14 дней rollups перенесены, новая очередь работает.
- Core users/sessions/assignments до и после: **3054 / 272 / 520**.
  Ledger: **9 entries**, сумма `225310000` minor SOL units — сохранена и сверена
  с полностью восстановленной копией.
- Без probes PostgreSQL выполнен cold restart API: health/gates **200**, core
  snapshot ready **1**, benchmarks/trading **503** за 3–4 ms. После включения
  probes возвращаются **200** без перезапуска core worker. Девять enabled gates
  продолжают отправлять свежие core heartbeats.
- Новый core dump: **561 MiB**,
  `/mnt/hyperspace-backup/postgresql/hyperspace-20261006T162548Z.dump` + `.sha256`.
  Первый полный restore drill прошёл 16:34 UTC, временная БД после проверки удалена.
  Повторный drill 16:44 UTC также проверил чтение и DDL под `hyperspace`,
  сохранив правильного владельца database; тестовая таблица откатилась,
  временная restored database удалена. Проверки кода: 287 passed, один внешний
  email-auth integration test skipped; typecheck всех workspace и новые PromQL
  rule tests прошли.
- Контрольный полный dump до переноса (разовый, включая старую synthetic историю)
  сохранён отдельно:
  `/mnt/hyperspace-backup/postgresql/hyperspace-before-db-isolation-20261006.dump`.
  Он не входит в ongoing probes backup, служит временным migration checkpoint.
  Два старых mixed daily dumps уйдут по обычной ротации следующих core backups.
- Runtime secrets с encryption keys и новыми split env flags зашифрованы в
  `/mnt/hyperspace-backup/postgresql/core-runtime-20261006.tar.gz.gpg`.
  Recovery passphrase находится **только на dev VM**:
  `/root/hyperspace/.provider_creds/db-isolation/core-recovery-passphrase`.
  Администратору необходимо сохранить этот файл также офлайн: потеря dev VM
  вместе с ключом сделает encrypted recovery archive бесполезным.

Для расшифровки на доверенной recovery VM использовать `gpg --batch
--pinentry-mode loopback --passphrase-file PRIVATE_KEY_FILE --decrypt --output
PRIVATE_DIRECTORY/core-runtime.tar.gz core-runtime-20261006.tar.gz.gpg`.
Directory — mode 0700, файлы — 0600; не выводить содержимое env/ключей в terminal.
После ротации encryption keys обязательно обновлять encrypted runtime archive.

## Проверки изоляции

Остановить только `postgresql@16-probes`, проверить startup core API, /health,
список gates, операционные claim/report и reconcile. Trading/benchmarks должны
отвечать ограниченным 503, а не блокировать core. Запустить probes и проверить
возврат measurements. Полное заполнение probes filesystem тестировать отдельно
на sandbox instance; в production безопасно проверяется fixed filesystem bound.
