# GPU Host Setup (M5 prerequisites)

`taac2026 loop run` with a real remote requires three things on your GPU host
plus three on the local workstation. Total time: ~10 minutes.

> **Security stance.** The auto-loop CLI **will not** accept passwords, raw
> IPs, or `user@host` strings on its argv (CLAUDE.md sec; r9). Every SSH
> hop must go through a `~/.ssh/config` alias whose name is also listed in
> `taiji-output/state/allowed-hosts.txt`. `scripts/_remote-runner.mjs` and
> `.claude/hooks/guard-bash.sh` independently enforce this.

---

## 1. Local: generate an SSH key

```bash
# ed25519 with no passphrase is fine *if* the private key is on a
# disk-encrypted home volume. Otherwise add a passphrase + ssh-agent.
ssh-keygen -t ed25519 -f ~/.ssh/taac2026_gpu -C "taac2026 gpu access"
```

## 2. Remote: install the public key, disable password auth

```bash
# From an out-of-band terminal session you already trust on the GPU:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<<"$(cat /path/to/local/.ssh/taac2026_gpu.pub)"
chmod 600 ~/.ssh/authorized_keys

# Recommended hardening (do these only after you've verified key-based
# login works in another window):
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl reload sshd
```

If your provider only exposes a non-default port, document it in the local
ssh config (next step) — never in argv.

## 3. Local: ssh config

```
# ~/.ssh/config
Host taac2026-gpu
    HostName <your-gpu-public-ip>
    Port <your-port>
    User <non-root-username-or-root>
    IdentityFile ~/.ssh/taac2026_gpu
    IdentitiesOnly yes
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Verify:

```bash
ssh taac2026-gpu uptime
```

## 4. Local: enrol the alias in the allowlist

```bash
node -e "
import('./scripts/_allowed-hosts.mjs').then(m => m.appendAllowedHost('taac2026-gpu'));
"
# or hand-edit taiji-output/state/allowed-hosts.txt and add the alias.
```

Sanity:

```bash
cat taiji-output/state/allowed-hosts.txt
```

## 5. Remote: prepare the runner directory

The auto-loop expects a stable `~/taac-runs/` skeleton on the GPU host:

```bash
ssh taac2026-gpu '
  set -eu
  mkdir -p ~/taac-runs
  command -v flock >/dev/null || { echo "flock(1) is required"; exit 1; }
  command -v jq    >/dev/null || echo "WARN: jq not found — run.sh writes JSON anyway"
'
```

## 6. Remote: place a `run.sh` per plan

Each `<plan-id>` should ship a `run.sh` that the auto-loop will copy into
`~/taac-runs/<plan-id>/iters/<iter-id>/run.sh` and invoke under `flock`.
The contract:

```bash
#!/usr/bin/env bash
# Inputs (in the iter's working directory):
#   iter-params.json    {plan_id, iter, seed, started_at}
#   config.yaml         (optional) — your hyperparameter config
# Outputs (your run.sh MUST produce both):
#   metrics.json        — {"val_auc": <float>, "train_auc": <float>, ...}
#   status.json         — {"phase": "completed"|"failed",
#                          "started_at": "...", "ended_at": "...",
#                          "exit_code": 0, "gpu_id": "0"}
#   train.log           — auto-loop redirects stdout/stderr here

set -euo pipefail
date -Iseconds | xargs -I{} jq -n --arg ts "{}" '{phase:"running", started_at:$ts}' > status.json
trap '
  ec=$?
  date -Iseconds | xargs -I{} jq -n --arg ts "{}" --arg ec "$ec" \
    "{phase:(if (\$ec|tonumber)==0 then \"completed\" else \"failed\" end), ended_at:\$ts, exit_code:(\$ec|tonumber)}" > status.json
' EXIT

# ... your training command ...

# At the end, write metrics.json (or write it incrementally — auto-loop
# only reads it after status.json reports completed).
cat > metrics.json <<EOF
{"val_auc": 0.78, "train_auc": 0.82}
EOF
```

## 7. End-to-end verification (after key + allowlist are in place)

```bash
# Initialise the loop bound to the alias.
taac2026 loop init --plan-id plan-2026-05-08-001 --remote-host taac2026-gpu

# Dry-run shows what would happen without touching the remote.
taac2026 loop run --plan-id plan-2026-05-08-001

# Real run requires a fresh train_token (M3 review-gate).
taac2026 review issue --kind train --plan-id plan-2026-05-08-001 \
  --approver alice --execute --yes
