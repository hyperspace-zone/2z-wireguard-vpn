# Рекомендации по масштабированию и эксплуатации gate fleet

Дата аудита: 2026-07-15
Среда: mainnet
Статус: реализовано в коде; fleet rollout выполняется волнами

## Статус реализации 2026-07-15

Реализованы целесообразные изменения, не требующие неподтверждённого изменения
сетевого поведения всего fleet:

- resource tiers `standard` (`nf_conntrack_max=65536`) и `hub` (`262144` с
  обязательными 2 GiB RAM), conntrack accounting и alerts 70/90%;
- node exporter textfile metrics для conntrack, physical/overlay traffic,
  network/UDP/softnet errors, `vnstat` freshness и aggregate DoubleZero metrics;
- idempotent bootstrap observability/log-hygiene stack и verified SSH
  `known_hosts`;
- control-plane catalog-driven Prometheus `file_sd`, target-count checks,
  90-day Prometheus retention, recording rules и Grafana panels;
- assignment-scoped nftables allow/drop rules с CIDR enforcement, reverse
  `established,related` path и independent accepted/dropped counters;
- WireGuard и forwarded-payload counters с boot/generation-aware central
  samples and idempotent deltas;
- startup rehydration and kernel drift validation before an assignment is
  reported as Applied;
- aggregate DoubleZero metrics without per-peer cardinality.

Осознанно не включены fleet-wide `NOTRACK`, active route-liveness и глобальная
смена base-chain policy на `DROP`. Assignment traffic уже заканчивается
scoped drop rules; глобальная policy остаётся совместимой с посторонним
forwarding на host. Эти три изменения допустимы только после отдельного
testnet/load canary и проверки failover. Увеличение London/Frankfurt до hub tier
также требует сначала изменить VM sizing у провайдера.

## Цель

Подготовить Hyperspace gate fleet к эксплуатации более 15 gate-узлов с
предсказуемой сетевой ёмкостью, централизованным учётом трафика, безопасным
forwarding и автоматизированным мониторингом.

`vnstat` следует установить на все gates, но только как локальный резервный
счётчик физического трафика. Основной учёт должен строиться на Prometheus,
per-assignment nftables/WireGuard counters и сохранении интервальных значений
в централизованном хранилище.

## Факты, установленные во время аудита

- Prometheus mainnet на момент аудита видел 14 gate targets. Если в catalog
  gates больше, статический scrape inventory уже неполон.
- `gate-eu-lon-01`: conntrack `7168/7168`, то есть 100%.
- `gate-eu-fra-21`: conntrack `7644/8192`, то есть около 93%.
- London и Frankfurt переносили примерно по `1.06-1.09 TB` физического трафика
  за последние пять доступных дней.
- Мало загруженные gates переносили примерно `68-72 GB` за пять дней каждый.
  При текущей скорости это около `0.4 TB/month` фонового физического трафика на
  gate, или около `6 TB/month` для 15 gates.
- Короткий metadata-only packet capture на `gate-eu-sto-21` показал, что
  фоновый трафик преимущественно состоит из DoubleZero GRE и UDP/44880
  route-liveness. На узле было около 875 BGP routes.
- На London в kernel logs постоянно присутствовало
  `nf_conntrack: table full, dropping packet`; это уже приводило к потерям и
  нестабильному установлению новых SSH-соединений.
- Текущая nftables base chain имеет `FORWARD policy ACCEPT`.
- История Prometheus для London начиналась только с 2026-07-09, `vnstat`
  отсутствовал, `nf_conntrack_acct` был выключен.
- В production PostgreSQL отсутствовала таблица `rated_usage_events`, хотя
  соответствующая миграция присутствует в репозитории.
- Сессия `asd` числилась `Active/Applied` в control-plane, но её WireGuard
  interface отсутствовал после reboot. Нужен startup/drift reconciliation.
- `doublezerod` создавал миллионы записей route-liveness в syslog.

Все числа выше являются point-in-time evidence от 2026-07-15 и должны быть
перепроверены перед production rollout.

## P0: изменения, необходимые в первую очередь

### 1. Conntrack и sizing gate-узлов

Нужно ввести два или более resource tiers вместо одинаковых малых VM для всех
gates.

Рекомендуемый начальный профиль:

- обычный gate: не менее 1 vCPU / 1 GB RAM и conntrack порядка 65 536 после
  проверки memory footprint;
- traffic hub или egress с большим числом flows: не менее 2 vCPU / 2-4 GB RAM;
- для hubs рассмотреть conntrack порядка 262 144 только после увеличения RAM и
  canary load test;
