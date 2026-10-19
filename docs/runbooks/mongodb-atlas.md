# MongoDB Atlas для production probes

## Назначение и границы

Atlas заменяет только self-hosted MongoDB измерений и synthetic очереди.
Операционный PostgreSQL, пользователи, платежи, VPN assignments и основной
reconcile остаются независимыми. Архитектура очереди описана в
[MongoDB probes](mongodb-probes.md).

Целевой кластер: `hyperspace-probes-fra`, Atlas Flex, AWS Frankfurt
(`EU_CENTRAL_1`), база `hyperspace_measurements`.
SRV hostname: `hyperspace-probes-fra.ikxoorh.mongodb.net`.
Не подменять SRV hostname собственным A/CNAME: driver использует DNS SRV/TXT и
проверку сертификатов Atlas. Фиксированного IP и SSH-доступа у Atlas нет.

Flex ограничен 5 GB **несжатых данных плюс индексы**, 500 connections и
500 operations/sec. Массовый первоначальный импорт может ограничиваться
скоростью тарифа. Нельзя оценивать запас только по сжатому WiredTiger размеру.
MongoDB version назначается Atlas, не равна автоматически версии self-hosted.
См. [официальные ограничения](https://www.mongodb.com/docs/atlas/reference/flex-limitations/).

## Credentials и runtime

- Отдельный Atlas database user: `readWrite` только на
  `hyperspace_measurements`, scope только на этот кластер.
- Database IP access list: control-plane `5.199.161.13/32`, dev/builder
  `84.32.99.240/32`. При переносе control-plane сначала добавить новый egress
  IP и проверить соединение, затем убрать старый. Это не management API ACL.
- Секреты не в Git. На control-plane источник конфигурации:
  `/etc/hyperspace/measurements-mongo.env`, mode `0600`:

  ```dotenv
  MEASUREMENTS_MONGO_URL=mongodb+srv://USER:PASSWORD@ATLAS_HOST/hyperspace_measurements?retryWrites=true&w=majority&appName=hyperspace-production
  ```

- Для Atlas **не задавать `MEASUREMENTS_MONGO_CA_FILE`**: используется системный
  trust store с проверкой публичного TLS-сертификата. Не использовать
  `tlsAllowInvalidCertificates`, `tlsInsecure` или отключение проверки hostname.
- `scripts/db/configure-mongo-runtime.mjs` копирует только Mongo settings в
  API/probes worker, удаляет прежний self-hosted CA override и сохраняет
  защищённый rollback. Core worker env не меняется. Helper не перезапускает
  службы: restart API/probes выполняется в окне переключения.
- Текущий `MongoMeasurementStore` явно задаёт `w:1,j:true`; этот write concern
  имеет приоритет над URI `w=majority`. Не считать наличие URI-параметра
  доказательством majority acknowledgment. Synthetic данные допускают replay
  и не являются финансовым журналом.

## Перенос существующей MongoDB

1. Проверить размер, все коллекции/индексы, исходное здоровье core и probes.
   Создать Atlas, пользователя и точечный network access list. Не выключать
   старую машину до подтверждённого cutover.
2. Запустить обе live Mongo suites (`dist/probes/mongo.test.js` и
   `dist/measurements/measurements.test.js`) **отдельными командами** с
   защищённым `MONGO_TEST_URL`, без старого CA override. Suites используют
   случайные `__test_*` namespaces и удаляют только их.
3. Сделать резервные копии трёх runtime env; сохранить core worker PID/checksum.
   Остановить только probes worker. Для standalone source взять `fsync` lock:
   остановятся все Mongo writers и TTL, но чтение/`mongodump` продолжатся.
   Обязателен host-local timer аварийной разблокировки и возобновления worker.
   Основной API/worker продолжают core-операции; synthetic endpoints могут
   показывать stale/503. Не держать API целиком выключенным на время импорта.
4. Снять согласованный gzip `mongodump` только `hyperspace_measurements`,
   сохранить counts и index specifications всех коллекций. Не переносить
   `admin`, пользователей или `local/config`. Credentials утилит передавать
   защищённым `--config`, не в командной строке/логах.
5. Копировать archive на dev/builder, сверить SHA-256. Целевая БД должна быть
   пустой. Восстановить с `--stopOnError --noIndexRestore`: не запускать TTL до
   точной сверки. Не использовать `--drop` против уже работающего назначения.
6. Сравнить все коллекции/counts и SHA-256 отсортированных по `_id` raw BSON
   документов source/target. При различиях **не переключать**. Это особенно
   важно при предупреждении инструментов о разных версиях source/destination;
   такое предупреждение нельзя игнорировать как доказанную совместимость.
7. Восстановить все indexes, включая unique/partial/sparse/TTL. Затем проверить
   index initialization приложения. После включения TTL counts могут уменьшаться
   естественно; точная сверка выполняется **до** него.
8. Заменить source Mongo env и вызвать configure helper, кратко перезапустить
   API, запустить probes worker. Старый Mongo остаётся fenced до проверки, чтобы
   не появились два независимых писателя. Основной worker не перезапускать.
9. Проверить новые (созданные после cutover) completed jobs и measurements по
   каждому Enabled gate/node, freshness каталога, delivery backlog, все worker
   loops, HTTP health/benchmarks/trading и core readiness. Время старой SQL→Mongo
   migration marker для такой проверки недостаточно: задавать новый cutoff.
10. Убрать старую VM из node-exporter targets **до** poweroff, проверить/reload
    Prometheus, обновить ссылки в Mongo alerts на Atlas. Оставить application-level
    Mongo/queue/catalog alerts и контроль лимита Flex.
11. При работающем Atlas снять lock, остановить/disable `mongod`, повторить
    проверки при выключенном старом сервисе. Отменить временные failsafe timers.
    После подтверждения выключить VM. Сохранить checkpoint вне этой VM.
    **Poweroff не означает прекращение начислений за VPS: владелец удаляет VM
    в CherryServers после подтверждения миграции.** Удалить устаревшую DNS
    A-запись `db-mongo → 88.216.62.149`, если она ещё существует.

При неудаче до подтверждения cutover: остановить Atlas probes worker, вернуть
исходные три env, разблокировать source, перезапустить API/probes. Новые synthetic
события Atlas автоматически не попадут в старую Mongo. Сохранить pending journal
для replay/разбора; пропуск synthetic цикла допустим, операционных данных — нет.

## Мониторинг и восстановление

- `HyperspaceMeasurementsMongoUnavailable`, backlog, catalog stale, queue stalled,
  loops и public measurement freshness продолжают работать через probes worker.
- `HyperspaceMeasurementsAtlasStorageHigh`: data+indexes >4 GB в течение 10 минут.
- `HyperspaceMeasurementsAtlasStorageCritical`: >4.5 GB в течение 5 минут.
- Для Atlas не подставлять IP control-plane в Mongo alerts. Service host — Atlas
  SRV hostname; `service_ipv4` очищен. Старый host-disk rule остаётся для
  self-hosted вариантов, но retired node exporter больше не опрашивается.
- Atlas Flex делает daily snapshots; это не непрерывный PITR. Core PostgreSQL
  backup и restore drill остаются обязательными и от Atlas не зависят.
- Разовый checkpoint переноса хранится вне Git и вне выключаемого сервера.
  Не включать dump, env, пароли или token hashes в публичные отчёты/commits.
- При полной потере probes базы возможен запуск заново с index initialization,
  sync core-каталога и новыми измерениями. Восстановление исторических synthetic
  измерений — отдельный выбор, не условие восстановления VPN или биллинга.

Проверки deployment assets:

```bash
node --test scripts/db/mongo-assets.test.mjs scripts/db/mongo-probes-assets.test.mjs
promtool test rules infra/observability/prometheus/tests/hyperspace-db-isolation.test.yml
```

## Подтверждённый production cutover — 19 октября 2026

- Переключение API/probes worker: **09:40:53 UTC**. Проверено фактическое
  окружение запущенных процессов: оба используют Atlas; старого CA override нет.
  Core worker не перезапускался, его env и PostgreSQL не изменялись.
- Перенесены **1 332 830 документов, 10 коллекций, 24 индекса**. До запуска
  TTL совпали counts и полные SHA-256 raw BSON по всем десяти коллекциям.
  Source MongoDB — 8.2.12, Atlas — 8.0.34; обе live suites прошли отдельно
  с dev и control-plane, по 20 тестов с каждой машины.
- После выключения source VM повторно проверены все worker loops (`ready`),
  свежий каталог и новые completed benchmark/trading jobs от четырёх Enabled
  gates: Singapore, Tokyo, Frankfurt и Chicago. Benchmarks/trading API и
  общий health отвечают HTTP 200. На 09:45 UTC data+indexes — около **1.29 GB**.
- На source `mongod` остановлен и disabled, временные аварийные таймеры отменены.
  CherryServers подтвердил **`power: off`** для `hs-production-mongo-01`,
  VM **1023699**, IP `88.216.62.149`. VM не удалена: это следующий шаг владельца
  в панели CherryServers для прекращения начислений.
- Старый node-exporter target удалён из live Prometheus; Atlas alerts загружены.
  Временный scoped silence synthetic-алертов снят после переключения.
- Checkpoint и результаты проверок сохранены на dev вне Git:
  `/root/hyperspace/operations-reports/mongo-atlas-20261019/`.
  Архив `hyperspace_measurements.archive.gz` (139 MiB), SHA-256:
  `fd184254c3c7ddf3c2ceaace53883c0a50ec9c6a8e6307610d21051440645141`.
  Каталог защищён правами `0700`, dump и credentials — `0600`.
- Оставшаяся ручная DNS-очистка: удалить A-запись
  `db-mongo.hyperspace.zone → 88.216.62.149`. Runtime использует Atlas SRV напрямую.
