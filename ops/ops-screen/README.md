# Ops screen

Lets an operator re-login a channel (Meituan, Guanyi, …) from a phone: open a
URL, tap the channel, log in on a headed Chrome rendered onto the box's own
virtual display. No laptop, no Node/Playwright install, no scp.

Built 2026-08-25 after a Guanyi outage where re-login took ~40 minutes,
almost all of it installing tooling on a laptop. See PR #75.

## The pieces (all pm2, none of them write to the database)

| Process | What it is |
|---|---|
| `xvfb` | `Xvfb :99` — a virtual display. Every channel Chrome, plus the login scripts launched from here, renders onto it. |
| `ops-screen-vnc` | `x11vnc -display :99` — serves that display as VNC on `127.0.0.1:5900`, gated by its own VNC password (`/root/.vnc/passwd`, set via `x11vnc -storepasswd`). |
| `ops-screen-web` | `websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900` — bridges VNC to a browser-usable WebSocket + serves the noVNC static UI. |
| `ops-screen-ctl` | **`login-trigger.js`, deployed from this directory** — the control page with the "tap a channel" buttons, on `127.0.0.1:6090`. See below. |

Nothing here is reachable except through nginx (all four bind to
`127.0.0.1`), and nginx gates the lot behind HTTP basic auth
(`/etc/nginx/auth/ops-screen.htpasswd`) plus a `$host` check restricting it to
`system.rootskitchenchina.com`.

## Deploying `login-trigger.js`

This file does **not** run from the repo tree — copy it out:

```bash
scp ops/ops-screen/login-trigger.js root@<box>:/opt/ops-screen/login-trigger.js
pm2 restart ops-screen-ctl
```

Adding a channel is one entry in its `JOBS` map: the script must be a headed
Playwright login that self-closes and writes its own session file (same shape
as `scripts/guanyi-login.js` / `scripts/meituan-login.js`).

## The nginx block (NOT in this repo — lives only on the box)

`/etc/nginx/sites-available/roots-v2`, inside the
`system.rootskitchenchina.com` server block. Four `location`s, in this order
in the file (though `=` exact matches win regardless of order):

```nginx
    location /ops-screen/ctl/ {
        if ($host != "system.rootskitchenchina.com") { return 404; }
        auth_basic "Ops Screen";
        auth_basic_user_file /etc/nginx/auth/ops-screen.htpasswd;
        proxy_pass http://127.0.0.1:6090/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }

    location /ops-screen/ {
        if ($host != "system.rootskitchenchina.com") { return 404; }
        auth_basic "Ops Screen";
        auth_basic_user_file /etc/nginx/auth/ops-screen.htpasswd;
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }

    # WebSocket for noVNC. Basic auth cannot ride a WebSocket handshake from a
    # phone browser, which is why /ops-screen/ above 401s a WS upgrade and
    # noVNC reports "Failed to connect to server" with nothing logged by
    # websockify at all. Exact match, so this can never widen to cover
    # anything else under /ops-screen/. x11vnc's own VNC password is what
    # actually gates the screen once the socket connects.
    location = /ops-screen/websockify {
        if ($host != "system.rootskitchenchina.com") { return 404; }
        proxy_pass http://127.0.0.1:6080/websockify;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }

    # Same as above, but at the BARE path. noVNC's default "path" setting is
    # relative to the domain root, not to wherever vnc.html itself is served
    # from — so the real browser request is /websockify with no /ops-screen/
    # prefix at all (confirmed from the access log: "GET /websockify HTTP/1.1"
    # falling through to the main Node app's 302, which a WS handshake cannot
    # follow). Confirmed nothing else in the app uses this path.
    location = /websockify {
        if ($host != "system.rootskitchenchina.com") { return 404; }
        proxy_pass http://127.0.0.1:6080/websockify;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
```

**Both `websockify` locations are required.** Only having the
`/ops-screen/websockify` one — the "obviously correct" one to a first pass —
is exactly what shipped originally and silently didn't work: nobody noticed
because nobody needed the screen from a phone until an actual outage forced
it, at which point every request 401'd on the WebSocket upgrade (before this
fix existed at all) and then, once basic auth was scoped correctly, still
404'd because noVNC never once requested the path anyone would have guessed.

If this box is ever rebuilt or this config regenerated from a template,
reproduce all four blocks — the access log (`GET /websockify` vs
`GET /ops-screen/websockify`) is the fastest way to tell whether a given
noVNC build wants the prefixed or the bare path; add whichever is missing.

## Troubleshooting

- **Tapped a channel, no window appears, page still says success** — check
  `/root/.pm2/logs/ops-screen-login.log` (the login script's own stdout/stderr,
  since the control page can only report that the process *started*, not that
  it stayed up). A wrong Node interpreter, a missing dependency, or the script
  crashing all land there.
- **"Failed to connect to server" in noVNC** — first rule out nginx entirely:
  `x11vnc` and `websockify` on their own ports, from the box itself:
  ```bash
  timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; head -c 12 <&3'; echo   # want: RFB 003.008
  ```
  If that's fine, `tail -f /var/log/nginx/access.log` on the box while
  tapping Connect on the phone is the fastest way to see the REAL request
  noVNC made — do not trust `curl` to simulate this; curl cannot speak the
  WebSocket-over-HTTP/2 upgrade a real browser may attempt, and testing with
  it produced a misleading result during this exact debugging session.
- **VNC connects but asks for a password nginx auth didn't already cover** —
  that's `x11vnc`'s own separate VNC password, intentional (the WebSocket
  path has no basic auth on it, so this is the one real gate once the socket
  connects). Reset it with `x11vnc -storepasswd` if it's lost; the running
  process picks up the new one immediately, no restart needed.
