#!/usr/bin/env bash
set -euo pipefail

: "${WEB_USER:?WEB_USER is required}"
: "${CONTAINER_WORKSPACE:?CONTAINER_WORKSPACE is required}"
: "${CODEX_VERSION:?CODEX_VERSION is required}"
: "${WETTY_PORT:?WETTY_PORT is required}"
: "${SETUP_ENABLED:?SETUP_ENABLED is required}"
: "${SETUP_PORT:?SETUP_PORT is required}"
: "${DOTFILES_SKIP_APT:?DOTFILES_SKIP_APT is required}"
: "${SETUP_ALLOW_KEY_PERSISTENCE:?SETUP_ALLOW_KEY_PERSISTENCE is required}"
: "${SETUP_COMMAND_TIMEOUT_MS:?SETUP_COMMAND_TIMEOUT_MS is required}"
: "${TERMINAL_BACKEND:?TERMINAL_BACKEND is required}"
: "${GHOSTTY_ALLOWED_HOSTS:?GHOSTTY_ALLOWED_HOSTS is required}"

if ! id -u "$WEB_USER" >/dev/null 2>&1; then
  useradd -m -s /usr/bin/zsh "$WEB_USER"
fi
usermod -s /usr/bin/zsh "$WEB_USER"
install -d -o "$WEB_USER" -g "$WEB_USER" "$CONTAINER_WORKSPACE"
usermod -aG sudo "$WEB_USER"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$WEB_USER" >/etc/sudoers.d/incus-web-user
chmod 440 /etc/sudoers.d/incus-web-user
install -d -o "$WEB_USER" -g "$WEB_USER" "/home/$WEB_USER/.local/bin" "/home/$WEB_USER/.cargo"

if [[ ! -e "/home/$WEB_USER/.local/bin/env" ]]; then
  cat >"/home/$WEB_USER/.local/bin/env" <<'EOF'
if (return 0 2>/dev/null); then
  return 0
fi
exec /usr/bin/env "$@"
EOF
  chown "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.local/bin/env"
  chmod 755 "/home/$WEB_USER/.local/bin/env"
fi

if [[ ! -e "/home/$WEB_USER/.cargo/env" ]]; then
  cat >"/home/$WEB_USER/.cargo/env" <<'EOF'
if (return 0 2>/dev/null); then
  return 0
fi
exit 0
EOF
  chown "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.cargo/env"
  chmod 644 "/home/$WEB_USER/.cargo/env"
fi

chmod 755 /usr/local/bin/incus-web-open
ln -sf /usr/local/bin/incus-web-open /usr/local/bin/xdg-open
ln -sf /usr/local/bin/incus-web-open /usr/local/bin/sensible-browser
ln -sf /usr/local/bin/incus-web-open /usr/local/bin/www-browser
cat >/etc/profile.d/incus-web-browser.sh <<EOF
export BROWSER=/usr/local/bin/incus-web-open
export INCUS_WEB_WORKSPACE_LABEL=$(printf '%q' "${INCUS_WEB_WORKSPACE_LABEL:-}")
EOF

cat >/usr/local/bin/agent-env <<EOF
#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/$WEB_USER
export USER=$WEB_USER
export LOGNAME=$WEB_USER
export BROWSER=/usr/local/bin/incus-web-open
export INCUS_WEB_WORKSPACE_LABEL=$(printf '%q' "${INCUS_WEB_WORKSPACE_LABEL:-}")
export PATH="/usr/local/bin:/usr/bin:/bin:\$HOME/.local/bin:\$PATH"

cd $(printf '%q' "$CONTAINER_WORKSPACE") 2>/dev/null || cd "\$HOME"
exec "\$@"
EOF
chmod 755 /usr/local/bin/agent-env

if ! grep -q '/usr/local/bin' "/home/$WEB_USER/.bashrc" 2>/dev/null; then
  cat >>"/home/$WEB_USER/.bashrc" <<EOF

export PATH="\$HOME/.local/bin:/usr/local/bin:\$PATH"
export BROWSER=/usr/local/bin/incus-web-open
cd $(printf '%q' "$CONTAINER_WORKSPACE") 2>/dev/null || true
EOF
fi
if ! grep -q 'incus-web-info' "/home/$WEB_USER/.bashrc" 2>/dev/null; then
  cat >>"/home/$WEB_USER/.bashrc" <<'EOF'

if [ -t 1 ]; then
  export INCUS_WEB_INFO_SHOWN=1
  /usr/local/bin/incus-web-info 2>/dev/null || true
fi
EOF
fi
chown "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.bashrc"

if ! grep -q '/usr/local/bin' "/home/$WEB_USER/.zshrc" 2>/dev/null; then
  cat >>"/home/$WEB_USER/.zshrc" <<EOF

export PATH="\$HOME/.local/bin:/usr/local/bin:\$PATH"
export BROWSER=/usr/local/bin/incus-web-open
cd $(printf '%q' "$CONTAINER_WORKSPACE") 2>/dev/null || true
EOF
fi
if ! grep -q 'incus-web-info' "/home/$WEB_USER/.zshrc" 2>/dev/null; then
  cat >>"/home/$WEB_USER/.zshrc" <<'EOF'

if [[ -o interactive ]]; then
  export INCUS_WEB_INFO_SHOWN=1
  /usr/local/bin/incus-web-info 2>/dev/null || true
