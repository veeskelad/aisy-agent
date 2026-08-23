# Managed Git и SSH-доставка Aisy

Это действующий production-канал по ADR-0106. Harness устанавливается на уровне
пользователя из exact HTTPS origin и ветки `master`; provider/voice bundles
передаются отдельно через pinned SSH channel в root-owned одноразовый inbox.

## Harness

Требуются Linux с `flock`, Git, Node.js 22+ и Corepack. Bootstrap не запускают
от root:

```bash
curl -fsSL https://raw.githubusercontent.com/veeskelad/aisy-agent/master/scripts/install.sh | bash
aisy init
aisy doctor
```

Bootstrap вызывает `/usr/bin/git` только с заданным кодом минимальным набором
переменных: пользовательские `GIT_CONFIG_*`, transport/proxy/filter overrides
и `url.*.insteadOf` намеренно игнорируются. Нужный корпоративный proxy требует
отдельного явного архитектурного решения.

Install tree отделён от `AISY_HOME` и не меняет runtime state. Обычное
обновление допускает только descendant текущего commit:

```bash
aisy update
```

Если оператор отдельно подтвердил rewrite ветки, разрешение связывается с exact
полным SHA fetched head:

```bash
aisy update --allow-rewrite=<full-sha>
```

Offline rollback проверяет сохранённый previous release и не делает fetch.
Обычный update/rollback автоматически ограничивает retention; между operations
остаётся не более current/previous и одного только что вытесненного release.
Явный cleanup немедленно удаляет все unreferenced generations, worktrees и их
integrity records:

```bash
aisy update --rollback
aisy update --cleanup
```

Receiver держит одновременно максимум восемь bundle по 32 MiB. Stale
receiving/sealed inbox очищаются через 24 часа, claimed с завершившимся helper —
через час; после успеха остаются максимум 256 compact replay tombstones.
Crash во время публикации/cleanup восстанавливается из `.new-g-*`, `.gc-*`,
exact integrity temporary files, Git worktree registry, включая только exact
`locked initializing`, и bundle `completing`.
Managed lock удерживается ядром на стабильном inode и освобождается закрытием
descriptor; PID-файл и stale-unlink не используются. Bundle claim отдельно
проверяет boot/process-start identity, поэтому reused PID не считается
владельцем.

## Provider и voice bundles

Release дважды собирают из одного clean exact commit существующими builders.
Для каждого результата создают canonical receipt:

```bash
python3 scripts/build-sidecar-release-receipt.py \
  --component=provider \
  --bundle=/absolute/provider-release \
  --output=/absolute/provider-receipt.json
```

Два build должны дать одинаковые manifest, file inventory, receipt и SHA-256
receipt. Receipt не содержит host, user или runtime path.

Первичный bootstrap дважды строят из exact commit:

```bash
python3 scripts/build-sidecar-ssh-bootstrap.py \
  --commit=<full-sha> \
  --output=/absolute/bootstrap-tree
```

Оба build должны дать одинаковые canonical `bootstrap.json` и его SHA-256.
Первичное provisioning выполняется отдельной одноразовой административной
authority (golden image, cloud-init или configuration management), которая
заранее ставит reviewed `scripts/sidecar-bootstrap-install.py` в
`/usr/local/libexec/aisy-sidecar-bootstrap-install` как root-owned regular
`0755` и закрепляет его SHA-256 в конфигурации host. Эта authority создаёт
root-owned каталог `/usr/lib/aisy/bootstrap-incoming/<random-id>` с mode 0700,
передаёт exact bootstrap tree, затем запускает только заранее установленный
verifier по фиксированному absolute path. Файл из staging и код из stdin до
verification не исполняются. Verifier принимает только
exact inventory, создаёт root-owned inbox/ledger и ставит bootstrap в
`/usr/lib/aisy/bootstrap`, а launchers — в `/usr/libexec`; checkout, home,
temporary directory и содержимое staging до успешной проверки не являются
доверенным кодом.

```bash
/usr/bin/python3.12 -I \
  /usr/local/libexec/aisy-sidecar-bootstrap-install \
  --source=/usr/lib/aisy/bootstrap-incoming/<random-id> \
  --expected-manifest-sha256=<sha256> \
  --expected-commit=<full-sha>
```

После успешной установки постоянного forced-command receiver одноразовую
administrative authority отзывают; unrestricted root session не используют
для последующих release delivery.

В `authorized_keys`
закрепляют отдельный operator public key с `restrict` и forced command
`/usr/libexec/aisy-sidecar-receiver`. Operator client использует отдельный
known-hosts файл с exact host key и `StrictHostKeyChecking=yes`; TOFU и
автоматическая замена host key запрещены.

Receiver protocol использует только команды:

```text
aisy-sidecar-receiver begin --expected-receipt-sha256=<sha256>
aisy-sidecar-receiver receipt --deployment-id=<id>
aisy-sidecar-receiver member --deployment-id=<id> --path=<receipt-member>
aisy-sidecar-receiver seal --deployment-id=<id>
```

`begin` возвращает непредсказуемый одноразовый deployment id, созданный на
host. Receipt и каждый member передаются через stdin отдельной SSH-команды.
Member names берутся только из receipt. После `seal` mutation и replay
отклоняются.

Activation выполняется root-owned helper-ом после seal. Он принимает только
deployment id и bounded runtime selectors; uid/gid, active user unit, PID и
cgroup выводятся на host:

```bash
/usr/libexec/aisy-provider-install install \
  --deployment-id=<id> \
  --runtime-user=<aisy-user> \
  --runtime-unit=aisy.service \
  --aisy-home=<absolute-aisy-home> \
  --providers=anthropic,openai

/usr/libexec/aisy-voice-install install \
  --deployment-id=<id> \
  --runtime-user=<aisy-user> \
  --runtime-unit=aisy.service \
  --aisy-home=<absolute-aisy-home>
```

Rollback использует active previous без нового upload. Uninstall разрешён
только с явным флагом сохранения зашифрованного состояния. Receiver и helper не
принимают произвольные URL или чувствительные данные через arguments, process
environment или receipt.

## Production cutover

Новый managed launcher сначала проверяют рядом с текущим runtime. Перед
изменением user unit сохраняют старый `ExecStart`. Затем отдельно выполняют
daemon-reload/restart и проверяют doctor, Telegram, provider, voice и повторный
restart. При любой ошибке возвращают старый `ExecStart`; runtime state, memory и
старые root releases не удаляют.
