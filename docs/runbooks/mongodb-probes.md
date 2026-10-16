# Probes целиком в MongoDB: очередь, scheduler и измерения

## Актуальная архитектура

С `PROBES_BACKEND=mongodb` PostgreSQL `hyperspace_probes:5433` **не используется**.
Операционная `hyperspace:5432` остаётся источником истины для пользователей,
авторизации, wallets/payments/ledger, VPN sessions/configs/assignments и
операционных apply/revoke/reconcile/deployment jobs. Backup core и полный
restore drill сохраняются без изменений.

MongoDB хранит measurements и всю рабочую часть synthetic probes: задания,
leases, попытки/retries, heartbeat trading nodes, scheduler completion state,
журнал недоставленных результатов и read-only копию каталога. Каталог gates,
probe nodes/targets и token hashes авторитетны в core и входят в core backup.
Никаких распределённых транзакций, FDW или обратной записи из Mongo в core нет.

API и отдельный `hyperspace-probes-worker` используют Mongo. Core worker не
получает Mongo credentials; `PROBES_SEPARATED=true` обязателен. Процессы probes
не используют SQL fallback: случайная SQL-операция завершается ошибкой,
а не перенаправляется в операционную БД. Gate API по-прежнему аутентифицирует
гейты в core; control claim/report не обращаются к Mongo. Для reports без lane
сначала проверяется core job; только отсутствующий job ищется в Mongo.

## Гарантии очереди

- `probe_jobs`: один документ на запуск. Partial unique index `(key)` для
  `active=true` не позволяет двум scheduler создать одну активную пару дважды.
- Claim — атомарный `findOneAndUpdate`. В одном документе устанавливаются lease,
  owner, номер попытки и новый случайный `claimId` (UUID, возвращаемый как job ID).
  Новая попытка получает **новый ID**: старый gate-agent без attempt в report
  не сможет завершить чужую повторную попытку. Протокол/бинарники gates менять
  не требуется.
- Report проверяет source, claimId, фазу, неистёкший lease; trading также номер
  попытки. Завершение и payload событий для доставки фиксируются одной записью.
  Повтор подтверждённого report идемпотентен; истёкший/чужой lease отклоняется.
- Отдельный bounded loop доставляет проекции measurements at-least-once.
  Стабильный event ID предотвращает повторный учёт benchmark-цикла. Падение
  между записью raw/latest/rollup и подтверждением доставки безопасно для replay.
  Pending journal **не имеет TTL**. TTL 2 дня появляется только после доставки;
  для длинного интервала сохраняется как минимум cooldown плюс сутки.
- Активный ключ удерживается до конца cooldown. После этого reaper освобождает
  его; `probe_schedule` сохраняет время последнего завершения и revision.
- Истёкшие leases получают ограниченные повторы с задержкой. После исчерпания
  попыток запуск `dead`; следующий период создаёт новый запуск, не бесконечный
  retry одного задания. Completed history не является бизнес-историей.
- Удалённые/Disabled gate-host nodes и targets перестают получать задания.
  Устаревшие queued target revisions отменяются. Maintenance не выдаёт работу.
- Каталог копируется каждые 10 секунд: сначала завершается read-only core
  transaction, затем заменяется один Mongo snapshot. Удаления и отзыв токенов
  распространяются вместе с ним. Snapshot старше 60 секунд блокирует новые
  probes claims/auth/scheduling. Старые leases не продлеваются копированием.

## Сбой MongoDB

В отличие от прежней схемы, при недоступной Mongo **очередь тоже недоступна**:
новые synthetic задания не создаются/не выдаются, отчёты без подтверждения
могут повторяться агентами. После восстановления очередь, leases и durable
journal продолжают работу. Отдельный gate-agent не гарантирует сохранение
каждого неподтверждённого synthetic report: пропуск измерения допустим.

Обычные VPN, billing, выдача/отзыв конфигураций и основной reconcile не зависят
от Mongo. API может cold-start без Mongo; публичные measurements возвращают
ограниченно stale snapshot или 503, не выдают старое за live. Новый trading
preset требует свежих измерений, проверяется **до оплаты**.

Полная потеря Mongo означает потерю измерений и очереди, но не денег/конфигов.
Воссоздать индексы, запустить sync каталога и worker; после heartbeat появятся
новые задания. Восстановление synthetic history из backup не обязательно.

## Новый deployment

1. Развернуть core PostgreSQL и настроить ежедневные backups/restore drill.
2. Создать read-only роль каталога (SELECT только на восемь таблиц из
   `apps/control-plane-worker/src/probes/catalog-sync.ts`), без прав на платежи,
   пользователей, gate auth tokens и без прав записи.
3. Настроить Mongo TLS/auth и firewall по [Mongo measurements](mongodb-measurements.md).
4. API и probes-worker: `PROBES_BACKEND=mongodb`, `MEASUREMENTS_MONGO_URL`,
   для self-hosted также `MEASUREMENTS_MONGO_CA_FILE`. В probes-worker установить
   `PROBES_CATALOG_DATABASE_URL`. Пример: `infra/systemd/probes-worker.env.example`.
   **Не задавать `PROBES_DATABASE_URL`**. Core worker: `PROBES_SEPARATED=true`.
5. `node --env-file=/etc/hyperspace/probes-worker.env scripts/db/initialize-mongo-probes.mjs`.
6. Запустить API и probes-worker. Core startup не должен ожидать Mongo/index init.
   Core migrations выполняются обычным порядком; SQL probes migrations не нужны.
   `scripts/control-plane/restart-probes-after-migrations` сам выбирает Mongo
   index initialization по backend. Ошибка optional probes не блокирует core.

