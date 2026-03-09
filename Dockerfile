FROM node:20-alpine AS runtime
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY_FALLBACK=https://registry.npmjs.org/
ENV NODE_ENV=production
ENV HOME=/tmp/home \
    NPM_CONFIG_USERCONFIG=/tmp/npmrc-public \
    NPM_CONFIG_GLOBALCONFIG=/tmp/npmrc-global \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_ALWAYS_AUTH=false \
    NPM_CONFIG_NETWORK_CONCURRENCY=1 \
    NPM_CONFIG_IPV6=false \
    NODE_OPTIONS=--dns-result-order=ipv4first

COPY package.json ./
RUN set -eu; \
    mkdir -p "${HOME}"; \
    rm -f /root/.npmrc "${HOME}/.npmrc"; \
    install_ok=0; \
    for registry in "${NPM_REGISTRY}" "${NPM_REGISTRY_FALLBACK}"; do \
      if [ -z "${registry}" ]; then \
        continue; \
      fi; \
      echo "Trying npm registry: ${registry}"; \
      printf '%s\n' \
        "registry=${registry}" \
        "@modelcontextprotocol:registry=${registry}" \
        'always-auth=false' > "${NPM_CONFIG_USERCONFIG}"; \
      printf '%s\n' \
        "registry=${registry}" \
        'always-auth=false' > "${NPM_CONFIG_GLOBALCONFIG}"; \
      if ! timeout 12s npm ping --registry="${registry}" --fetch-retries=0 --fetch-timeout=10000 --loglevel=warn >/dev/null 2>&1; then \
        echo "Registry ${registry} is unreachable, switching..."; \
        continue; \
      fi; \
      if npm install --omit=dev --no-audit --no-fund --prefer-online --ignore-scripts --progress=false --loglevel=warn \
        --registry="${registry}" \
        --fetch-retries=2 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=15000 \
        --fetch-timeout=60000; then \
        install_ok=1; \
        break; \
      fi; \
      echo "npm install failed via ${registry}, retrying with next registry..."; \
      rm -rf node_modules package-lock.json; \
    done; \
    if [ "${install_ok}" -ne 1 ]; then \
      echo "npm install failed with all configured registries"; \
      exit 1; \
    fi

COPY dist ./dist
COPY demo_project ./demo_project
COPY .env.example ./.env.example

EXPOSE 8000
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
