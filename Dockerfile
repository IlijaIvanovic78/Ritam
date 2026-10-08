# Ritam — jedan kontejner: Node server (Hono + node:sqlite) servira API i build weba.
#   docker compose up -d --build

# ---- 1. Build weba (Vite → dist/web) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 2. Runtime: samo produkcione zavisnosti ----
FROM node:24-alpine AS runtime
# tzdata da bi TZ (npr. Europe/Belgrade) važio i za alate u kontejneru.
RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/web ./dist/web
COPY server ./server
COPY shared ./shared
# Baza živi u /data; vlasnik je neprivilegovani korisnik "node" (prazan imenovani volumen preuzima vlasnika).
# Volumen se kači spolja (compose: ritam-data, Railway: Volume na /data). Namerno bez VOLUME instrukcije:
# Railway je ne dozvoljava, a `docker run` bez -v bi pravio anonimni volumen sa kopijom baze.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