- swap допустим как аварийная страховка, но не как замена RAM на packet path.

Необходимо добавить Prometheus alerts:

- conntrack utilization выше 70% — warning;
- conntrack utilization выше 90% — critical;
- отсутствие `node_nf_conntrack_*` metrics на Enabled gate;
- kernel `nf_conntrack: table full` events;
- network drops/errors, UDP buffer errors и softnet drops;
- sustained CPU, memory pressure, PPS и traffic anomaly.

Для outer GRE, UDP/44880, WireGuard transport и benchmark probes можно
рассмотреть nftables `notrack`, если эти пакеты не требуют NAT/stateful
filtering. Это изменение нельзя выкатывать сразу на весь fleet: сначала нужен
canary и проверка DoubleZero, WireGuard, probes и failover.

### 2. Nftables deny-by-default

Текущая base chain создаётся с permissive policy в
[`apps/gate-agent/cmd/hyperspace-gate-agent/main.go`](../../apps/gate-agent/cmd/hyperspace-gate-agent/main.go).

Требуется:

- перейти к `FORWARD policy DROP` либо эквивалентному финальному `counter drop`;
- для каждого assignment проверять `iifname`, `oifname`, client `saddr` и
  разрешённые destination `daddr`;
- destination CIDRs должны быть enforcement в firewall, а не только routes;
- явно разрешать корректный reverse path;
- использовать `ct state established,related` там, где это совместимо со
  схемой WireGuard/NAT;
- иметь отдельные counters для accepted и dropped traffic каждого assignment;
- добавить тесты на попытку пройти к CIDR вне session policy.

Изменение должно сохранять idempotent apply/revoke semantics и не оставлять
stale rules после revoke или generation change.

### 3. Автоматическое обнаружение gates в Prometheus

Статический список targets в
[`infra/observability/prometheus/prometheus.mainnet.yml`](../../infra/observability/prometheus/prometheus.mainnet.yml)
не подходит для fleet больше 15 узлов.

Рекомендуется:

- генерировать Prometheus `file_sd` targets из control-plane gate catalog;
- автоматически обновлять файл при Enabled/Disabled gate и изменении IP;
- проверять соответствие `Enabled gates == scrape targets`;
- алертить, если Enabled gate отсутствует в discovery или node exporter down;
- не публиковать secrets или пользовательские данные в discovery labels.

## P1: учёт и атрибуция трафика

### 4. Установить vnstat на каждый gate

`vnstat` нужен как независимый persistent counter для сверки с панелью
хостера.

Требования:

- определять физический интерфейс через default route, а не жёстко ожидать
  `eth0`;
- обязательно учитывать физический интерфейс;
- `doublezero0` можно учитывать отдельно для диагностики overlay;
- никогда не суммировать physical interface и `doublezero0` для provider
  billing;
- хранить минимум 90 дней daily data и 12-24 месяца monthly data;
- включить и проверить `vnstatd`;
- экспортировать freshness и totals через node-exporter textfile collector или
  gate-agent;
- алертить, если vnstat database stale или interface исчез.

`vnstat` не заменяет per-session accounting и не отвечает на вопрос о
destination IP/account.

### 5. Экспортировать per-assignment counters

Gate-agent должен публиковать четыре независимых уровня:

1. physical interface RX/TX — сверка с хостером;
2. `doublezero0` RX/TX — overlay;
3. WireGuard RX/TX per assignment;
4. forwarded payload per assignment, role и direction.

Пример метрики:

```text
hyperspace_gate_assignment_bytes_total{
  gate="gate-eu-lon-01",
  assignment_id="...",
  role="Ingress",
  direction="to_destination"
}
```

Ограничения:

- не использовать email, display name или account name как Prometheus labels;
- session/account mapping выполнять в control-plane/PostgreSQL;
- учитывать boot ID, assignment generation и counter resets;
- снимать counters каждые 1-5 минут;
- сохранять интервальные deltas централизованно до удаления nft/WireGuard
  state;
- revoke или reboot не должны уничтожать уже учтённую историю.

Для небольшой группы destination CIDRs предпочтительны дешёвые nftables
counters per CIDR. Полный постоянный flow logging не рекомендуется. Для
forensics использовать временный metadata-only capture либо sampled
IPFIX/eBPF.

### 6. Retention и billing pipeline

- Увеличить Prometheus retention минимум до 90 дней либо настроить remote
  write.
- Добавить recording rules для hourly/daily physical traffic, DoubleZero и
  per-assignment deltas.