taac2026 loop run --plan-id plan-2026-05-08-001 --execute --yes
```

## 8. Operations

- `taac2026 loop status --plan-id <id>` — local view.
- `taac2026 loop kill   --plan-id <id>` — touches both local
  `taiji-output/state/loops/<id>/KILL` **and** remote
  `~/taac-runs/<id>/KILL`. The remote `run.sh` contract requires checking
  this file every ≥10 s; auto-loop also checks it between iters.
- `taac2026 loop resume --plan-id <id>` — clears both KILLs and advances
  the state machine from `paused → queued`.

## 9. Password-only fallback (M5.5, 没有 SSH key 管理界面时)

部分 GPU 租赁平台（如 Compshare）**不提供** SSH 公钥管理界面，且每次实例都
是临时容器（几天就退）。这种场景把 ed25519 key 推到容器里没意义（容器一关
key 就没了），不如直接用密码登录。但密码**绝对不能**进 git 或上传到 GPU。

M5.5 的设计：

```
你的本机 ($HOME/.taac2026/host-passwords/<alias>, chmod 600)
    │
    │  taac2026 hosts set-password --alias <alias>
    ▼
本机 OpenSSH ─── via SSH_ASKPASS=_askpass.{cmd,sh} ───► 远端 sshd
    │                                                       ▲
    │  taac2026 loop run (远端 runner 调度)                │
    └──────────────── ssh / scp / rsync ────────────────────┘
```

密码**只**在本机存在，**永远**不进入：

- argv（`ps`/`tasklist` 看不到，因为我们不用 sshpass）
- 环境变量（除了一个 `TAAC2026_HOST_ALIAS=<alias>` 标记，本身不含密码）
- TAAC2026-Agent-pro 仓库或 git 历史
- taiji-output/（被 .gitignore 屏蔽，且密码也不存这里）
- 任何 scp/rsync 上行流量

### 步骤

1. **本机存密码**（一次，交互式或 AI 调用）：
   ```bash
   # 交互式（隐藏输入）
   taac2026 hosts set-password --alias taac2026-gpu

   # 自动化（推荐 AI 用）
   taac2026 hosts set-password --alias taac2026-gpu --password "your-password-here"

   # 从 stdin（适合 CI 拿密钥管理服务密码后管道传入）
   echo "your-password-here" | taac2026 hosts set-password --alias taac2026-gpu --from-stdin
   ```

   文件落到 `$HOME/.taac2026/host-passwords/taac2026-gpu`（chmod 600）。

2. **本机加 alias 到允许列表**：
   ```bash
   taac2026 hosts allow --alias taac2026-gpu
   ```

3. **本机 `~/.ssh/config` 简化版**（不需要 IdentityFile）：
   ```sshconfig
   Host taac2026-gpu
       HostName 117.50.48.78
       Port 22
       User root
       PreferredAuthentications password
       PubkeyAuthentication no
       StrictHostKeyChecking accept-new
       UserKnownHostsFile ~/.ssh/known_hosts_taac2026
   ```

   `PubkeyAuthentication no` 让 ssh 不浪费时间试 key；`UserKnownHostsFile`
   单独存一份，避免和你已有的 known_hosts 混淆。

4. **初始化 loop 时声明 password 模式**：
   ```bash
   taac2026 loop init --plan-id plan-001 \
     --remote-host taac2026-gpu \
     --remote-auth password
   ```

   这会在 `taac-loop.yaml` 里写 `loop.remote_auth: password`。

5. **跑**（其它跟 key 模式一样）：
   ```bash
   taac2026 review issue --kind train --plan-id plan-001 --approver alice --execute --yes
   taac2026 loop run    --plan-id plan-001 --execute --yes
   ```

   `RemoteRunner` 会自动设 `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force`/
   `TAAC2026_HOST_ALIAS=taac2026-gpu`，OpenSSH 调用 askpass helper，
   helper 读你本机 `~/.taac2026/host-passwords/taac2026-gpu` 文件，把密码
   送给 ssh。整个过程**不**用 sshpass、**不**经过环境变量、**不**进 argv。

### 限制

- 这个模式适合**临时**场景（几天租用、没 key 管理）。**长期**生产环境仍建议
  用 ed25519 key（`--remote-auth key` 是默认值）。
- Windows 原生 OpenSSH 对 `SSH_ASKPASS_REQUIRE=force` 在 8.1 之前不支持；
  2020 年后的 Windows 11 / Win10 21H1+ 都自带 OpenSSH ≥ 8.1，所以一般 OK。
  如果你的 ssh 版本特别老，跑 `ssh -V` 看到 `< 8.1` 时升级 OpenSSH。
- 容器重启后远端环境会重置（但 `~/.taac2026/host-passwords/` 是**本机**的，
  不受影响——你只需要确认新容器的 IP/端口仍能映射回这个 alias）。

## 10. What to do if your remote becomes untrusted

If you suspect the GPU host or its credentials have been compromised:

1. `taac2026 loop kill --plan-id <id>` for every active plan.
2. Remove the alias from `taiji-output/state/allowed-hosts.txt`.
3. Rotate the local key (delete + regen + reupload).
4. Inspect `taiji-output/state/events.ndjson` for the affected plan to
   see what auto-loop actually did.
