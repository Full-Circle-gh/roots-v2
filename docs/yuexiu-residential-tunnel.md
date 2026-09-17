# Yuexiu's own residential exit — provisioning runbook

**2026-09-17.** The code side is done and shipped dark: `lib/proxy-manager.js`
reads `PROXY_RESIDENTIAL_YUEXIU` for the 越秀 / 闪购 channel and falls back to the
shared `PROXY_RESIDENTIAL` when it is unset. **Nothing changes until that line
exists in `.env`.** The decision behind it is §162 of
`docs/tacet-consolidation-decisions.md`; read it first, including the part that
is still open.

**One thing is not decided and this runbook does not decide it:** whether
Yuexiu's exit is a paid static residential IP or a second SSH tunnel. Both paths
are written out below. **Ash picks; a session does not.**

---

## What exists today, and what is being copied

| | Tianhe (外卖) | Yuexiu (闪购), today |
|---|---|---|
| exit | reverse SSH tunnel, SOCKS5 `127.0.0.1:1180` | **the same one** |
| sshd user | `tianheproxy` | **the same one** |
| transport | TCP/22 | TCP/22 |
| fallback | residential → GZ → direct | residential → GZ → direct *(this build)* |

The listener is owned by the `sshd` process itself — `ss -lntp`'s PID matched the
flap minute exactly on 2026-08-23. **When the session drops, the listener is not
degraded, it is gone.** Anything built on it must assume it can vanish and
return.

---

## Path A — a second SSH tunnel, the Tianhe pattern

Cheaper, already understood, and **inherits the session fragility wholesale**.
Two independent fragile tunnels still beat one shared fragile tunnel, because a
drop stops being both stores' drop.

### 1. On the server (the box the store dials out to)

Separate credentials, per the brief — **not** a second port under `tianheproxy`.
A shared account means one rotated key or one compromised box takes both stores.

```sh
# A no-shell, no-home account that can do nothing but hold a tunnel.
sudo useradd -r -M -d /nonexistent -s /usr/sbin/nologin yuexiuproxy
sudo mkdir -p /etc/ssh/authorized_keys.d
sudo touch /etc/ssh/authorized_keys.d/yuexiuproxy
sudo chmod 644 /etc/ssh/authorized_keys.d/yuexiuproxy
```

Append to `/etc/ssh/sshd_config` — **mirror however `tianheproxy` is already
configured; read that block before writing this one**, and match it rather than
this sketch if they differ:

```
Match User yuexiuproxy
    AuthorizedKeysFile /etc/ssh/authorized_keys.d/yuexiuproxy
    AllowTcpForwarding yes
    PermitTTY no
    X11Forwarding no
    ForceCommand /usr/sbin/nologin
    PermitOpen none
```

`GatewayPorts` stays **off**: the listener must be on `127.0.0.1` only. A
`0.0.0.0` bind puts an open SOCKS5 proxy on the public internet.

Then `sudo sshd -t` (**this must pass before the reload — a bad config here locks
everyone out**), `sudo systemctl reload sshd`, and confirm the existing tunnel
survived: `ss -lntp | grep 1180`.

### 2. On the Yuexiu store box

Generate a **new** keypair — do not copy Tianhe's:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/yuexiu_tunnel -C "yuexiu-residential-tunnel" -N ""
```

Put the public half in `/etc/ssh/authorized_keys.d/yuexiuproxy` on the server.

`autossh` under systemd, so it comes back after a reboot and after a drop:

```ini
# /etc/systemd/system/yuexiu-tunnel.service
[Unit]
Description=Yuexiu residential SOCKS5 tunnel
After=network-online.target
Wants=network-online.target

[Service]
User=tacet
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes \
  -i /home/tacet/.ssh/yuexiu_tunnel \
  -R 127.0.0.1:1181:127.0.0.1:1080 \
  yuexiuproxy@<SERVER_HOST>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**`1181`, not `1180`.** That is the whole separation; reusing `1180` silently
gives the second tunnel nowhere to bind and `ExitOnForwardFailure=yes` will
correctly refuse to start. **`1080` is the SOCKS5 server on the store box** —
whatever Tianhe's box runs (`danted`, `microsocks`, the equivalent), run the same
thing here.

### 3. Wire it up

```
PROXY_RESIDENTIAL_YUEXIU=socks5://127.0.0.1:1181
```

---

## Path B — a paid static residential IP

More money, and it **removes** the failure mode Path A inherits: no session, no
listener to lose, so a blip degrades the link instead of deleting the proxy.

There is nothing to provision on either box. One line:

```
# authed HTTP upstream
PROXY_RESIDENTIAL_YUEXIU=http://user:pass@host:port
# or SOCKS5, if that is what the provider hands you
PROXY_RESIDENTIAL_YUEXIU=socks5://host:port
```

Two things to check when choosing a provider, both of which the code cannot
check for you:

- **The exit must be in Guangdong.** A residential IP in the wrong province is a
  country change with extra steps. The point of this rung is that the store
  looks like it is where it is.
- **It must be a STATIC assignment, not a rotating pool.** A pool changes the
  store's IP every few minutes, which is the flap this build exists to stop,
  arriving from the other direction.

**An authed HTTP upstream needs no extra work on the 闪购 side** —
`scripts/shangou-chrome.js` already runs a local auth-injecting forwarder for
exactly this shape, because Chrome's `--proxy-server` cannot supply BasicAuth.
That path is live today for the GZ proxy.

---

## Verifying, either path

Confirm the exit before pointing a daemon at it — from the server, the way the
health probe does:

```sh
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 \
  -x socks5h://127.0.0.1:1181 https://e.waimai.meituan.com/
```

**Any 2xx–5xx is a pass.** `302` is the expected answer — the probe carries no
cookies and the merchant portal redirects to login — and `403` means the exit
works and risk control is holding it. **Only `000` is down.** If you tighten this
ruler, tighten `lib/proxy-manager.js` and the channel daemons in the same commit;
demanding a bare `200` is the bug that pinned 天河 to 直连.

Check the IP is the one you think it is:

```sh
curl -s --max-time 10 -x socks5h://127.0.0.1:1181 https://api.ipify.org; echo
```

Then restart the watchdog and read its opening lines — it now prints one per
channel and marks each `dedicated` or `shared`:

```
[proxy-watchdog] tianhe: residential=socks5://127.0.0.1:1180 (shared)
[proxy-watchdog] yuexiu: residential=socks5://127.0.0.1:1181 (dedicated)
```

**`yuexiu: … (shared)` means the variable did not take and the stores are still
coupled.** That line is the check; do not conclude it worked from the absence of
errors.

---

## What this does not fix

**The watchdog's hysteresis is one-sided** — two consecutive failures to go DOWN,
but UP on the **first** success — and the browser holders have no relaunch
debounce at all. A marginal tunnel oscillates, and each transition relaunches a
browser. **This build halves what one flap costs, because only one channel now
moves. It does not stop a marginal tunnel oscillating.** Known issue, recorded in
§162 and in the 2026-08-23 entries, deliberately out of scope.