## Переход с существующего PostgreSQL probes

Сборки и тесты выполнять на dev/builder, не на малом control-plane.

1. Проверить Git diff, тесты/typecheck/build. Упаковать зависимости и workspace
   builds в отдельный release; сохранить commit SHA и checksum артефакта.
2. На control-plane распаковать в новый
   `/opt/2z-wireguard-vpn-releases/mongo-probes-TIMESTAMP`, не поверх live.
   Проверить чтение Node entrypoints пользователем `hyperspace`.
3. Прогнать `packages/control-plane/dist/probes/mongo.test.js` с `MONGO_TEST_URL`
   из защищённого env. Тест использует только случайные `__test_*` collections,
   удаляет именно их. Реальные measurement collections не очищает.
4. Сделать dry-run `node --env-file=/etc/hyperspace/probes-worker.env scripts/db/migrate-probe-queue-mongo.mjs`.
   Backlog должен быть <10000.
5. `bash scripts/control-plane/deploy-mongo-probes /opt/2z-wireguard-vpn-releases/mongo-probes-TIMESTAMP`.
   Helper сохраняет старый runtime pointer и env (0600), останавливает только
   API/probes worker, переносит активные задания с их ID/lease, heartbeat,
   schedule и **все pending outbox events с прежними event ID**. Источник SQL
   читается read-only, не очищается. Завершённая старая история jobs не копируется.
   Затем меняет env, атомарно переключает runtime symlink, запускает API/probes.
   При неуспешной HTTP/service проверке возвращает прежние runtime/env.
6. Проверить несколько реальных benchmark/trading циклов, fresh measurements,
   `probes_jobs`, delivery backlog, catalog age и loop readiness. Сравнить
   core users/payments/configs, freshness gate heartbeats и core health.
   Read-only acceptance helper:

   ```bash
   node --env-file=/etc/hyperspace/probes-worker.env scripts/db/verify-mongo-probes.mjs --require-new-results
   ```
7. Только после успешной проверки на DB VM:

   ```bash
   sudo systemctl disable --now postgresql@16-probes.service
   sudo systemctl mask postgresql@16-probes.service
   sudo systemctl is-active postgresql@16-main.service
   ```

   Проверить, что порт 5433 закрыт, основной 5432 работает; холодно перезапустить
   API/probes worker и повторить проверки. Mask не даёт случайно поднять второй
   экземпляр при reboot/общем restart PostgreSQL.
8. Файлы старой БД/loopback volume **пока не удалять**: это rollback checkpoint.
   Остановка не освобождает зарезервированные 16 GiB. Удаление данных и тома —
   отдельное явно согласованное действие после rollback window.

Import marker запрещает повторный перенос старого snapshot поверх уже живой
Mongo-очереди. После автоматического отката сначала выяснить причину: не удалять
marker/collections наугад. Повторный cutover требует отдельного плана переноса
заданий, созданных в SQL после отката.

Для последующих обновлений уже переключённого runtime используется тот же
versioned helper с `--upgrade`: `bash scripts/control-plane/deploy-mongo-probes
/opt/2z-wireguard-vpn-releases/mongo-probes-TIMESTAMP --upgrade`. Он требует
Mongo backend в обоих env, не импортирует SQL повторно и не меняет credentials.
Инициализация индексов, rollback и HTTP checks сохраняются.

## Откат после остановки probes PG

На DB VM unmask/start **только** `postgresql@16-probes.service`. На CP остановить
API/probes, вернуть оба env из конкретного rollback directory и старый runtime
symlink, затем запустить API/probes. Не менять core worker/DB. Новые synthetic
Mongo задания не копируются автоматически в старую SQL очередь. Сначала
доставить pending Mongo projections или сохранить их для отдельного replay;
Mongo measurements не удалять. Возможный пропуск synthetic цикла допустим,
потеря операционных данных — нет.

## Алерты и тесты

Правила `hyperspace-db-isolation.yml` обновлены: Mongo outage, delivery backlog,
stale catalog (>60s в течение 5m), stalled queue (>10m в течение 5m), worker/loop
failure. Все synthetic availability alerts — warning; disk Mongo и проверка
core restore остаются critical. При Mongo outage нет ложного требования
перезапускать снятый с эксплуатации порт 5433.

Обязательные тесты: конкурентные schedule/claim; lease fencing; duplicate
reports; ограничение retries; crash после частичной projection; restart с
pending journal; отсутствие TTL на pending; revoked/stale catalog; same-metro
N/A; Maintenance/Disabled; чтение матрицы/trading без SQL; core API при недоступной
Mongo; cold restart при выключенном PostgreSQL probes.

Для контролируемого live outage drill: на dev/builder
`bash scripts/db/check-mongo-probes-isolation --execute`. Скрипт кратко
останавливает Mongo, ставит host-local failsafe для восстановления через 60s,
перезапускает только API/probes и проверяет core health/catalog вместе с 503
измерений. После возврата Mongo проверяет автоматическое восстановление **без
второго restart**. Не запускать вне окна обслуживания: API при рестарте имеет
короткий HTTP gap. SSH/hosts переопределяются через HS_SSH_KEY, HS_MONGO_HOST,
HS_CONTROL_HOST; подразумеваются production env paths и API 8080.

Mongo store вызывает явный `client.connect()` перед операциями: driver lazy
auto-connect после неудачного первого соединения может оставить closed topology.
Повторный явный connect восстанавливает его; работающий pool переиспользуется.
Core startup не ждёт этого подключения. После штатного close reconnect запрещён.