- Проверить и применить после review миграцию
  [`packages/db/migrations/0020_doublezero_usage_billing.sql`](../../packages/db/migrations/0020_doublezero_usage_billing.sql).
- Проверить worker metering loop, идемпотентность usage imports и отсутствие
  double charging.
- Явно определить, какой слой считается billable: physical, overlay или
  forwarded payload. Один пакет нельзя тарифицировать дважды из-за прохождения
  physical + DoubleZero interfaces.

## P2: fleet automation и эксплуатация

### 7. Сделать bootstrap единственным источником конфигурации gate

Текущий [`scripts/gates/bootstrap-host`](../../scripts/gates/bootstrap-host)
не устанавливает весь observability и log-hygiene stack, описанный вручную в
deployment runbook.

Bootstrap/rollout должен идемпотентно устанавливать и проверять:

- `prometheus-node-exporter`;
- `vnstat` и `vnstatd`;
- `sysstat`;
- journald limits;
- logrotate;
- Hyperspace disk janitor service/timer;
- node-exporter textfile collector;
- единый tier-aware sysctl profile;
- nftables base policy;
- DoubleZero version и metrics endpoint;
- наличие gate в Prometheus discovery;
- восстановление persisted assignments после reboot.

Также следует отказаться от `StrictHostKeyChecking=no` в fleet automation и
использовать проверяемый known_hosts/pinned host keys.

### 8. Startup и drift reconciliation

Gate-agent должен после старта:

- прочитать persisted assignment state;
- сравнить его с фактическими WireGuard interfaces, routes и nft rules;
- безопасно rehydrate missing state либо запросить replay у control-plane;
- регулярно публиковать drift condition;
- не считать assignment `Applied`, если kernel state отсутствует;
- корректно восстанавливаться после reboot без ручного job replay.

### 9. DoubleZero metrics и log volume

Установленная версия `doublezerod` поддерживает aggregate Prometheus metrics.
Нужно:

- включить aggregate metrics на canary gate;
- не включать `route-liveness-peer-metrics` на весь fleet из-за высокой
  cardinality;
- измерять route count, liveness packet rate, errors и convergence;
- обсудить с DoubleZero возможность уменьшить liveness fan-in/частоту для
  пассивных gate-узлов;
- не отключать passive liveness без согласованного canary test;
- уменьшить или rate-limit повторяющиеся `session up` logs;
- сохранить существующие journald/logrotate/disk-janitor ограничения.

## Рекомендуемый порядок rollout

1. Добавить alerts и dashboard panels без изменения dataplane.
2. Увеличить ресурсы London/Frankfurt и поднять conntrack на одном hub.
3. Проверить packet loss, session stability, memory и conntrack utilization.
4. Установить `vnstat`, обновлённый node exporter и log hygiene canary wave.
5. Выкатить observability bootstrap на остальные gates волнами.
6. Ввести автоматический Prometheus discovery.
7. Реализовать per-assignment counters и центральное сохранение deltas.
8. Перевести nftables на deny-by-default через testnet и один mainnet canary.
9. Добавить startup/drift reconciliation.
10. После накопления минимум недели метрик скорректировать resource tiers и
    DoubleZero liveness настройки.

## Acceptance criteria

- Каждый Enabled mainnet gate автоматически появляется в Prometheus.
- На каждом gate работают node exporter, vnstatd, sysstat и disk janitor.
- Conntrack ниже 70% в штатной нагрузке и не достигает 100% при load test.
- В kernel logs отсутствуют новые `nf_conntrack: table full` events.
- Reboot gate автоматически восстанавливает все Applied assignments.
- Session не может отправить трафик за пределы разрешённых destination CIDRs.
- Для каждого active assignment доступны monotonic byte counters в обоих
  направлениях.
- Revoke/reboot не теряет уже сохранённые usage deltas.
- Physical daily totals сопоставимы с provider totals с документированной
  погрешностью encapsulation/accounting window.
- Prometheus хранит минимум 90 дней данных или данные доступны в remote
  storage.
- DoubleZero metrics наблюдаемы, а logging не создаёт неконтролируемый рост
  `/var/log`.

## Guardrails для реализации

- Не выполнять fleet-wide dataplane changes без testnet и mainnet canary.
- Не выводить private keys, gate tokens, WireGuard configs или env secrets.
- Не изменять DoubleZero identity files.
- Не сбрасывать существующие nftables/WireGuard counters до их сохранения.
- Не применять production DB migrations без backup и отдельного review.
- Сохранять idempotency существующих bootstrap/deploy/revoke workflows.