fi
EOF
fi
chown "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.zshrc"

incus_web_zlogin_line="$(grep -n '/usr/local/bin/incus-web-info' /etc/zsh/zlogin 2>/dev/null | head -n 1 | cut -d: -f1 || true)"
if [[ -n "$incus_web_zlogin_line" ]]; then
  keep_lines=$((incus_web_zlogin_line - 3))
  tmp_zlogin="$(mktemp)"
  head -n "$keep_lines" /etc/zsh/zlogin >"$tmp_zlogin"
  cat "$tmp_zlogin" >/etc/zsh/zlogin
  rm -f "$tmp_zlogin"
fi
incus_web_info_line="$(grep -n '^incus_web_info_precmd()' /etc/zsh/zshrc 2>/dev/null | head -n 1 | cut -d: -f1 || true)"
if [[ -n "$incus_web_info_line" ]]; then
  keep_lines=$((incus_web_info_line - 3))
  tmp_zshrc="$(mktemp)"
  head -n "$keep_lines" /etc/zsh/zshrc >"$tmp_zshrc"
  cat "$tmp_zshrc" >/etc/zsh/zshrc
  rm -f "$tmp_zshrc"
fi
if ! grep -q 'incus_web_info_precmd' /etc/zsh/zshrc 2>/dev/null; then
  cat >>/etc/zsh/zshrc <<'EOF'

export BROWSER=/usr/local/bin/incus-web-open
autoload -Uz add-zsh-hook 2>/dev/null || true
incus_web_info_precmd() {
  if [[ "${INCUS_WEB_INFO_SHOWN:-0}" != "1" && -t 1 ]]; then
    /usr/local/bin/incus-web-info 2>/dev/null || true
    export INCUS_WEB_INFO_SHOWN=1
  fi
}
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook precmd incus_web_info_precmd
else
  incus_web_info_precmd
fi
EOF
fi

if ! runuser -u "$WEB_USER" -- bash -lc 'command -v codex >/dev/null 2>&1'; then
  npm install -g "@openai/codex@$CODEX_VERSION"
fi

install -d -m 755 /etc/default
cat >/etc/default/tailscaled <<'EOF'
PORT="41641"
FLAGS="--tun=userspace-networking"
EOF

cat >/etc/systemd/system/wetty.service <<EOF
[Unit]
Description=WeTTY browser terminal
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=/home/$WEB_USER
Environment=BROWSER=/usr/local/bin/incus-web-open
Environment=INCUS_WEB_WORKSPACE_LABEL=$(printf '%q' "${INCUS_WEB_WORKSPACE_LABEL:-}")
ExecStart=/usr/local/bin/wetty --host 127.0.0.1 --port $WETTY_PORT --base / --command 'runuser -u $WEB_USER -- /usr/bin/zsh -l'
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
if [[ "$SETUP_ENABLED" == "1" ]]; then
  cat >/etc/systemd/system/incus-web-setup.service <<EOF
[Unit]
Description=incus-web dotfiles setup
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOST=127.0.0.1
Environment=PORT=$SETUP_PORT
Environment=WEB_USER=$WEB_USER
Environment=DOTFILES_SKIP_APT=$DOTFILES_SKIP_APT
Environment=SETUP_ALLOWED_EMAILS=$(printf '%q' "${SETUP_ALLOWED_EMAILS:-}")
Environment=SETUP_ALLOW_KEY_PERSISTENCE=$SETUP_ALLOW_KEY_PERSISTENCE
Environment=SETUP_COMMAND_TIMEOUT_MS=$SETUP_COMMAND_TIMEOUT_MS
ExecStart=/usr/local/bin/incus-web-bootstrap-server
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable incus-web-setup
  systemctl restart incus-web-setup
else
  systemctl disable --now incus-web-setup >/dev/null 2>&1 || true
fi

if [[ "$TERMINAL_BACKEND" == "ghostty-web" ]]; then
  cat >/etc/systemd/system/ghostty-web.service <<EOF
[Unit]
Description=Ghostty web terminal
After=network-online.target
Wants=network-online.target

[Service]
User=$WEB_USER
WorkingDirectory=$CONTAINER_WORKSPACE
Environment=HOME=/home/$WEB_USER
Environment=SHELL=/usr/bin/zsh
Environment=BROWSER=/usr/local/bin/incus-web-open
Environment=INCUS_WEB_WORKSPACE_LABEL=$(printf '%q' "${INCUS_WEB_WORKSPACE_LABEL:-}")
Environment=HOST=127.0.0.1
Environment=PORT=$WETTY_PORT
Environment=GHOSTTY_ALLOWED_HOSTS=$GHOSTTY_ALLOWED_HOSTS
ExecStart=/usr/local/bin/ghostty-web-demo
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl disable --now wetty >/dev/null 2>&1 || true
  systemctl stop wetty >/dev/null 2>&1 || true
  systemctl reset-failed wetty >/dev/null 2>&1 || true
  systemctl mask --force wetty >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl enable ghostty-web
  systemctl restart ghostty-web
else
  systemctl unmask wetty >/dev/null 2>&1 || true
  systemctl disable --now ghostty-web >/dev/null 2>&1 || true
  systemctl enable wetty
  systemctl restart wetty
fi
