FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    xvfb xauth libnss3 libgtk-3-0t64 libgbm1 libasound2t64 libxss1 libxtst6 libatk-bridge2.0-0t64 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2t64 libpango-1.0-0 libcairo2 \
    fonts-dejavu-core ca-certificates dbus-x11 && rm -rf /var/lib/apt/lists/*
# Electron 44.10.1 with its setuid sandbox helper, so Chromium's OS sandbox runs as in a release.
COPY electron /opt/electron
RUN chmod -R a+rX /opt/electron && chown root:root /opt/electron/chrome-sandbox && chmod 4755 /opt/electron/chrome-sandbox
USER ubuntu
