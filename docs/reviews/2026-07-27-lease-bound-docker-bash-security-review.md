# Security review: lease-bound Docker bash

**Дата:** 2026-07-27  
**Статус:** два найденных разрыва исправлены в working tree  
**Область:** production-preview supervisor; live activation и Docker E2E не выполнялись

## Граница доверия

Разрешённый `bash` проходит `AgentRunner`/`HookGate`, после чего immutable
`TurnContextLease` задаёт единственный Project root. Node Docker port запускает
CLI без host shell, с очищенным окружением и без пользовательского Docker config.
Supervisor создаёт digest-pinned one-shot контейнер, сверяет его фактическую
конфигурацию до исполнения, аттестует финальное состояние и удаляет контейнер до
завершения lease operation.

## Подтверждённые находки

1. **Medium, confidence 9/10 — смешение output и transport в Docker attach.** Обычный
   infrastructure failure `container start --attach` мог выглядеть как ненулевой
   exit shell-команды, а Docker stderr — попасть в ToolResult. Одна лишь финальная
   сверка exit code не устраняла коллизию одинаковых кодов. Итоговое исправление:
   раздельные `start`, bounded `wait`, final `inspect` и bounded `logs`; `start`
   обязан завершиться успешно, exit команды берётся из `wait` и сверяется с
   `State.ExitCode`, а вывод читается только после аттестации. Infrastructure
   failure остаётся code-only.
2. **Medium, confidence 9/10 — split-brain gVisor probe/config.** Старый
   `SandboxRunner` вычислял `securityLevel` по probe, но выбирал `runsc` по
   отдельному caller field. Исправление: probe стал единственным источником
   уровня и runtime-флага; отсутствие probe fail-degraded, caller field больше
   не влияет на запуск.

Обе находки независимо перепроверены отдельными review agents. Первая пока была
latent, потому что новый factory не подключён live; вторая была latent, потому
что `makeSandboxRunner` используется только внутри Core/tests. Исправления
внесены до activation.

## Проверенные инварианты

- daemon до create доказывает `userns` либо `rootless`; `--userns=host` запрещён;
- `--userns-remap` не передаётся в `docker run`: это daemon setting;
- обязательны `runsc`, `network=none`, non-root user, read-only rootfs,
  `cap-drop=ALL`, `no-new-privileges`, builtin seccomp;
- RAM, CPU, PID, wall-time, output и tmpfs ограничены кодом;
- единственный bind mount — canonical identity exact `lease.root` в `/work`;
- inspect до start отклоняет ослабленную фактическую конфигурацию;
- `start`, `wait`, final `inspect` и `logs` разделяют transport, exit code и вывод;
- timeout, abort, overflow, OOM, root replacement и cleanup failure fail-closed;
- события содержат только идентификаторы и стабильные коды, без команды и вывода;
- Project disk quota остаётся отдельным deployment prerequisite;
- live composition и реальный Docker daemon не затрагивались.

## Источники Docker-контракта

- [Docker: user namespace remapping](https://docs.docker.com/engine/security/userns-remap/)
- [Docker container run options](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker system info](https://docs.docker.com/reference/cli/docker/system/info/)

Этот review не заменяет внешний pentest перед production activation.
